# 多项目支持集成验证记录（T14：CDP + 真实迁移实测）

> 日期：2026-10-31
> 环境：dev 模式（vite 5173 + electron --remote-debugging-port=9222），分支 feature/multi-project-support（f7808ba）
> 测试数据：**用户真实存量 userData**（白朗县光储 EPC 项目，全局库 4.9MB / workspace 621.5MB / 1424 文件）
> 前置安全：打包版 4 进程已优雅关闭；完整备份 `%APPDATA%\yibiao-client.bak-multi-20261031-182916`（621.5MB，事后核对完好未动）
>
> **⚠️ 本文下半部「第二轮（修复后）」为最终状态**：迁移修复（81e9c24）后真实迁移全链路通过、11 项清单执行完毕（8 PASS / 1 FAIL / 1 环境阻断 / 1 部分替代），下列第一轮 BLOCKED 结论已被取代，保留作根因取证记录。

## 第一轮结论：BLOCKED —— 真实存量迁移在 drop-tables 步骤确定性失败，11 项 CDP 场景全部无法执行

- Step 1 单测：**16/16 全绿**（projectKeys 3 + electron-as-node 13）
- Step 2 真实迁移：**FAIL**（backup / copy-tables / move-dirs / move-agent-sessions 四步全部正确完成且数据 100% 对齐，仅最后 drop-tables 步抛 `SqliteError: no such table: main.duplicate_check_files`，事务回滚）
- Step 3 十一项场景：**NOT RUN**（应用停在"本地数据库初始化失败"错误页，所有 workspace IPC 不可用）
- 纪律执行：未改任何代码；用户数据已完整还原至验证前状态；半迁移现场已隔离保存供修复任务取证

## FAIL 详情与根因（已 A/B 复现实锤）

### 现象

主进程日志（D:\Neo\Neo\tmp\yibiao-dev-electron.log）：

```
[ipc] 工作区数据库初始化失败 SqliteError: no such table: main.duplicate_check_files
    at projectMigration.cjs:130:95   ← drop-tables 步骤
    at runLegacyMigration (projectMigration.cjs:131)
    at registerWorkspaceDatabaseServices (ipc/index.cjs:301)
```

渲染层展示（CDP 取证 + 截图 D:\Neo\Neo\tmp\yibiao-verify\error-state.png）：

```
本地工作区
本地数据库初始化失败：no such table: main.duplicate_check_files
请重启应用重试；如果仍然失败，请联系技术支持并保留错误信息。
```

journal 状态（%APPDATA%\yibiao-client\workspace\projects\.legacy-migration.json）：

```json
{ "status": "migrating", "projectId": "20261031-zx65sr",
  "doneSteps": ["backup", "copy-tables", "move-dirs", "move-agent-sessions"],
  "failCount": 1 }
```

### 根因（在备份副本上复现，A/B 对照）

1. 真实全局库 schema 存在外键：`duplicate_check_outline_items.file_id REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE`（查重域还有多张类似 FK 子表）。
2. 全局库连接 `foreign_keys = ON`——sqliteDatabase.cjs:1949 对全局库显式开启（且实测本版 better-sqlite3 裸开连接 FK 即默认 ON）。
3. THREE_DOMAIN_TABLES 按清单顺序 DROP：先 DROP 父表 `duplicate_check_files` 成功，随后 DROP 子表 `duplicate_check_outline_items` 时，SQLite 的 FK drop 处理需引用已在本事务内删除的父表 → 报 `no such table: main.duplicate_check_files`，整个 DROP 事务回滚（全局库无损）。

A/B 证据（D:\Neo\Neo\tmp\yibiao-repro\repro-fk-off.cjs，对备份副本逐条执行同序 DROP）：

| 条件 | 结果 |
|---|---|
| `foreign_keys = ON`（与 app 一致） | FAILED at duplicate_check_outline_items: no such table: main.duplicate_check_files |
| `foreign_keys = OFF` | 32 张三域表全部 DROP 成功（ALL OK） |

### 单测为何没拦住

