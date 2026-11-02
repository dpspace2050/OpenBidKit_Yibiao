# 招标文件解析执行模式（逐项/并发）设计文档

- 日期：2026-11-02
- 状态：已实施（2026-11-02 真机验证通过，4/4 场景 PASS：UI 双向切换/逐项+中断续跑/并发/埋点，见 plans/2026-11-02-bid-analysis-execution-mode-verification.md）
- 分支：基于 `feature/multi-project-support`
- 审计：双独立子代理设计审计（代码事实核对 + 边界对抗）+ 三轮 spec 审查（评审通过 → 双审查员复审抓出 DDL 注册机制 P0 → 修订）

## 1. 需求

招标文件解析步骤（向导第 3 步 BidAnalysisPage）新增"解析方式"选项：

| 模式 | 行为 | 默认 |
|---|---|---|
| 逐项（sequential） | 选中解析项依次逐个解析，前一项结束（成功或失败）才启动下一项 | ✅ |
| 并发（concurrent） | 选中项同时解析（现状行为） | |

- 单项解析失败不阻塞后续项（现状 `runOneSafely` 语义复用）
- 选择随解析配置持久化，跨会话记忆

**明确不做**（审计 P0 裁决）：暂停语义。bid-analysis 全链路现状无暂停入口（taskService 只有 `pauseContentGeneration`/`pauseFeasibilityContent`，taskIpc.cjs / preload.cjs / UI 均无对应通道），本设计不新增。逐项模式只响应**取消**（signal.aborted）。

**边界声明**："逐项"指解析项**之间**串行；单项内部长文档分段提取仍并行（`splitUserTextByContextLimit` 分段 + Promise.all 合并，现状保留）。UI 说明文字如实写明。

## 2. 数据模型与持久化

### 2.1 新字段

`technical_plan_generation_config` 表新增列 `bid_analysis_execution_mode TEXT NOT NULL DEFAULT 'sequential'`。

**⚠️ 注册机制（P0 修订，双审查员实锤）**：该表自多项目改造（v37 拆库）后归属**项目库**（project.sqlite）。项目库开库只走 `ensureProjectSchemaHealth`（projectStoreRegistry.cjs:41-45 → sqliteDatabase.cjs:1651-1666），只补 `projectSchemaColumnGroups`（:1369 起）里注册的列；`migrations[]`/`applyMigrations` **只跑全局库**，且 v37 已把三域表从全局库剔除（:8-10 注释 + :1847-1853 空迁移栅栏）。因此列注册**必须**在 `projectSchemaColumnGroups` 追加条目：

```js
{ version: 36, table: 'technical_plan_generation_config', columns: { bid_analysis_execution_mode: "TEXT NOT NULL DEFAULT 'sequential'" } }
```

（写法参照 :1541-1547 `layout_check` 条目。）

**不做**全局库 v38 防御迁移：全局库三域表已是死数据（v37 存量复制后 DROP），加迁移需三处齐改（migrations 条目 + `schemaVersion` 37→38 bump，否则 applyMigrations :1907 提前返回静默失效），且版本号 bump 会再次触发版本栅栏把 v37 客户端挡在门外 — 无收益有风险，最小改动只注册项目库列组。`createTechnicalPlanGenerationConfigSchema`（:163-201）建表清单**不同步**（该清单早已落后，仓库惯例是列组健康检查为唯一补列通道，新库建表后健康组自动补列）。

### 2.2 命名分界（静默失效高危交界，钉死）

| 层 | 拼写 |
|---|---|
| DB 列 | `bid_analysis_execution_mode`（snake） |
| startBidAnalysis payload | `execution_mode`（snake，与现有 task_ids/force_rerun 一致） |
| store / 状态 / IPC / 前端 | `executionMode`（camel，全链统一） |

`updateGenerationConfig`（technicalPlanStore.cjs:826-833）按 `Object.keys(current)` 逐键 `hasOwn(partial, key)` 合并 — 键名不一致即静默丢弃，三处（normalizeGenerationConfig 输出 / loadTechnicalPlan 映射 / saveBidAnalysisConfig 解构）必须同用 `executionMode`。

### 2.3 触点清单（白名单式存储，漏一处即静默失效）

