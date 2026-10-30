# 设计：标书制作多项目支持（multi-project support）

- 日期：2026-10-30
- 状态：待评审
- 分支规划：`feature/multi-project-support`（基于 `feature/selective-section-generation` 之后的主线）

## 1. 背景与目标

当前应用一次只能制作一份标书：上传招标文件、生成设置、目录、正文、导出全部挂在唯一的工作区状态上（单例 meta + 全局任务槽）。中途来了更急的项目只能覆盖或重置现有数据。

目标：支持多个投标项目并行推进——

1. 上传招标文件即创建项目（文件名即项目名），后续所有设置与数据归属该项目；
2. 可随时切换项目处理急件，切回后继续；切走**不中断**后台生成任务；
3. 两个项目可以同时跑各自的生成/分析任务，数据严格隔离。

### 决策记录（用户已拍板）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 切换项目时长任务 | **后台继续跑**（全并行，非自动暂停） |
| D2 | 项目化范围 | **三域**：标书制作（technical-plan）、查重（duplicate-check）、废标检查（rejection-check）；可行性报告/知识库/资信库/商机维持全局 |
| D3 | 项目命名 | 上传时**文件名即名**（去扩展名）；outline 阶段 AI 提取后自动更新（name_source=filename→ai）；手动改过（manual）不覆盖 |
| D4 | 数据隔离架构 | **每项目独立 SQLite + 项目目录 + 全局注册表**（否决单库加 project_id 方案——上百条 SQL 逐条加过滤，漏一条即跨项目数据污染） |

### 附带结论

- 生成设置中的"参考知识库文件选择"存在 `technical_plan_generation_config` 表，随标书数据进项目库，**自动按项目隔离**；知识库文档本体保持全局共享（跨项目复用，无需重复上传）。

## 2. 总体架构

```
userData/
  workspace/
    yibiao.sqlite                  # 全局库：projects 注册表 + 知识库/资信/可行性报告/导出模板等全局域
    projects/
      <projectId>/
        project.sqlite             # 该项目三域全部业务表（库内保持单项目语义）
        technical-plan/            # 原 workspace/technical-plan/ 整体搬入
        duplicate-check/           # 原 workspace/duplicate-check/ 整体搬入
        rejection-check/           # 原 workspace/rejection-check/ 整体搬入
        assets/                    # 该项目图片资产（generated-images/imported-images/mermaid 缓存，见 §4.1）
        logs/                      # 该项目三域流程日志（logs/ai 保持全局——AI 请求日志与模型配置同级）
```

- **projectId**：`YYYYMMDD-xxxxxx`（日期 + 6 位随机 base36），目录名安全、肉眼可读。
- 全局库与项目库的 schema 版本（`PRAGMA user_version`）**分开管理**；项目库创建即最新 schema，打开旧项目库时惰性跑迁移。
- 原 `technical_plan_*`、`duplicate_check_*`、`rejection_check_*` 表从全局库迁出后 DROP（迁移方案见 §7）。

## 3. 项目注册表（全局库新表）

```sql
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,            -- 如 20261030-a1b2c3
  name          TEXT NOT NULL,
  name_source   TEXT NOT NULL DEFAULT 'filename',  -- filename | ai | manual
  status        TEXT NOT NULL DEFAULT 'active',    -- active | deleted（软删，列表不显示）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  -- 冗余进度摘要（best-effort 维护，列表页不打开项目库即可渲染）
  current_step  TEXT,                        -- 三域各自当前阶段摘要
  gen_summary   TEXT                         -- 如 "正文 43/55 节"
);
```

- 列表页/切换器只读这张表；深层数据一律开项目库取。
- 冗余字段由任务 checkpoint / 关键状态变更时 best-effort 更新，失败不阻塞任务。

## 4. 三域搬迁清单