test/projectMigration.test.cjs 的 `seedLegacyGlobalDb` 只建了 4 张简化代表表（technical_plan_meta / outline_nodes / duplicate_check_meta / rejection_check_meta），**无外键、也没有 duplicate_check_files / outline_items 等真实 FK 子表**，真实 schema 的 FK 图无法被 fixture 覆盖。

### 修复线索（供后续任务，本次未动代码）

- 方向 A：drop-tables 事务前 `PRAGMA foreign_keys = OFF`（该步骤语义是整域搬迁后的清场，无需 FK 约束；A/B 已验证 OFF 即全过）；
- 方向 B：按 FK 依赖拓扑序 DROP 子表先于父表；
- 修复后注意：journal 幂等续跑设计有效——当前现场 doneSteps=[4步]，重启会只补 drop-tables；但 failCount=1 已消耗，**再失败 2 次即触发 fatal 粘性**（fatal 路径只还原全局库文件、不回滚已搬目录，状态会更复杂）。修复任务应在受控副本上先验再碰真实数据。
- 复现材料：D:\Neo\Neo\tmp\yibiao-repro\（yibiao.sqlite 副本 + repro-drop / repro-fk-off / inspect-triggers / inspect-stat1 / inspect-live 脚本）

## 迁移前四步的正确性实证（虽 FAIL 但机制层已验证的部分）

| 检查项 | 结果 | 证据 |
|---|---|---|
| backup | ✅ | projects/.legacy-backup/yibiao.sqlite 存在（4,890,624 字节，与迁移前全局库逐字节同大小） |
| copy-tables | ✅ | 项目库 projects/20261031-zx65sr/project.sqlite 三域 32 表齐备，行数与迁移前快照**逐一相等**：technical_plan meta=1/outline_nodes=75/content_plans=55/content_sections=55/bid_items=18/generation_bid_tasks=18/generation_config=1/generation_reference_docs=1/global_fact_groups=18/tasks=4；duplicate_check_meta=1；rejection_check meta=1/documents=2/extraction=1 |
| move-dirs | ✅ | workspace/{technical-plan, duplicate-check, rejection-check, generated-images} 整体迁入项目目录；technical-plan 含 57 文件（55 节 docx + tender-files + tender-originals）；logs/technical-plan、agent-runtime/pi 同步迁入；旧路径 workspace/technical-plan 已不存在（搬移非复制，符合设计） |
| move-agent-sessions | ✅ | agent-runtime/pi 目录在项目目录内 |
| drop-tables | ❌ | 见上；但事务回滚干净——live 全局库（WAL 副本取证）三域表全部仍在 |
| registry | ✅ | 全局库 projects 表：id=20261031-zx65sr, name="导入的项目", name_source=ai, status=migrating |
| 错误路径 UX | ✅ | 渲染层显示明确错误页（非白屏、非崩溃），提示重启/联系支持 |
| journal 断点续跑机制 | ✅（间接） | failCount=1 落盘、status=migrating 保持、doneSteps 记录正确，与 T8 设计一致（未实际重启验证续跑，避免消耗 failCount） |

附注：registry.name 为「导入的项目」而非老项目名——因真实数据 technical_plan_meta.outline_project_name 为 NULL，走了 `meta?.outline_project_name || '导入的项目'` fallback。属代码设计内行为，但「名字=原 outline_project_name」的预期在真实数据上表现为 fallback 值，产品侧需确认老项目显示名是否要改用 tender_file_name 等更友好的来源。

## 11 项 CDP 场景清单：全部 NOT RUN