| 层 | 文件 | 改动 |
|---|---|---|
| schema | `client/electron/services/sqliteDatabase.cjs` | `projectSchemaColumnGroups` 追加条目（见 2.1） |
| store | `client/electron/services/technicalPlanStore.cjs` | 8 处：`initialState`（:62-97）、`createDefaultGenerationConfig`（:366-381）、`normalizeGenerationConfig`（:383-402）、`ensureGenerationConfigRow` INSERT（:685-721）、`loadGenerationConfig`（:740-769）、`writeGenerationConfig`（:771+）、`saveBidAnalysisConfig`（:2089-2096 解构加 `executionMode`）、`loadTechnicalPlan` 映射（:1947-1966），键名统一 `executionMode`（见 2.2） |
| IPC 类型 | `client/src/shared/types/ipc.ts`（:799 saveBidAnalysisConfig 签名加 `executionMode?`） | preload.cjs 纯 JS 无类型文件，payload 原样透传零改动，**不是触点** |
| 前端类型 | `client/src/features/technical-plan/types.ts`（:60-72 `TechnicalPlanGenerationConfig` 接口 + :339 `TechnicalPlanState` 各加 `executionMode`）+ BidAnalysisPage props | 类型声明同步 |
| 前端接线 | `client/src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts`（:14-15 useState 初始值）、`client/src/features/technical-plan/pages/TechnicalPlanHome.tsx`（:485-488 / :1124-1125 / :1137 状态合并与 props 下传） | 默认 `'sequential'`（已核实 :55 cachedState 展开覆盖默认值，落点正确） |
| 埋点 | `BidAnalysisPage.tsx:386` `trackConfigUsage` + `client/src/.../analytics.ts:48` | `bid_analysis_execution_mode` 随现有 `bid_analysis_mode` 模式加埋点 |

### 2.4 旧配置回退

老项目配置无此字段 → `loadState` 返回 undefined → **前端显式回退 `'sequential'`**（与后端 normalize 缺省一致）。`ADD COLUMN ... NOT NULL DEFAULT` 对已存在行 SELECT 直接返回默认值（SQLite 语义）；多项目 legacy 复制为列交集（projectMigration.cjs:126-134），新列自动排除、默认值兜底 — 均无残留问题。

### 2.5 老用户行为变更明示

默认从"全部并发"变为"逐项"。UI 上"逐项"选项标"默认"chip，配置卡内一句话说明两种方式差异。

## 3. 后端设计

### 3.1 payload 与 normalize

`startBidAnalysis` payload 新增 `execution_mode`。链路透传已审计证实无阻：preload.cjs:314 原样 invoke → taskIpc.cjs:8-11 直传 → taskService.cjs:1471 `{...payload, projectId}` → runner :927。

`runBidAnalysisTask` 内 normalize：

```js
const executionMode = payload.execution_mode === 'concurrent' ? 'concurrent' : 'sequential';
```

缺省/非法 → sequential。与现有 `mode`（full/custom/key，决定**跑哪些项**）正交。

### 3.2 执行循环（替换 bidAnalysisTask.cjs:443 单行）

```js
async function runRound(tasksToRun) {
  if (executionMode === 'concurrent') {
    await Promise.all(tasksToRun.map(runOneSafely));
    return;
  }
  let index = 0;
  for (const task of tasksToRun) {
    if (taskControl.signal.aborted) break; // 取消：当前项结束后不再启动新项
    index += 1;
    updateTask({ status: 'running', logs: [`正在解析 ${task.label}（${index}/${tasksToRun.length}）`] });
    await runOneSafely(task);
  }
}
```