| 域 | 迁入项目库的表 | 迁入项目目录的内容 | 任务类型（参与 projectId 键改造） |
|---|---|---|---|
| technical-plan | `technical_plan_meta/_tasks/_outline_nodes/_content_sections/_content_plans/_bid_items/_generation_config/_global_fact_groups` | `technical-plan/tender.md`、`tender-originals/`、`tender-files/`、`original-plan.md`、`bid-template.docx` 等固定路径（现 paths.cjs:46-117） | 正文生成、目录生成、标书分析、全局事实、扩写 |
| duplicate-check | `duplicate_check_*` 全系（meta 及 file/document 明细） | `duplicate-check/contents/<fileId>.md` 等 | 查重比对任务 |
| rejection-check | `rejection_check_*` 全系（meta/extraction/bids 明细） | `rejection-check/bids/<documentId>.md` 等 | 废标检查任务 |

不动：`knowledge_*`、`credential_library_*`、`feasibility_report_*`、`export_templates`、`task_logs`（全局）、logs/ai。

**跨域杂项（同样归属项目）**：

| 项 | 现状 | 归属 |
|---|---|---|
| agent 持久任务/会话数据 | pi environment 的 tasksRoot（userData 下固定目录，**在 workspace 外**，见 piPersistentTaskStore.cjs:20-30） | 迁入项目目录（§5.3 的前缀改造后自然落在项目内）；存量归 default 项目 |
| 三域流程日志 | `userData/logs/<module>`（paths.cjs:128-137，getDeveloperLogsDir） | technical-plan / duplicate-check / rejection-check 三模块日志改按项目路由；logs/ai 保持全局 |
| 图片资产（AI 生图/导入图/mermaid 缓存） | 全局 `workspace/generated-images/`、`workspace/imported-images/`、mermaid 缓存 | 三域相关资产迁入项目 `assets/`（见 §4.1） |

### 4.1 图片/资源资产项目化（评审B Issue 1，不做会跨项目删图）

图片资产目前是全局目录，且被启动清理/级联清空按全局处理，不项目化的后果：项目 A 重置会删项目 B 的图片（markdown 引用悬空）；**升级后首轮启动会把所有项目生图删光**（三域表从全局库 DROP → 健康检查重建空表 → 孤儿清理判定全部生图无引用）。

| 落点 | 改法 |
|---|---|
| 目录 | `generated-images/technical-plan`、`imported-images` 的 technical-plan 批次、mermaid 缓存（mermaidCache.cjs:30-41）→ 项目 `assets/` 下；查重/废标自有资产同样归项目 |
| 协议 | `yibiao-asset://` 三处处理器（main.cjs:265、exportService.cjs:1537、duplicateCheckService.cjs:2088）改按项目资产根解析 |
| 启动清理 | `clearOrphanedGeneratedImages`（storageCleanupService.cjs:57-97）改为逐项目打开项目库算引用集，按各项目资产根清理 |
| 级联清空 | `clearTechnicalPlanMermaidCache`、`cleanupOriginalImageBatches`（technicalPlanStore.cjs:2440-2458）、`deleteImportedImageBatches(app,'technical-plan')`（:2628-2630，现按前缀匹配全局根）——store 项目化后路径落在项目内，作用域自动收敛 |
| schema 健康检查 | `schemaHealthTableGroups`/`columnGroups`（sqliteDatabase.cjs:1237-1267）拆**全局库组 / 项目库组**两套——防止三域表 DROP 后健康检查在全局库重建空表 |

## 5. 运行时改造（并行核心）

### 5.1 连接路由

- 现状：`ipc/index.cjs:285-326` 启动时创建共享 `db` 注入各 store。
- 改法：新增 `projectStoreRegistry`（主进程）：
  - `getProjectContext(projectId)` → 惰性打开 `projects/<id>/project.sqlite`（better-sqlite3），打开时跑迁移到当前 schema 版本，LRU 缓存（上限 8 个连接）；
  - **淘汰保护用引用计数**：任务起止、三域 IPC handler 入口/出口各 ±1，计数 >0 的连接不淘汰——"运行中任务持有"不足以覆盖 importTenderDocument 解析 await 后回调写库这类非任务异步流；被淘汰后再次访问即重开（store 内联 `db.prepare`、无语句缓存，lazy 重开可行）；
  - **写死结论：三域 store 按项目实例化**（每项目一套 store 实例，随连接创建/销毁）。technicalPlanStore 的路径常量在构造期解析（technicalPlanStore.cjs:500-509），"方法加 projectId 入参"方案对该 store 不可行；
  - 惰性打开兼做**中断恢复入口**：`recoverInterrupted*`（现于 taskService 构造期对单一 store 执行，taskService.cjs:1357-1370）改为 getProjectContext 首次打开该项目时执行——outline 恢复会自动重启任务（:1028-1039），语义变为"用户打开该项目时恢复"；
  - 全局域 store 继续用全局 db，不受影响。