| # | 场景 | 结果 | 说明 |
|---|---|---|---|
| 1 | 新建项目 B | ⛔ 未执行 | 应用未能完成启动 |
| 2 | 切回 A 数据隔离 | ⛔ 未执行 | 同上 |
| 3 | 双项目并行任务 | ⛔ 未执行 | 同上 |
| 4 | 切走不中断 | ⛔ 未执行 | 同上 |
| 5 | 顶栏角标 | ⛔ 未执行 | 同上 |
| 6 | 任务互斥语义 | ⛔ 未执行 | 同上 |
| 7 | AI 项目名回写 | ⛔ 未执行 | 同上 |
| 8 | 删除项目 | ⛔ 未执行 | 同上 |
| 9 | 重启恢复 | ⛔ 未执行 | 刻意不执行：重启会消耗迁移 failCount（1→2），再失败即触发 fatal 粘性，风险用户数据 |
| 10 | 导出 | ⛔ 未执行 | 应用未能完成启动 |
| 11 | 图片资产 | ⛔ 未执行 | 同上 |

## 用户数据处置（安全闭环）

1. 验证前完整备份 → `%APPDATA%\yibiao-client.bak-multi-20261031-182916`（621.5MB / 1424 文件，全程未动，事后核对完好）
2. 半迁移现场整体隔离保存 → `D:\Neo\Neo\tmp\yibiao-halfmigrated-quarantine-20261031`（含 journal、已迁项目目录，供修复任务取证）
3. live userData 从备份还原 → 平铺结构回归（workspace/technical-plan 复位、projects/ 目录不存在、yibiao.sqlite 4,890,624 字节），关键表行数与迁移前快照逐一复核相等（outline_nodes=75 / content_sections=55 / knowledge_blocks=991 / task_logs=89 …）
4. dev 进程（vite/electron）全部关闭，打包版易标未重新拉起（由用户自行启动）

## 环境备注

- 打包版（D:\Yibiao，旧代码）4 个进程在验证前运行中，已 CloseMainWindow 优雅关闭——旧代码读全局三域表 + 旧路径，与半迁移状态不兼容，关闭顺序正确
- 日期说明：任务命名 2026-10-30，实际执行跨至 10-31 晚（进程 StartTime 10-30 11:31 为打包版上次启动时间）

---

# 第二轮（修复后）：真实迁移重跑 + 11 项 CDP 全清单

