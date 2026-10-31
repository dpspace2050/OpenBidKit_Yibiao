# 多项目支持集成验证记录（T14：CDP + 真实迁移实测）

> 日期：2026-10-31
> 环境：dev 模式（vite 5173 + electron --remote-debugging-port=9222），分支 feature/multi-project-support（f7808ba）
> 测试数据：**用户真实存量 userData**（白朗县光储 EPC 项目，全局库 4.9MB / workspace 621.5MB / 1424 文件）
> 前置安全：打包版 4 进程已优雅关闭；完整备份 `%APPDATA%\yibiao-client.bak-multi-20261031-182916`（621.5MB，事后核对完好未动）

## 结论：BLOCKED —— 真实存量迁移在 drop-tables 步骤确定性失败，11 项 CDP 场景全部无法执行

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
