# 招标文件解析执行模式（逐项/并发）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 招标文件解析步骤新增"解析方式"选项 — 逐项（默认，依次逐个解析）/ 并发（现状，同时解析），随解析配置持久化。

**Architecture:** payload 新字段 `execution_mode` 贯通 IPC → taskService → runBidAnalysisTask，执行循环按模式分流（for...of 串行 / Promise.all 并发）；持久化走项目库列组健康检查（`projectSchemaColumnGroups`）+ store 白名单 8 处；前端设置弹窗加 preset 单选 + draft 接线（prop 同步 effect 模式）。spec：`docs/superpowers/specs/2026-11-02-bid-analysis-execution-mode-design.md`（已过三道审查，行号已逐项核实）。

**Tech Stack:** Electron + React + better-sqlite3 + node:test（electron-as-node 跑法）

**关键约束（来自 spec，违反即返工）：**
- `technical_plan_generation_config` 是**项目库**表 — 列注册**只能**走 `projectSchemaColumnGroups`，**禁止**动 `migrations[]`/`schemaVersion`（全局库 v37 已剔除三域表，bump 会把 v37 客户端挡在门外）
- 命名分界：DB 列 `bid_analysis_execution_mode` / payload `execution_mode`（snake）；store/状态/前端 `executionMode`（camel）— `updateGenerationConfig` 按 `Object.keys(current)` 合并，键名错 = 静默丢弃
- 不做暂停（无载体）；逐项循环只查 `taskControl.signal.aborted`
- `warmPromptPrefix` 保留两模式通用；调用处补传 signal
- 不碰：`getMissingRequiredTasks`、`doneProgress`、aiService 队列层、其他任务类型

**测试跑法（client/ 目录下，PowerShell）：**

```powershell
# 纯逻辑 + sqlite（本计划全部单测统一用 electron-as-node，因 better-sqlite3 是原生模块）
$env:ELECTRON_RUN_AS_NODE='1'; & ".\node_modules\electron\dist\electron.exe" --test test\bidAnalysisExecutionMode.test.cjs
```

先例与坑位（2026-10-30 verification :126-128 实证）：必须用 **env 变量** `ELECTRON_RUN_AS_NODE=1`，**不能**同时给 `--run-as-node` 标志（node 模式下 bad option）；env 能被 `--test` spawn 的子进程继承，标志不能。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `client/test/bidAnalysisExecutionMode.test.cjs` | 新建 | 执行模式单测 + P0 列守门 |
| `client/electron/services/bidAnalysisTask.cjs` | 修改 | 执行循环分流 + 取消检查 + 逐项日志 + 预热 signal |
| `client/electron/services/sqliteDatabase.cjs` | 修改 | `projectSchemaColumnGroups` 加 version 36 条目 |
| `client/electron/services/technicalPlanStore.cjs` | 修改 | 白名单 8 处加 `executionMode` |
| `client/src/features/technical-plan/types.ts` | 修改 | 类型 + 新类型导出 |
| `client/src/shared/types/ipc.ts` | 修改 | saveBidAnalysisConfig 签名 |
| `client/src/shared/analytics/analytics.ts` | 修改 | 埋点字段 ×2 行 |
| `client/src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts` | 修改 | initialState 默认值 |
| `client/src/features/technical-plan/pages/TechnicalPlanHome.tsx` | 修改 | props 下传（**注意**：:482-508 事件合并**无需改** — checkpoint partial 不携带 executionMode，`...prev` 自然保留；spec 保守列了此触点，实施时确认不改） |
| `client/src/features/technical-plan/pages/BidAnalysisPage.tsx` | 修改 | 设置弹窗 + draft + save/payload + 文案 + chip |

---

### Task 1: 后端执行循环 + 单测（TDD）

**Files:**
- Create: `client/test/bidAnalysisExecutionMode.test.cjs`
- Modify: `client/electron/services/bidAnalysisTask.cjs`（:273 签名 / :304 后插一行 / :435 预热 / :443 执行行）