> 日期：2026-10-31 晚
> 分支：feature/multi-project-support @ 81e9c24（fix：FK OFF 事务外设置 + 项目名三级回退；副本验证 32/32 DROP 通过）
> 起点：live userData = 上轮从备份还原的干净迁移前平铺状态（无 projects/、无 journal）；备份 `%APPDATA%\yibiao-client.bak-multi-20261031-182916` 仍在且未动
> 方式：vite 5173 后台 + `ELECTRON_RENDERER_URL` + electron --remote-debugging-port=9222；CDP Runtime.evaluate 驱动 `window.yibiao.*` + 文件系统/SQLite 只读直查双管齐下；截图与中间产物存 `D:\Neo\Neo\tmp\yibiao-verify\`

## 结论：DONE_WITH_CONCERNS —— 真实迁移修复后全链路通过；11 项中 8 PASS、1 FAIL（项目删除功能断裂，代码级缺陷）、1 环境阻断、1 部分替代通过

## Step 1 单测回归：17/17 全绿

- projectKeys（node --test）：3/3
- projectMigration / projectRegistry / projectStoreRegistry（electron-as-node）：14/14（修复 commit 较上轮新增「项目名三级回退」1 项）
- 执行方式（上轮遗留问题的解法）：设环境变量 `ELECTRON_RUN_AS_NODE=1` 后 `electron.exe --test <files>`。注意两点：① 不能同时给 `--run-as-node` 标志（env 已进 node 模式，该标志会被 node 当 bad option 报错）；② 必须用 env 变量而非标志，因为 node --test 会 spawn 子进程（`process.execPath`），只有 env 能被子进程继承——只用标志时子进程起 GUI Electron 挂死（上轮坑的根因）
- 输出存档：`D:\Neo\Neo\tmp\yibiao-verify\unit-tests-r2.txt`

## Step 2 真实迁移重跑：PASS（上轮 BLOCKED 点全数通过）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 迁移完成日志 | ✅ | `[migration] 存量迁移完成 → 项目 20261031-bv1vsa`（electron-r2.log） |
| drop-tables（上轮 FAIL 点） | ✅ | 全局库 55 表 → 24 表，32 张三域表全部 DROP 成功，无 FK 报错 |
| journal | ✅ | status=done，doneSteps=[backup, copy-tables, move-dirs, move-agent-sessions, drop-tables] 全 5 步 |
| .legacy-backup | ✅ | yibiao.sqlite 4,890,624 字节（与迁移前逐字节同大小） |
| 项目目录结构 | ✅ | projects/20261031-bv1vsa/{project.sqlite, workspace/{technical-plan, duplicate-check, rejection-check, generated-images}, agent-runtime/pi, logs/technical-plan} |
| 三域数据 100% 对齐 | ✅ | 项目库行数与迁移前全局库快照逐一相等：meta=1 / outline_nodes=75 / content_plans=55 / content_sections=55 / bid_items=18 / generation_bid_tasks=18 / generation_config=1 / reference_docs=1 / global_fact_groups=18 / tasks=4；duplicate_check_meta=1；rejection_check meta=1/documents=2/extraction=1 |
| 全局域无损 | ✅ | knowledge_blocks=991 / task_logs=89 / export_templates=3 等不变 |
| 项目名三级回退（81e9c24 新逻辑） | ✅ | 真实数据 outline_project_name=NULL → 回退第 2 级：tender_files_json 首份文件名去扩展名 =「白朗县粤水电90兆瓦光储电站220千伏送出（场站侧）工程EPC总承包招标文件20261008(1)(1)」，name_source=ai，不再是「导入的项目」 |
| 老项目 UI 完整渲染 | ✅ | 迁移后直接进入 A 工作台：章节 57 / 小节 55 / 字数 5.3万 / 配图 2 张 / 招标文件 1 份（截图 r2-01-after-migration.png）；step=generation-settings；存量 paused 正文任务（584eb14f）原样保留 |

## Step 3：11 项 CDP 清单结果

| # | 场景 | 结果 | 说明 |
|---|---|---|---|
| 1 | 新建项目 B | ✅ PASS | createFromTenderFile（从 A 的 tender-originals 复制改名 docx）：name=文件名去扩展名（name_source=filename）、导入解析成功、主进程 setCurrent+emitActive 生效、目录结构齐备（project.sqlite + 三域 workspace）。完成后 UI 切入由渲染层组件流程（switchTo）完成——IPC 直调绕过了组件 glue，切换路径另行验证（场景 2/4 中 setActive 后 TechnicalPlanHome 正确按项目重挂载）。附观察项※1 |
| 2 | 切回 A 数据隔离 | ✅ PASS | A：75 目录节点 / A 的招标文件 / step 不变；B：STEP 01 空态。loadState 严格跟随当前项目 |
| 3 | 双项目并行任务 | ✅ PASS | B、C（第二个一次性测试项目，同文件新建）各自 startBidSectionExtraction 同组并行，getActiveTasks 双条目 running、project_id 分明 |
| 4 | 切走不中断 | ✅ PASS | B/C 任务运行中切到 A：两任务仍 running，进度不受切换影响 |
| 5 | 顶栏角标 | ✅ PASS | A 激活时角标「⚡ 2 个项目运行中」出现；展开菜单列出 B/C 各 1 任务（只列非当前项目，点击可切）；截图 r2-05-badge.png |
| 6 | 任务互斥语义 | ✅ PASS | 同项目：C 任务运行中再起「招标文件解析」被拒——「当前技术方案正在执行“多标段识别”，请完成后再启动“招标文件解析”」（slot key=projectId:type）；跨项目：B 同组任务照常放行并行 |
| 7 | AI 项目名回写 | ✅ PASS | 项目 D（一次性正向用例）：saveOutline（带真实 outline 节点 + project_name）→ 注册表名更新为 AI 名、name_source=ai；rename 手动改名 → manual；再次 saveOutline 不同 AI 名 → **不覆盖**（manual 保护生效）。⚠️ 校验注意：outline 为空数组的 saveOutline 走 saveOutlineData 早退分支（清目录 + 不触发回写）——设计行为非 bug，真实流程 AI 目录总有节点 |
| 8 | 删除项目 B | ❌ **FAIL（代码级缺陷）** | 弹窗部分正确：二次确认 + 「以下任务将被终止：多标段识别」（B 任务运行中）。但点「确认删除」后 `projects:remove` 必然抛错：`TypeError: taskService.cancelTechnicalPlanTasks is not a function`（projectsIpc.cjs:53）。根因：taskService 返回对象未导出 cancelTechnicalPlanTasks / cancelDuplicateCheckTasks / cancelRejectionCheckTasks（函数在 createTaskService 内部存在且自用，但不在 return 列表）→ **任何项目的删除功能全断**（与是否有运行中任务无关，第一行就抛）。失败无副作用：B 未删、A 完好。本轮测试项目 B/C/D 因此无法经应用内删除清理，收尾用等价手工清理（见现场处置） |
| 9 | 重启恢复 | ✅ PASS | 关 electron 重开（vite 不动）：activeProjectId 恢复为 A（last_project_id 持久化）；A 数据完整（75/55/18…）；A 存量 paused 正文任务保留 status=paused，日志含「一致性审计已暂停…继续后在同一会话接着处理」，恢复逻辑确认不自动续跑（recoverInterruptedContentGenerationTask 只对 running/pausing 生效置 paused，不烧 AI） |
| 10 | A 导出 docx | ⛔ **BLOCKED（环境，非多项目回归）** | 导出流程正确进入 A 项目数据读取并调用 openxmlhelper；dev 模式 ensureExecutable 无条件 `dotnet build`，而 openxmlhelper 工程目标框架 **net10.0**、本机仅 .NET SDK/Runtime **8.0.422** → NETSDK1045「当前 .NET SDK 不支持面向 .NET 10.0」，exportWord 报 Command failed: dotnet build。多项目侧无任何路由错误；打包版捆绑预编译 helper（extraResources）不走构建路径。修复路径（任选）：装 .NET 10 SDK / 降 target / dev 模式检测已构建产物跳过 build。另：保存对话框 UI 自动化期间一度误选已有文件触发「确认另存为」替换提示，已点「否」保护用户旧导出文件——无覆盖发生 |
| 11 | 图片资产 | ✅ PASS（按任务指引用小规模替代） | ① A 存量配图 UI 显示：「配图 2 张」卡片（r2-01 / r2-11a 截图）；② 物理文件：20 张原方案图片位于 A 项目 `agent-runtime/pi/tasks/20261031-bv1vsa_technical-plan-content-generation/workspace/图片/`（项目前缀键，随 move-agent-sessions 正确迁入，两次重启后完好——孤儿清理未误删）；③ **资产根按项目路由探针实锤**：向 A 的项目 generated-images 写入 1×1 探针 png，A 激活时 `yibiao-asset://generated-images/probe.png` img 加载成功（200），切到 B 激活后同一 URL 加载失败（探针不在 B 的项目根）——项目资产根隔离直接证明（注意同 URL 首次加载会被 Chromium 缓存，需 cache-buster + 反序加载排除假象）；④ A 库现状 html_output 无 img/yibiao-asset 引用（数据本身如此），“存量 URL 解析”由探针替代完成；⑤ B 生成 1 张 AI 配图未执行（需完整正文生成长任务，按指令替代）；A 重置验证不误删**不执行**（会破坏真实用户数据，超出验证安全边界）；⑥ 导出带图随场景 10 环境阻断。探针已清理 |