### 5.2 任务注册表与锁

- 现状：`activeTasks`/`activeTaskControls` 以 task type 为 key（taskService.cjs:321-322、:666）；`getActiveTaskConflict`（:547-574）对同 group 任何 active 任务直接冲突，与 scope 无关。
- 改法：
  - 内存键 `type` → `${projectId}:${type}`；
  - `taskDefinitions`（:30-175）的 `lockPolicy: 'group-exclusive'` 语义改为**项目内 group 互斥、跨项目放行**；
  - 落库的任务状态（原 `technical_plan_tasks` 按 type 一条）改按 `(project_id, type)` 唯一——项目库内表结构可保持按 type 主键（库即项目，天然成立），跨项目互不覆盖；
  - 所有任务事件（checkpoint、进度、完成/失败）payload 增加 `projectId`，含 `TaskEvent` 类型定义（shared/types/ipc.ts:36、:833）；
  - renderer 事件过滤必须覆盖 `subscribe()` 的**全量重放帧**（taskService.cjs:522-530 重放所有任务快照）——只过滤增量事件会漏。

### 5.3 agent 会话

- 现状：会话按全局 TASK_KEY 存固定目录（agentService.cjs:690-747）；`primarySession` 全局单例（:176、:443-455）隐含互斥。
- 改法：
  - 会话存储路径加 `projects/<projectId>/` 前缀；`primarySession` 改为 **per-project 单例**（Map<projectId, session>）。Pi Runtime 本就是每任务一实例（:426-437），无需改；
  - **仅三域 TASK_KEY 项目化**——`FEASIBILITY_OUTLINE_AGENT_TASK_KEY` 等全域键保持原样（可研维持全局，不被前缀化、不搬进项目目录）；
  - `clearStalePiTaskArchives`（storageCleanupService.cjs:18-25、:46-55，每次启动执行）的静态保留名单 `PERSISTENT_AGENT_TASK_KEYS` 改为**动态生成**（projects 注册表 × 三域键 + 全域键）——键加项目前缀后静态名单全部失配，会每次启动把所有项目 agent 会话当垃圾清掉（评审B Issue 4）；
  - `pendingQuestions` 全局单队列（agentService.cjs:173-174、:274-279）双项目并发时弹窗无归属——payload 与 UI 增加项目标识。

### 5.4 AI 队列

- 现状：全局队列 concurrency_limit=10，按 `queueScopeId` 分作用域，支持 pause/resumeScope（aiService.cjs:2458-2552、:2574-2596）。**现有 scope 是任务级**：`queueScopeId = ${type}:${task_id}`（taskService.cjs:682），任务暂停走 `pauseQueueScope(control.queueScopeId)`（:1519-1521），任务结束 `finally` 自动 resume（:897-899）。
- 改法：scope 改**分层键** `${projectId}:${type}:${task_id}`——保留任务级暂停语义。⚠️ 禁止扁平化为 projectId（评审A/B 共同确认的回归）：扁平化后暂停 A 任务会打死同项目并行任务排队的请求（pauseScope 会清空该 scope 排队/重试中的请求并拒绝后续入队，aiRequestQueue.cjs:165-191）；任一任务结束的自动 resume 会误解除另一任务的暂停。
- **不做"按项目暂停"**：D1 是切走不暂停，项目级 scope 无消费方。10 并发全局共享不变（两项目同时生成各自排队，公平竞争），**不改并发上限**。

## 6. IPC 面改造

