# 招标文件解析执行模式（逐项/并发）设计文档

- 日期：2026-11-02
- 状态：待评审
- 分支：基于 `feature/multi-project-support`
- 审计：双独立子代理审计（代码事实核对 + 边界对抗），P0/P1 结论已吸收

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

`technical_plan_generation_config` 表新增列 `bid_analysis_execution_mode TEXT DEFAULT 'sequential'`。

### 2.2 触点清单（审计 D 项，白名单式存储，漏一处即静默失效）

| 层 | 文件 | 改动 |
|---|---|---|
| schema | `client/electron/services/sqliteDatabase.cjs` | 迁移中 `addColumnIfMissing(db, 'technical_plan_generation_config', 'bid_analysis_execution_mode', ...)`（机制参照既有 :1177-1183 用法） |
| store | `client/electron/services/technicalPlanStore.cjs` | 8 处：`initialState`（:62-97）、`createDefaultGenerationConfig`（:366-381）、`normalizeGenerationConfig`（:383-402）、`ensureGenerationConfigRow` INSERT（:685-721）、`loadGenerationConfig`（:740-769）、`writeGenerationConfig`（:771+）、`saveBidAnalysisConfig`（:2089-2096 解构加字段）、`loadTechnicalPlan` 映射（:1947-1966） |
| IPC 类型 | `client/src/shared/types/ipc.ts`（:799 saveBidAnalysisConfig 签名）+ preload 类型 | `executionMode?: 'sequential' | 'concurrent'` |
| 前端接线 | `client/src/hooks/useTechnicalPlanWorkflow.ts`（:14-15 默认值）、`TechnicalPlanHome.tsx`（:485-488 / :1124-1125 / :1137 状态合并） | 默认 `'sequential'` |

### 2.3 旧配置回退

老项目配置无此字段 → `loadState` 返回 undefined → **前端显式回退 `'sequential'`**（与后端 normalize 缺省一致）。新增列带 DEFAULT，旧行 SELECT 直接得默认值，无残留问题。

### 2.4 老用户行为变更明示

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
- 日志口径：分母 = 本轮 `tasksToRun.length`（续跑时正确），序号 = 本轮序号。`normalizeLogs` 只去重连续相同消息，20 条唯一进度日志无冲突（已审计）。

### 3.3 taskControl 解构

`runBidAnalysisTask` 签名（:273）增加解构 `taskControl`（runner 调用点 :927 已传入）。

### 3.4 前缀预热（warmPromptPrefix，:434-442）

两种模式都保留（逐项模式首项前预热一次、后续所有项共享前缀缓存，收益更大）。**修订**：`warmPromptPrefix` 调用传入 `signal: taskControl.signal`（promptPrefixCache.cjs:25 已支持 `signal?.throwIfAborted()`），取消时预热段不再空转刷噪音日志。

## 4. 前端设计（BidAnalysisPage.tsx）

### 4.1 设置弹窗（:702-833）

"解析范围" section（:768-787）之后新增"解析方式" section，参照 `bid-analysis-config-presets`（:722-741）双按钮风格：

- **逐项**（标"默认"）— 说明：解析项依次逐个进行，更稳更省；长文档分段提取仍并行
- **并发** — 说明：所有选中项同时解析，速度更快

配套：draft state（`draftExecutionMode`）+ `openSettingsDialog` 初始化 + 保存链路，模式与现有 draftSelectedTaskIds/draftBidSectionMode 一致。

### 4.2 持久化与下发

- `saveConfig`（:346）：`saveBidAnalysisConfig` 增加 `executionMode`，返回值（:357）同步携带
- `startBidAnalysisOnly`（:380-385）：payload 增加 `execution_mode: configState.executionMode`

### 4.3 文案与状态展示（三处 + chip）

| 位置 | 现状 | 改为 |
|---|---|---|
| :588 命令栏说明 | "并发解析招标文件，全部选中解析项结束后进入目录生成。" | 按当前配置动态："逐项解析招标文件，选中项依次完成后进入目录生成。" / "并发解析招标文件，全部选中解析项结束后进入目录生成。" |
| :696 任务列表提示 | "点击开始解析后，左侧任务会并发运行；…" | 按模式动态（"…左侧任务会依次运行…"） |
| :261-265 缓存优化提示 | 启发式：projectOverview running 且 doneCount===0 → "正在优化提示词缓存" | 逐项模式下跳过该启发式，直接显示当前解析项进度（3.2 的日志已提供） |
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

node:test 风格 + 全依赖注入 mock（aiService / workspaceStore / updateTask / checkpointTask / taskControl），与现有 4 个单测文件同跑法。注意：现有 4 文件均为多项目基建测试，本文件是首个任务执行类单测。

必测面：

1. normalize 边界：缺省 / 'concurrent' / 非法值 → sequential
2. sequential：执行顺序严格串行（mock aiService 断言调用时序）
3. sequential：单项失败继续下一项
4. sequential：signal.aborted → break，不再调用后续项
5. 三路径：空集 / 单项 / requestedTaskIds 单项重跑
6. concurrent 分支：行为与现状一致（Promise.all 全发）
7. 预热：两模式都调用 warmPromptPrefix，signal 已传入
8. 配置 round-trip：saveBidAnalysisConfig 带 executionMode → loadState 读回

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