※1 观察项（未定性为缺陷）：IPC 直调 createFromTenderFile 返回后立即截屏，渲染层显示的是项目列表页而非新项目工作台（组件流程的 switchTo 未被直调触发所致）；随后所有 setActive 切换均正确渲染目标项目工作台。正常 UI 流（点「新建项目」→ 原生文件框 → 卡片 spinner → 完成切入）因原生文件对话框无法 CDP 驱动而未端到端走通，切换 glue 已由场景 2/4 覆盖。

### 本轮任务运行说明（AI 真调用）

B/C 的并行任务用的是用户真实 AI 配置（glm-5.3-flash @ bigmodel coding 端点）对标书分节提取的真实调用：启动→运行→AI 判定「未识别到至少两个有效标段」→ 每项目独立落 error 状态。业务结果为该招标文件（单标段 EPC）的合理判定，不影响任务机制层验证（并行/互斥/不中断/角标/按项目状态隔离全部按预期）。A 全程未启动任何任务（行数终检不变）。

## A 项目终检（全清单跑完后）

A 项目库行数与迁移前快照**逐一相等**（outline_nodes=75 / content_plans=55 / content_sections=55 / bid_items=18 / global_fact_groups=18 / tasks=4 / 查重 meta=1 / 废标 meta=1+documents=2+extraction=1）——包括两次删除失败尝试在内，全程零副作用。