- 三域全部通道加 `projectId` 首参（通道名以 taskIpc.cjs 等 IPC 注册处的**具名清单**为准，如 `tasks:start-content-generation`——现状无统一 retry 通道，勿按通配名臆造）：`technicalPlan.loadState/saveX/clear/importTenderDocument`、`duplicateCheck.loadState/...`、`rejectionCheck.loadState/...`（shared/types/ipc.ts:582-859，其中 734/788/796 三个无参 loadState 是重点）。
- **隐藏调用面一并纳入**（均持有三域 store 单例或直达任务面，评审B 建议3）：`checkResultExportService` 与 `duplicateCheckService`（ipc/index.cjs:302-308 捕获 store 单例）、`agentWorkspaceService` providers（agentWorkspaceService.cjs:135-237，`sendMessage` 直达 `taskService.startOutlineAdjustment`）、pluginContext 暴露给插件的 getTechnicalPlanState/getActiveTasks/onTaskEvent 等 API（pluginContext.cjs:68-106，语义定为"固定当前活跃项目"）、`technical-plan:preview-content-word`（technicalPlanIpc.cjs:17 → contentGenerationOutput.cjs:29 读 agent 会话）。
- 渲染层改造面：约 143 个调用点、15 个文件（含 export-format/ExportFormatPage.tsx:619、developer 两页），实施计划按清单逐一加参。
- preload API 签名同步改；renderer 维护 `currentProjectId`。
- `tasks.onTaskEvent`（:833）事件带 projectId；renderer 只渲染当前项目任务，**其他项目有 active 任务时顶栏显示"⚡ N 个项目运行中"角标**，点击展开可切换。
- 新增 `projects.*` 通道：`list / create / rename / delete / getActive / setActive`。

## 7. 存量数据一次性迁移

启动时检测（`ensureWorkspaceSchemaHealth` 之后）：

1. 条件：全局库存在 `technical_plan_meta` 有数据 且 `projects` 表无 active/migrating 记录；
2. 建 default 项目（name 取 `outline_project_name`，无则"导入的项目"；name_source=ai），registry 行以 **status=migrating** 落库（journal）；
3. **先备份**（复用 `backupDatabaseFiles` 机制，sqliteDatabase.cjs；从备份还原前先 close 全局库连接再复制回）；
4. 事务内：三域全表复制到 `projects/<defaultId>/project.sqlite`；
5. 目录移动：工作区三域目录、图片资产（§4.1）、存量 agent 会话（tasksRoot 三域部分）、三域模块日志 → default 项目目录；
6. 全局库 DROP 三域表 + 清除对应迁移步骤记录；registry 行置 status=active（journal 完成）；
7. **崩溃恢复（对断电/强杀设防，评审B Issue 3）**：文件移动不在 SQLite 事务内，存在危险窗口（表已复制目录未移 / 目录已移表未 DROP）。启动时发现 status=migrating → 按分步清单**幂等续跑**（每步先查目标态再执行），续跑失败则从备份还原并标错。禁止"projects 非空即跳过"——半迁移状态必须由 journal 识别，不许静默存在。

## 8. 前端改造

- **项目列表页**（侧栏"标书制作"落地页）：卡片（名称 / gen_summary 进度 / 更新时间）+ "新建项目"按钮（= 选招标文件，文件名即名）。空状态引导上传。查重/废标入口同理显示当前项目数据。
- **启动行为**：直接恢复 last_active 项目进入原向导；顶栏加项目切换器（下拉列表 + 新建入口）。
- **useTechnicalPlanWorkflow**（useTechnicalPlanWorkflow.ts:45、:48-71）：hydrate 按 projectId；切换项目 = 丢弃内存 state 重新 `loadState(projectId)`；任务事件按 projectId 过滤。
- 向导 7 步（TechnicalPlanHome.tsx:43-51）内部逻辑不动；勾选生成（feature/selective-section-generation）随项目数据自动归属。
- 侧栏切到查重/废标：显示当前活跃项目状态；无活跃项目显示"请先选择项目"空态。

## 9. 上传 / 命名 / 生命周期