- [ ] **Step 1: 写测试文件（完整内容）**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const Database = require('better-sqlite3');
const { ensureProjectSchemaHealth } = require('../electron/services/sqliteDatabase.cjs');
const { getBidAnalysisTasks, runBidAnalysisTask } = require('../electron/services/bidAnalysisTask.cjs');

function createHarness({ chatImpl } = {}) {
  const logs = [];
  const controller = new AbortController();
  const chatCalls = [];
  let active = 0;
  let maxActive = 0;
  const aiService = {
    getConfig: () => ({}),
    chat: async (options = {}) => {
      chatCalls.push(options);
      if (options.output_token_limit === 1) return ''; // 预热短请求
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return chatImpl ? await chatImpl(options) : '模拟解析结果';
      } finally {
        active -= 1;
      }
    },
  };
  const workspaceStore = {
    readTenderMarkdown: () => '模拟招标文件内容',
    loadTechnicalPlan: () => ({}),
  };
  const updateTask = (partial) => { if (partial?.logs?.length) logs.push(...partial.logs); };
  const checkpointTask = (partial) => { checkpoints.push(partial); };
  const checkpoints = [];
  const taskControl = { signal: controller.signal, isPauseRequested: () => false };
  return { aiService, workspaceStore, updateTask, checkpointTask, taskControl, controller, logs, checkpoints, chatCalls, get maxActive() { return maxActive; } };
}

async function runPayload(harness, payload) {
  await runBidAnalysisTask({
    aiService: harness.aiService,
    workspaceStore: harness.workspaceStore,
    updateTask: harness.updateTask,
    checkpointTask: harness.checkpointTask,
    taskControl: harness.taskControl,
    payload,
  });
}

const requiredTasks = getBidAnalysisTasks('key');
function realChatCount(harness) {
  return harness.chatCalls.filter((options) => options.output_token_limit !== 1).length;
}

test('默认（缺省 payload）逐项执行：maxActive 恒为 1，日志按序编号', async () => {
  const harness = createHarness({ chatImpl: async () => { await delay(20); return '模拟解析结果'; } });
  await runPayload(harness, {});
  assert.equal(harness.maxActive, 1);
  const progressLogs = harness.logs.filter((line) => line.startsWith('正在解析'));
  assert.equal(progressLogs.length, requiredTasks.length);
  requiredTasks.forEach((task, index) => {
    assert.ok(progressLogs[index].includes(task.label), `第${index + 1}条应为 ${task.label}：${progressLogs[index]}`);
    assert.ok(progressLogs[index].includes(`（${index + 1}/${requiredTasks.length}）`), progressLogs[index]);
  });
  const last = harness.checkpoints[harness.checkpoints.length - 1];
  assert.equal(last.status, 'success');
});

test('execution_mode=concurrent 保持并发（回归护栏）：maxActive > 1', async () => {
  const harness = createHarness({ chatImpl: async () => { await delay(20); return '模拟解析结果'; } });
  await runPayload(harness, { execution_mode: 'concurrent' });
  assert.ok(harness.maxActive > 1, `应为并发，实际 maxActive=${harness.maxActive}`);
  const last = harness.checkpoints[harness.checkpoints.length - 1];
  assert.equal(last.status, 'success');
});

test('非法 execution_mode 回落 sequential：maxActive 恒为 1', async () => {
  const harness = createHarness({ chatImpl: async () => { await delay(20); return '模拟解析结果'; } });
  await runPayload(harness, { execution_mode: 'banana' });
  assert.equal(harness.maxActive, 1);
});

test('逐项模式单项失败不阻塞：后续项照常执行，必填缺失落 error', async () => {
  const harness = createHarness({
    chatImpl: async () => {
      await delay(10);
      if (realChatCount(harness) === 2) throw new Error('模拟单项失败');
      return '模拟解析结果';
    },
  });
  await runPayload(harness, {});
  assert.ok(realChatCount(harness) >= requiredTasks.length, `失败后应继续，实际调用 ${realChatCount(harness)} 次`);
  const last = harness.checkpoints[harness.checkpoints.length - 1];
  assert.equal(last.status, 'error');
  assert.ok(String(last.error || '').includes('必填解析项未完成'), last.error);
});