## 现场处置（第二轮收尾）

1. dev 全关：electron 2 进程 + vite 均停止，端口 5173 释放，CDP 9222 关闭
2. 测试项目清理：因场景 8 删除功能断裂，B/C/D 无法经应用内删除；dev 关闭后用等价手工清理——全局库 projects 表置 status='deleted'（软删，与 registry.remove 同语义）+ 物理删除三个项目目录（与 removeProjectDir 同语义）。清理后 live 仅剩 A（目录 + 注册表一致），last_project_id=A
3. **live userData 保留为迁移后新结构（projects/ 分层）**——这是预期终态；⚠️ **重大后果：D:\Yibiao 的旧版打包应用（0.1.0 旧代码）将无法读取该结构**（旧代码读全局三域表 + 旧平铺路径，二者已不复存在）。用户下次启动必须使用含多项目支持的新版本（需尽快重新打包发布），在打包新版就绪前建议不要启动旧版打包应用（旧版启动虽不会破坏新结构数据，但其全局库无三域表/旧路径为空，会表现为空项目/初始化全新安装状态，且旧版写入可能产生脏数据）
4. 备份 `$env:APPDATA\yibiao-client.bak-multi-20261031-182916` 原样保留未动（回滚锚点：如需回到迁移前，关应用后整目录替换）
5. 中间产物与证据：`D:\Neo\Neo\tmp\yibiao-verify\`（截图 5 张、单测/快照/清理 JSON、CDP 驱动脚本、保存对话框驱动脚本、export 目录为空——导出被环境阻断）

## 第二轮发现汇总

### 缺陷（需修复任务跟进）

1. **P0：项目删除功能全断**——`projects:remove` 第一行调用 `taskService.cancelTechnicalPlanTasks/cancelDuplicateCheckTasks/cancelRejectionCheckTasks`，三者均未从 createTaskService 的返回对象导出 → TypeError，任何项目删除必然失败。修复极小（return 对象补三个方法引用），修复后需补场景 8 回归（运行中任务终止 → 连接关闭 → 目录物理删 → A 无恙 → 当活跃项目删除时置空 active）
2. **P2：dev 模式导出对 .NET 10 SDK 的硬依赖**——openxmlhelper target net10.0 + dev 态无条件 dotnet build，SDK 8 机器上导出 docx/样张预览全断（打包版不受影响）。建议 dev 检测 bin 产物存在即跳过 build，或 CI 锁 SDK 版本并写入开发文档

### 观察项（不阻断）

- IPC 直调 createFromTenderFile 后渲染层短暂停留列表页（见※1）
- 空 outline 的 saveOutline 不触发项目名回写（早退分支，设计行为；UI 真实流程不受影响）
- 应用自带「远程公告」赞助弹窗会在会话中弹出，UI 自动化时需甄别，避免误当目标弹窗
- Electron GUI 子系统 exe 的 stdout 只有重定向/管道才可捕获（PowerShell 直接赋值拿不到输出）——本轮工具链经验
- `yibiao-asset://` scheme 未开 supportFetchAPI：渲染层 fetch 自定义协议 CORS 失败，验证图片加载需用 img 元素（应用自身加载路径即如此）

---