- **新建项目**：选文件 → 立即写 registry（name=首份文件名去扩展名）→ 建项目库+目录 → 原件复制/解析管线照旧（写入该项目内路径）。建库/复制中途失败 → 回滚 registry 条目 + 项目目录，不留孤儿。项目内追加上传多份招标文件：保留现有 v16 语义。
- **上传即清空下游**（clearDownstreamFromTender，technicalPlanStore.cjs:1587-1617）：语义不变，作用域自动限定在该项目库内。
- **重命名**：registry UPDATE，name_source=manual。
- **删除**：醒目二次确认（有运行中任务先展示并终止——复用 cancelTechnicalPlanTasks 遍历+cancel+waitForSettlement 模式，taskService.cjs:909-921，加 projectId 过滤）→ 软删 registry（顺带清空冗余进度字段）+ 删除项目目录。删除当前活跃项目时同步清 last_active（回退最近活跃项目或落到列表页）；default 项目同样可删（等价空态，重新上传即新建）。不做回收站。
- **导出**：文件名规则不变（exportService.cjs:3003），数据源改为当前项目库（technicalPlanExport.cjs:68-171 的读取走项目连接）。

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 项目库损坏/打开失败 | 列表页该项目标错隔离，不拖垮其他项目与全局库 |
| 项目库 schema 版本 > 客户端 | 该项目标记"由新版本创建，不可打开"，其他项目不受影响（沿用 :1834-1835 降级保护思路，范围缩小到单项目） |
| registry 冗余字段更新失败 | best-effort，记日志不阻塞任务 |
| 切换时目标项目库迁移中 | getProjectContext 返回前完成迁移，UI 显示加载态 |

## 11. 测试策略

- **单元**：projectStoreRegistry 缓存/淘汰/懒迁移；任务键隔离（两项目同 type 任务并行不冲突、事件不串）；group-exclusive 项目内互斥/跨项目放行；命名流（filename→ai 自动更新、manual 不覆盖）；迁移（构造含三域数据的老全局库 → 搬迁断言）。
- **集成（CDP，复用 tmp/cdp_eval.mjs 模式）**：双项目并行生成互不串扰（各自正文落各自库/目录）；切换时 UI 状态隔离；顶栏角标与事件路由；查重/废标按项目归属。
- **迁移实测**：用本机现有 userData 副本跑一次搬迁，比对搬迁前后数据一致。

## 12. 明确不做（YAGNI）

- 项目归档/收藏/搜索/标签、跨项目统计 dashboard；
- 知识库/资信库/可行性报告/商机项目化；
- 项目模板、项目复制；
- 回收站/软删除恢复（软删仅作删除标记用）；
- AI 并发上限调整、任务优先级抢占。

## 13. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| better-sqlite3 多连接内存占用 | LRU 上限 8；实测监控 |
| 双项目同时生成时 AI 并发争抢（共享 10） | v1 接受公平排队；如实测饥饿再做按项目配额（明确延后） |
| 迁移搬迁失败 | 先备份 + 事务 + 失败回滚，启动标错 |
| 老版本客户端打开新库结构 | 全局库版本号随之提升，老客户端按现有机制拒绝启动，不产生半兼容状态 |

无未决开放问题。

## 14. 评审记录

| 轮次 | 评审方 | 结论 | 修正 |
|---|---|---|---|
| 1 | spec-document-reviewer（13 处引用核实） | Approved + 3 建议 | 存量迁移纳入 agent 会话与三域日志归属（ded2823） |
| 2 | 独立评审A·设计质量（19 处引用核实） | Issues×1 | §5.4 scope 禁止扁平化 → 分层键 `${projectId}:${type}:${task_id}` |
| 2 | 独立评审B·对抗实施（8 场景推演） | Issues×4 + 建议6 | 新增 §4.1 图片资产项目化；§5.3 清理名单动态化 + 全域键豁免；§7 journal 幂等迁移；§6 隐藏调用面清单；§5.1 引用计数 + store 项目实例化写死；§5.2 重放帧过滤；§9 新建回滚/删除边界。建议全部吸收 |