- **取消语义**：break 后落入既有收尾逻辑——若 signal 仍 aborted，后续 `checkpointTask` 先抛（taskService.cjs:801-803），runner catch 判 aborted 静默，现有 interrupted 恢复语义接管。**不引入新终态**。
- **断点续跑**：取消/失败后再点"开始解析"，:366 现有过滤（`status !== 'success'`）只跑未完成项。已审计证实。
- **必填项校验**（:445 `getMissingRequiredTasks`）逻辑**不动**。其"按全量 required 而非本轮 scope"是既有现状，非本设计引入，不在本次修改范围（记录为已知现状）。
- **放置位置**（钉死）：`runRound` 不提取为模块级函数 — 它闭包引用 `executionMode`/`taskControl`/`updateTask`/`runOneSafely`，在 `runBidAnalysisTask` 体内、`runOneSafely` 定义（:423-431）之后、原 :443 处声明。
- **无进度抖动**（已核实）：`updateTask` 只带 logs 不带 progress，进度仅由 runOne/handleTaskError 的 checkpoint 推进；applyTaskPatch（:785）logs 为整体替换，"取末条"语义成立。
- 日志口径：分母 = 本轮 `tasksToRun.length`（续跑时正确），序号 = 本轮序号；单项重跑出现"正在解析 X（1/1）"属预期。`normalizeLogs` 只去重连续相同消息，日志上限 80 条（taskLogStore.cjs / 前端 MAX_UI_TASK_LOGS 同为 80），全量任务约 17 项无冲突。

### 3.3 taskControl 解构

`runBidAnalysisTask` 签名（:273）增加解构 `taskControl`（runner 调用点 :927 已传入）。

### 3.4 前缀预热（warmPromptPrefix，:434-442）

两种模式都保留（逐项模式首项前预热一次、后续所有项共享前缀缓存，收益更大）。**修订**：`warmPromptPrefix` 调用传入 `signal: taskControl.signal`（`client/electron/utils/promptPrefixCache.cjs`:25 已支持 `signal?.throwIfAborted()`），取消时预热段不再空转刷噪音日志。

## 4. 前端设计（BidAnalysisPage.tsx）

### 4.1 设置弹窗（:702-833）

"解析范围" section（:768-787）之后新增"解析方式" section，参照 `bid-analysis-config-presets`（:722-741）双按钮风格：

- **逐项**（标"默认"）— 说明：解析项依次逐个进行，更稳更省；长文档分段提取仍并行
- **并发** — 说明：所有选中项同时解析，速度更快

配套 draft 接线（P2 修订，钉死模式）：现有两种 draft **不同构** — `draftSelectedTaskIds` 只在弹窗打开时初始化（:327-334），`draftBidSectionMode` 另有 prop 同步 effect（:310-312）。`draftExecutionMode` **必须采用 `draftBidSectionMode` 模式**（useState + prop 同步 effect + `openSettingsDialog` 初始化）：因为 `retryActiveTask`（:448-455）与标段选择后续启（:493-499）都经 `saveConfig` 默认值取 draft 落库，若采用 SelectedTaskIds 模式，项目切换不重挂载时 A 项目的模式会写进 B 项目配置（跨项目脏值）。

### 4.2 持久化与下发

- `saveConfig`（:346）：`saveBidAnalysisConfig` 增加 `executionMode`，返回值（:357）同步携带
- `startBidAnalysisOnly`（:380-385）：payload 增加 `execution_mode: configState.executionMode`

### 4.3 文案与状态展示（三处 + chip）

| 位置 | 现状 | 改为 |
|---|---|---|
| :588 命令栏说明 | "并发解析招标文件，全部选中解析项结束后进入目录生成。" | 按当前配置动态："逐项解析招标文件，选中项依次完成后进入目录生成。" / "并发解析招标文件，全部选中解析项结束后进入目录生成。" |
| :696 任务列表提示 | "点击开始解析后，左侧任务会并发运行；…" | 按模式动态（"…左侧任务会依次运行…"） |
| :261-265 缓存优化提示 | 启发式：projectOverview running 且 doneCount===0 → "正在优化提示词缓存" | 逐项模式下跳过该启发式，progressMessage（:266-272）改取 task.logs 末条（"正在解析 X(i/N)"，参照 GlobalFactsPage.tsx:73 latestLog 模式；BidAnalysisPage 现状不渲染 task.logs，数据通道以此写死） |
| configLabel chip（:590-593, :276） | 仅解析范围标签 | 追加当前模式标签（"逐项"/"并发"） |

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 单项解析失败 | `runOneSafely` 捕获、标红该项、继续下一项（复用现状） |
| 取消（项目删除/重置/招标文件更新触发的 cancelTechnicalPlanTasks） | 项间检查 signal.aborted → break；in-flight 项由 aiService 队列层 signal 中止（现状） |
| 全部跑完仍有必填项缺失 | 现状 `getMissingRequiredTasks` → error + 点名缺失项（不动） |
| execution_mode 非法值 | normalize 落 sequential |
| tasksToRun 为空集/单项/单项重跑 | sequential 分支 for...of 天然兼容（0 次或 1 次循环）；单项重跑时 execution_mode 无实际作用，随配置传不影响 |