# 第三轮（P0 修复后）：场景 8/10 复验

> 日期：2026-10-31 晚（第二轮之后）
> 分支：feature/multi-project-support @ 884e60e（fix：taskService 返回对象补导出三域 cancel 方法，+5 行恰 1 文件）
> 起点：live userData = 迁移后新结构，仅 A（20261031-bv1vsa）；备份 `%APPDATA%\yibiao-client.bak-multi-20261031-182916` 未动
> 方式：同前（vite 5173 后台 + electron --remote-debugging-port=9222，CDP Runtime.evaluate 驱动 window.yibiao API）；启动 electron 的 shell 额外注入 `$env:DOTNET_ROOT="$env:LOCALAPPDATA\dotnet10"` 且把 `%LOCALAPPDATA%\dotnet10` 前置到 PATH（本机 .NET SDK 10.0.403 用户级安装在该目录；系统 PATH 的 dotnet 是 Program Files 下仅含 SDK 8.0.422）
> 产物目录：`D:\Neo\Neo\tmp\yibiao-verify\`（r3-* 文件）

## P0 修复内容（884e60e）

`electron/services/taskService.cjs` 的 createTaskService 返回对象在 getActiveTasks 之后补 4 个方法引用：`cancelTechnicalPlanTasks / cancelRejectionCheckTasks / cancelDuplicateCheckTasks / cancelFeasibilityReportTasks`（第四个同样未导出，一并补上）。函数本体 T6 时已是统一签名 `(reason, { projectId, taskTypes })`，仅缺导出。`node --check` + `npm run build`（tsc --noEmit + vite build）通过。

## 场景 8 复验（删除项目）：✅ PASS（第二轮 P0 缺陷闭环）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 造临时项目 | ✅ | 复制 A 的 tender-originals docx 改名「P0复验场景八临时项目.docx」→ `projects.createFromTenderFile`：projectId=20261031-u2xfqi、name=文件名去扩展（name_source=filename）、importResult.success=true（已解析 1 份招标文件） |
| 附带验证：导入软失败回滚 | ✅ | 首次调用因 CDP 转义吃掉反斜杠传了坏路径 → import 解析 ENOENT → **统一回滚链路实跑**：临时项目注册表落 deleted、目录未留、active 置 null、无幻影条目（dde1d0c 的 main 侧回滚在真实数据上验证通过） |
| 起运行中任务 | ✅ | `tasks.startBidSectionExtraction({projectId: 临时id})` → running，project_id=临时id（真实 AI 调用进行中） |
| **删除（上轮断裂点）** | ✅ | `projects.remove({projectId})` → **resolve {ok:true}，耗时 38ms**（上轮在此第一行抛 TypeError） |
| 运行任务终止 | ✅ | remove 返回后 getActiveTasks=[]，运行中的多标段识别任务被 cancel+waitForSettlement 收干净 |
| registry 软删 | ✅ | 全局库 projects 表：20261031-u2xfqi status='deleted'（含软删回滚链的 20261031-9u06je 亦为 deleted） |
| 目录物理删除 | ✅ | `workspace/projects/20261031-u2xfqi` 不存在；projects/ 下仅剩 20261031-bv1vsa（+ .legacy 元数据） |
| 活跃项目置空链路 | ✅ | 删除时临时项目正为 active → 删除后 activeProjectId=null、user_config.last_project_id=null（与 projectsIpc 设计一致）；随后手动 setActive(A) 恢复 |
| A 完好（行数抽 3+ 表） | ✅ | A 项目库 11 张关键表行数与删除前基线**逐一相等**：outline_nodes=75 / content_plans=55 / content_sections=55 / bid_items=18 / generation_bid_tasks=18 / global_fact_groups=18 / tasks=4 / 查重 meta=1 / 废标 meta=1+documents=2+extraction=1 |
| 运行任务弹窗展示链路 | ⏭ 跳过 | 上轮已验证（r2-08-delete-dialog.png：二次确认 + 列出将被终止任务），本轮不重复 |

## 场景 10 复验（A 导出 docx）：✅ PASS（DOTNET_ROOT+PATH 注入解决环境阻断）

| 检查项 | 结果 | 证据 |
|---|---|---|
| .NET 10 环境注入 | ✅ | electron 启动 shell：`DOTNET_ROOT=%LOCALAPPDATA%\dotnet10` + 该目录前置 PATH → `execFile('dotnet', ['build', ...])`（openXmlHelperService.cjs:373，shell:false 走 PATH 解析）命中 SDK 10.0.403；不再出现 NETSDK1045 |
| 导出触发 | ✅ | CDP 直调渲染层同参调用：`export.exportWord({requestId:'r3-export-1', source:'technical-plan'})`（与 TechnicalPlanHome.tsx:688 的真实 UI 调用同构）；inspect 结构检查零问题（无需 confirmStructureIssues 二次确认） |
| 保存对话框默认文件名 | ✅ 规则符合、取值如实 | Edit(1001) 读得默认名 `标书文档_20261031_202242.docx`——规则 `<项目名>_<YYYYMMDD_HHMMSS>.docx` 成立；但项目名取的是 `outlineData.project_name`（A 真实数据该值为 NULL）→ 落到回退字面量「标书文档」而非注册表里的招标文件名。**与任务预期「项目名=招标文件名」不符**：导出文件名不读注册表项目名，属现有设计（export filename 走 outline 数据），记录待产品定夺 |
| 文件生成 | ✅ | `D:\Neo\Neo\tmp\yibiao-verify\export\r3-A-export.docx`，30,394,420 字节；result={success:true, path, warnings:[]}，无图片失败告警 |
| 正文核对 | ✅ | document.xml 解压 1,589,155 字节；`<w:t>` 3059 段 / 正文约 12.4 万字符；开头「内容由 AI 生成 / 投标技术文件 / 第一章 系统总体设计…」，关键词 光储/EPC/第一章/施工/技术方案 全命中——A 的真实目录与正文完整进入导出 |
| 图片核对（media ≥2） | ✅ | docx zip 内 **16 张 png**（`media/image.png`…`image16.png`，openxmlhelper 的 media 布局在包根 media/ 而非 word/media/，合计约 30MB）——A 的配图真实嵌入 |
| 多项目路由 | ✅（间接） | 导出内容为 A 的招标/正文数据且图片来自 A 项目任务 workspace，getTechnicalPlanExport 按当前项目（A）解析正确 |
| 导出后 UI | ✅ | 进度 100% 完成弹层；「远程公告」赞助弹窗随后弹出（已知观察项，未当异常）；截图 r3-10-export-done.png |

## 收尾与现场

1. dev 全关：electron 主进程先 CloseMainWindow 后强杀（当时 MainWindowHandle 被模态占据致优雅关闭未达，最终进程树清零）；vite 停止；端口 5173/9222 均释放；残留核查 `Get-Process electron` 为空
2. **live userData 保持迁移后新结构，终态**：projects/ 下仅 A；注册表仅 A active；user_config.last_project_id=A；备份目录完好未动；A 项目库 729,088 字节
3. 工具链新坑（记录）：① `electron --run-as-node <脚本>` 进程跑完不退出且会 spawn GPU/utility 子进程——脚本末尾必须 `process.exit(0)`，或改用 `ELECTRON_RUN_AS_NODE=1` env 方式（第二轮经验仍适用）；本轮 5 个滞留快照进程已全部清理；② CDP Runtime.evaluate 传 Windows 路径必须用正斜杠（反斜杠在 bash+CDP 双层转义下被吃成控制字符）；③ 本轮 cdp.cjs 修复了一个上轮遗留工具 bug：`replMode:true` 会令 `awaitPromise` 静默失效（Promise 一律返回 `{}`），去掉 replMode 后异步表达式才能取值
4. 第三轮结论：**场景 8/10 双 PASS，第二轮两项未闭环项（1 FAIL + 1 环境阻断）全部清零**；遗留事项仅一条产品决策类观察（导出默认文件名的项目名取值来源），非功能缺陷