test('逐项模式取消：第 1 项结束后 break，不再调用后续项', async () => {
  const harness = createHarness({
    chatImpl: async () => {
      await delay(10);
      harness.controller.abort();
      return '模拟解析结果';
    },
  });
  await runPayload(harness, {});
  assert.equal(realChatCount(harness), 1, `取消后应只跑 1 项，实际 ${realChatCount(harness)}`);
  const progressLogs = harness.logs.filter((line) => line.startsWith('正在解析'));
  assert.equal(progressLogs.length, 1);
});

test('取消发生在预热期：预热即中止，零真实请求', async () => {
  const harness = createHarness();
  harness.controller.abort();
  await assert.rejects(() => runPayload(harness, {}));
  assert.equal(realChatCount(harness), 0);
});

test('P0 守门：项目库健康检查补建 bid_analysis_execution_mode 列 + 默认值 sequential', () => {
  const db = new Database(':memory:');
  ensureProjectSchemaHealth(db);
  const col = db.prepare("SELECT name, dflt_value, [notnull] FROM pragma_table_info('technical_plan_generation_config') WHERE name = 'bid_analysis_execution_mode'").get();
  assert.ok(col, '列未注册到 projectSchemaColumnGroups（P0：列在项目库永远建不出来）');
  assert.equal(col.dflt_value, "'sequential'", `默认值应为 'sequential'，实际 ${col.dflt_value}`);
  assert.equal(col.notnull, 1, '应为 NOT NULL');
  db.close();
});
```

- [ ] **Step 2: 跑测试确认失败形态**

```powershell
cd client; $env:ELECTRON_RUN_AS_NODE='1'; & ".\node_modules\electron\dist\electron.exe" --test test\bidAnalysisExecutionMode.test.cjs
```

预期：**FAIL**（红）— 逐项顺序（缺省 payload 现状走并发 → maxActive>1）、逐项取消（无项间检查 → realChatCount=全部）、预热期取消（signal 未传 → 不中止）、P0 守门（列未注册）。**PASS（现状即绿，回归护栏）** — 并发护栏、单项失败继续（runOneSafely 现有语义）、非法值回落（现状并发 maxActive>1 ≠ 1 → 此条实际也红：非法值回落测试断言 maxActive===1，现状 maxActive>1 → FAIL，归入红组）。

- [ ] **Step 3: 实现 bidAnalysisTask.cjs（4 处修改）**

3a. `:273` 签名加 `taskControl`：

```js
async function runBidAnalysisTask({ aiService, workspaceStore, updateTask, checkpointTask, taskControl, payload }) {
```

3b. `:304`（`const forceRerun = ...` 行）之后插一行：

```js
  const executionMode = payload.execution_mode === 'concurrent' ? 'concurrent' : 'sequential';
```

3c. `:435` warmPromptPrefix 调用加 signal（`aiService,` 行后插 `signal: taskControl?.signal,`）：

```js
    await Promise.all(fileSegments.map((segment, index) => warmPromptPrefix({
      aiService,
      signal: taskControl?.signal,
      messages: buildTenderContextMessages(segment, sectionHint),
```

（后续 logTitle/label/onActivity 行原样保留。）

3d. `:443` 单行 `await Promise.all(tasksToRun.map(runOneSafely));` 替换为：

```js
  // 逐项模式：一项结束后再启动下一项；取消（项目删除/重置/招标文件更新）在项间生效。
  if (executionMode === 'concurrent') {
    await Promise.all(tasksToRun.map(runOneSafely));
  } else {
    let index = 0;
    for (const task of tasksToRun) {
      if (taskControl?.signal?.aborted) break;
      index += 1;
      updateTask({ status: 'running', logs: [`正在解析 ${task.label}（${index}/${tasksToRun.length}）`] });
      await runOneSafely(task);
    }
  }
```

- [ ] **Step 4: 跑测试确认（除 P0 守门外）通过**

同 Step 2 命令。预期：6 个执行行为测试 PASS；P0 守门测试仍 FAIL（列未注册 — Task 2 实现）。注意：多数用例含 1.5s 预热 settle，套件总时长 ~8-10s 属预期。

- [ ] **Step 5: Commit**

```powershell
git add client/test/bidAnalysisExecutionMode.test.cjs client/electron/services/bidAnalysisTask.cjs
git commit -m "feat: 招标解析执行模式 execution_mode（逐项默认/并发）+ 项间取消 + 预热传 signal"
```

---

### Task 2: schema 列组注册 + store 白名单 8 处（TDD，修复 P0 守门测试）

**Files:**
- Modify: `client/electron/services/sqliteDatabase.cjs:1541-1547`（layout_check 条目后）
- Modify: `client/electron/services/technicalPlanStore.cjs`（8 处，行号见步骤）
- Test: `client/test/bidAnalysisExecutionMode.test.cjs`（Task 1 的 P0 守门用例）

- [ ] **Step 1: 跑 P0 守门测试确认仍失败**

同 Task 1 Step 2 命令（可用 `--test-name-pattern` 过滤 `'P0 守门'` 加速）。预期 FAIL：列缺失。

- [ ] **Step 2: sqliteDatabase.cjs 加列组条目**

`:1541-1547` layout_check 条目（`version: 35`）之后、数组闭括号 `];`（:1548）之前插入：

```js
  {
    version: 36,
    table: 'technical_plan_generation_config',
    columns: {
      bid_analysis_execution_mode: "TEXT NOT NULL DEFAULT 'sequential'",
    },
  },
```

- [ ] **Step 3: technicalPlanStore.cjs 8 处白名单**

| # | 锚点 | 改动 |
|---|---|---|
| 1 | `:73` `bidSectionMode: 'single',`（initialState） | 后插 `  executionMode: 'sequential',` |
| 2 | `:371` `bidSectionMode: 'single',`（createDefaultGenerationConfig） | 后插 `    executionMode: 'sequential',`（注意此函数体缩进 4 空格） |
| 3 | `:390` `bidSectionMode: normalizeBidSectionMode(source.bidSectionMode),`（normalizeGenerationConfig） | 后插 `    executionMode: source.executionMode === 'concurrent' ? 'concurrent' : 'sequential',` |
| 4 | `:685-698` INSERT：列清单 `bid_section_mode,` 后加 `bid_analysis_execution_mode,`；VALUES `@bid_section_mode,` 后加 `@bid_analysis_execution_mode,`；`:701` 参数 `bid_section_mode: defaults.bidSectionMode,` 后加 `      bid_analysis_execution_mode: defaults.executionMode,` |
| 5 | `:745` `bidSectionMode: row.bid_section_mode,`（loadGenerationConfig） | 后插 `      executionMode: row.bid_analysis_execution_mode,` |
| 6 | `:779` UPDATE SET `bid_section_mode = @bid_section_mode,` 后加 `        bid_analysis_execution_mode = @bid_analysis_execution_mode,`；`:801` 参数区 `bid_section_mode: normalized.bidSectionMode,` 后加 `      bid_analysis_execution_mode: normalized.executionMode,` |
| 7 | `:2089` `function saveBidAnalysisConfig({ mode, selectedTaskIds, bidSectionMode } = {})` | 改为 `function saveBidAnalysisConfig({ mode, selectedTaskIds, bidSectionMode, executionMode } = {})`；`:2094` 条件展开后加一行 `      ...(executionMode === undefined ? {} : { executionMode }),` |
| 8 | `:1959` `bidSectionMode: generationConfig.bidSectionMode,`（loadTechnicalPlan） | 后插 `      executionMode: generationConfig.executionMode,` |

- [ ] **Step 4: 跑全部单测确认通过**

同 Task 1 Step 2 命令。预期 **7/7 PASS**。

- [ ] **Step 5: Commit**

```powershell
git add client/electron/services/sqliteDatabase.cjs client/electron/services/technicalPlanStore.cjs
git commit -m "feat: executionMode 持久化 — 项目库列组 version 36 + store 白名单 8 处"
```

---

### Task 3: TS 类型 + ipc 签名 + 埋点 + 前端状态接线

**Files:**
- Modify: `client/src/features/technical-plan/types.ts:60-72`（接口）与 `:339-350`（TechnicalPlanState）
- Modify: `client/src/shared/types/ipc.ts:799`
- Modify: `client/src/shared/analytics/analytics.ts:26` 与 `:48`
- Modify: `client/src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts:18`
- Modify: `client/src/features/technical-plan/pages/TechnicalPlanHome.tsx:1126`

- [ ] **Step 1: types.ts**

1a. `:60` `export interface TechnicalPlanGenerationConfig {` 之前插：

```ts
export type BidAnalysisExecutionMode = 'sequential' | 'concurrent';
```

1b. 接口内 `:63` `bidSectionMode: BidSectionMode;` 后插 `  executionMode: BidAnalysisExecutionMode;`

1c. `TechnicalPlanState`（:339 起）内 `:350` `bidSectionMode: BidSectionMode;` 后插 `  executionMode: BidAnalysisExecutionMode;`

- [ ] **Step 2: ipc.ts**

`:799` 签名加字段（若 BidAnalysisMode/BidSectionMode 为具名 import，同步把 `BidAnalysisExecutionMode` 加入同一 import）：

```ts
    saveBidAnalysisConfig: (payload: { mode: BidAnalysisMode; selectedTaskIds: string[]; bidSectionMode?: BidSectionMode; executionMode?: BidAnalysisExecutionMode }) => Promise<void>;
```

- [ ] **Step 3: analytics.ts**

`:26` `bid_analysis_mode?: string;` 后插 `  bid_analysis_execution_mode?: string;`
`:48` `['bid_analysis_mode', 'bidAnalysisModes'],` 后插 `  ['bid_analysis_execution_mode', 'bidAnalysisExecutionModes'],`

- [ ] **Step 4: useTechnicalPlanWorkflow.ts**

`:18` `bidSectionMode: 'single',` 后插 `  executionMode: 'sequential',`（前端旧缓存无此字段 → initialState 默认兜底，cachedState 展开覆盖语义不变）

（TechnicalPlanHome props 下传与 BidAnalysisPage 消费放 Task 4 同 commit — props 设为必传后两者必须同时改才能过 tsc。:482-508 事件合并**不改**：checkpoint partial 不携带 executionMode，`...prev` 自然保留。）

- [ ] **Step 5: Commit（types/ipc/analytics/workflow 四文件，此时不跑 tsc — Task 4 末统一跑）**

```powershell
git add client/src/features/technical-plan/types.ts client/src/shared/types/ipc.ts client/src/shared/analytics/analytics.ts client/src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts
git commit -m "feat: executionMode 类型定义 + IPC 签名 + 埋点字段 + 前端默认值"
```

---

### Task 4: BidAnalysisPage 交互接线 + 设置弹窗 UI

**Files:**
- Modify: `client/src/features/technical-plan/pages/BidAnalysisPage.tsx`（props :9-26 / draft :225 / effects :310-344 / saveConfig :346-358 / 启动 :380-386 / 弹窗 :787 后 / 文案 :588,:696 / 状态 :261-276）
- Modify: `client/src/features/technical-plan/pages/TechnicalPlanHome.tsx:1126`

- [ ] **Step 1: props 与类型**

`:14` `bidSectionMode: BidAnalysisMode;` 所在 props 接口 — `bidSectionMode: BidSectionMode;`（:14）后插 `  executionMode: BidAnalysisExecutionMode;`；页面顶部 type import（来自 `'../types'`）加入 `BidAnalysisExecutionMode`。

- [ ] **Step 2: draft 状态（draftBidSectionMode 同款三处接线）**

2a. `:225` `const [draftBidSectionMode, setDraftBidSectionMode] = useState<BidSectionMode>(bidSectionMode);` 后插：

```tsx
  const [draftExecutionMode, setDraftExecutionMode] = useState<BidAnalysisExecutionMode>(executionMode);
```

2b. `:310-312` 既有 prop 同步 effect 后插（**钉死用此模式，防跨项目脏值**）：

```tsx
  useEffect(() => {
    setDraftExecutionMode(executionMode);
  }, [executionMode]);
```

2c. `:327-334` settingsOpen 初始化 effect 内加 `setDraftExecutionMode(executionMode);`，依赖数组加 `executionMode`。

2d. `openSettingsDialog`（:341-342）加 `setDraftExecutionMode(executionMode);`。

- [ ] **Step 3: saveConfig 与启动 payload**

3a. `:346` 签名改为：

```tsx
  const saveConfig = async (nextTaskIds = draftSelectedTaskIds, closeDialog = true, nextBidSectionMode = draftBidSectionMode, nextExecutionMode = draftExecutionMode) => {
```

3b. `:349` saveBidAnalysisConfig 调用 payload 加 `executionMode: nextExecutionMode`。

3c. `:357` 返回对象加 `executionMode: nextExecutionMode`。

3d. `:380-385` startBidAnalysis 的 payload 加 `execution_mode: configState.executionMode,`。

3e. `:386` 埋点改为 `trackConfigUsage({ bid_analysis_mode: configState.mode, bid_analysis_execution_mode: configState.executionMode }, config);`

- [ ] **Step 4: TechnicalPlanHome props**

`:1126` `bidSectionMode={state.bidSectionMode}` 后插 `executionMode={state.executionMode}`（从 Task 3 移入）。

- [ ] **Step 5: 设置弹窗"解析方式" section**

`:787` "解析范围" section 的 `</section>` 之后插入（结构与相邻 section 完全同构，无新 CSS）：

```tsx
              <section className="bid-analysis-config-section is-compact">
                <div className="bid-analysis-config-section-head">
                  <strong>解析方式</strong>
                  <span>{draftExecutionMode === 'sequential' ? '依次进行' : '同时进行'}</span>
                </div>
                <div className="bid-analysis-config-presets" role="group" aria-label="解析方式">
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftExecutionMode === 'sequential' ? ' is-active' : ''}`}
                    onClick={() => setDraftExecutionMode('sequential')}
                    disabled={taskRunning}
                  >
                    <span>逐项</span>
                    <small>默认</small>
                  </button>
                  <button
                    type="button"
                    className={`bid-analysis-config-preset${draftExecutionMode === 'concurrent' ? ' is-active' : ''}`}
                    onClick={() => setDraftExecutionMode('concurrent')}
                    disabled={taskRunning}
                  >
                    <span>并发</span>
                    <small>更快</small>
                  </button>
                </div>
              </section>
```

- [ ] **Step 6: 动态文案三处 + chip + 进度消息**

6a. `:588` 替换为：

```tsx
          <p>{executionMode === 'sequential' ? '逐项解析招标文件，选中解析项依次完成后进入目录生成。' : '并发解析招标文件，全部选中解析项结束后进入目录生成。'}</p>
```

6b. `:696` 替换为：

```tsx
              <p>{activeTaskStatus === 'idle'
                ? (executionMode === 'sequential'
                  ? '点击开始解析后，左侧任务会依次逐个运行（长文档分段提取仍并行）；选择任一任务查看实时输出。'
                  : '点击开始解析后，左侧任务会并发运行；选择任一任务查看实时输出。')
                : '正在等待模型返回内容。'}</p>
```

6c. `:261-265` isPromptCacheOptimizing 条件末尾加 `&& executionMode === 'concurrent'`（逐项模式跳过启发式）。

6d. `:266` progressMessage 之前加取日志末条，并给 progressMessage 加首分支：

```tsx
  const latestLog = task?.logs?.[task.logs.length - 1] || '';
  const progressMessage = isPromptCacheOptimizing
    ? '正在优化提示词缓存'
    : taskRunning && executionMode === 'sequential' && latestLog
      ? latestLog
      : requiredDone && taskRunning
        ? '关键项已解析完成，等待当前解析任务结束后进入下一步。'
        : firstMissingSelectedTask
          ? `${firstMissingSelectedTask.label}未提取到有效内容，请重新解析该项。`
        : requiredDone ? '招标文件解析任务已结束，可以进入下一步。' : '等待关键解析项完成';
```

（即原 `:266-272` 整体替换为上式 — 原链不变，只插了 latestLog 一个分支。）

6e. `:276` configLabel 追加模式：

```tsx
  const configLabel = `${bidSectionConfigLabel} · ${getModeLabel(mode)} · ${executionMode === 'sequential' ? '逐项' : '并发'}`;
```

- [ ] **Step 7: 类型检查**

```powershell
cd client; npx tsc --noEmit
```

预期：无错误。

- [ ] **Step 8: Commit**

```powershell
git add client/src/features/technical-plan/pages/BidAnalysisPage.tsx client/src/features/technical-plan/pages/TechnicalPlanHome.tsx
git commit -m "feat: 解析设置弹窗新增解析方式（逐项/并发）+ 全链路接线 + 动态文案"
```

---

### Task 5: 全量回归 + 真机验证

**Files:**
- Test: 全部既有单测 + 新单测
- Create: `docs/superpowers/plans/2026-11-02-bid-analysis-execution-mode-verification.md`

- [ ] **Step 1: 单测全量回归**

```powershell
cd client
$env:ELECTRON_RUN_AS_NODE='1'; & ".\node_modules\electron\dist\electron.exe" --test test\projectStoreRegistry.test.cjs test\projectMigration.test.cjs test\projectRegistry.test.cjs test\bidAnalysisExecutionMode.test.cjs
node --test test\projectKeys.test.cjs
```

预期：旧 17 用例 + 新 7 用例全绿（bidAnalysisExecutionMode 必须用 electron-as-node 跑，projectKeys 用纯 node）。

- [ ] **Step 2: 真机逐项验证**

dev 启动（`cd client; npm run dev`，另开终端或 CDP `--remote-debugging-port=9222`）：
1. 打开任一项目 → 向导第 3 步：命令栏文案含"依次"、chip 含"逐项"
2. 设置弹窗：解析方式默认高亮"逐项"；切"并发"保存 → 重新打开弹窗仍"并发"（持久化生效）；切回"逐项"保存
3. 点开始解析（逐项）：进度消息逐项推进（"正在解析 X（i/N）"），左侧任务卡一个 running → success 依次进行
4. 中途关闭应用模拟中断 → 重开 → 点开始 → 只跑未完成项（续跑验证）

- [ ] **Step 3: 真机并发放障验证**

设置切"并发" → 开始解析 → 任务卡同时多个 running（与改造前行为一致）。

- [ ] **Step 4: 写验证记录 + 更新 spec 状态**

新建 `docs/superpowers/plans/2026-11-02-bid-analysis-execution-mode-verification.md`（实测结果 + 截图/日志路径）；spec 头部 `状态：待评审` 改 `已实施`。

- [ ] **Step 5: Commit**

```powershell
git add docs/superpowers/plans/2026-11-02-bid-analysis-execution-mode-verification.md docs/superpowers/specs/2026-11-02-bid-analysis-execution-mode-design.md
git commit -m "docs: 执行模式验证记录（真机逐项/并发/续跑）"
```

---

## 风险与回滚

- 列组健康检查对已有项目库幂等（存在即跳过），无迁移风险
- 单测 P0 守门用例是列注册正确性的永久防线（列丢 → 立即红）
- 全部改动集中在 bid-analysis 链路，回滚 = revert 本计划 commits