## 6. 测试

### 6.1 单元测试（新增 `client/test/bidAnalysisExecutionMode.test.cjs`）

node:test 风格 + 依赖注入 mock（aiService / workspaceStore / updateTask / checkpointTask / taskControl），与现有 4 个单测文件同体系。注意：现有 4 文件均为多项目基建测试，本文件是首个任务执行类单测。

**fixture 坑位（钉死，均为实测约束）**：

- `taskControl.signal` 必须用**真** `new AbortController().signal` — warmPromptPrefix 传 signal 后会进 `delay(1500, undefined, { signal })`（promptPrefixCache.cjs:23，node:timers/promises 不认 plain object）
- 多解析项（tasksToRun > 1）用例每个真实 sleep 1.5s（PREFIX_WARMUP_SETTLE_MS 不可注入，node:test 无 fake timer）— 多项时序用例控制数量，纯 sequential/concurrent 行为断言尽量用"单分段 + 多项"组合
- 绕过前置校验：`readTenderMarkdown → 'x'`（短文本单分段，避开 mergeSegmentedAiResults）、`loadTechnicalPlan → {}`（绕多标段校验 :283-294）、`getConfig → {}`
- 双跑法：纯逻辑用例 `node --test client/test/bidAnalysisExecutionMode.test.cjs`；含 better-sqlite3 的 round-trip 用例须 `ELECTRON_RUN_AS_NODE=1` + electron 二进制 `--test`（先例：2026-10-30 multi-project verification :126-128）；client/package.json 无 test script，跑法写进计划命令

必测面：

1. normalize 边界：缺省 / 'concurrent' / 非法值 → sequential
2. sequential：执行顺序严格串行（mock aiService 断言调用时序）
3. sequential：单项失败继续下一项
4. sequential：signal.aborted → break，不再调用后续项
5. 三路径：空集 / 单项 / requestedTaskIds 单项重跑
6. concurrent 分支：行为与现状一致（Promise.all 全发）
7. 预热：两模式都调用 warmPromptPrefix，signal 已传入（chat 调用参数断言）
8. 配置 round-trip（真 sqlite，electron-as-node 跑法）：**列组注册正确性守门** — 建项目库 → saveBidAnalysisConfig 带 executionMode → loadState 读回；若列未在 projectSchemaColumnGroups 注册，此用例直接抛 no such column（正是 P0 防线）

### 6.2 真机验证（dev 模式）

- 一轮逐项：观察项间串行、进度日志（i/N）、失败项不阻塞
- 一轮并发：与现状行为一致
- 断点续跑：中途取消后再点开始，只跑未完成项

## 7. 明确不改动

- 暂停语义（不新增 IPC/service/UI，isPauseRequested 不使用）
- `warmPromptPrefix` 预热结构与并发段逻辑
- 进度计算 `doneProgress`、必填项校验 `getMissingRequiredTasks` 的 scope 行为
- aiService 队列层（全局 10 并发上限共享不变）
- 其他任务类型（content-generation / feasibility 等）

## 8. 风险与已知现状

| 项 | 说明 | 处置 |
|---|---|---|
| 老用户默认行为变更 | 默认从并发变逐项，长文档整体耗时变长 | UI 明示"默认"+ 差异说明；用户可随时切回 |
| 必填校验按全量 scope | 单项重跑后若历史存在 idle 必填项会全局报 error（既有行为，暂停缺失使其罕见路径不变） | 不修，记录已知现状 |
| 多项目并行 | 两项目各跑一个 sequential 解析任务：槽位 `${projectId}:bid-analysis` 独立、queueScope 含 projectId，互不干扰；逐项反而降低全局队列压力 | 已审计证实，无需改动 |
| 逐项模式单项失败日志被下一条进度日志顶掉 | applyTaskPatch logs 为整体替换语义；单项错误已持久化于 bidAnalysisTasks[item].error 并由任务卡展示，信息损失是窗口期的 | 接受现状，记录 |
