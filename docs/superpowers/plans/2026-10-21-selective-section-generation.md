# 易标正文生成支持指定小节（targetItemIds）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正文编辑页可勾选 AI 叶子小节，"生成所选 N 节"只生成勾选节并跳过全文后处理；分轮跑完全部叶子后提供"运行全文检查与优化"补跑入口。

**Architecture:** payload 新增 `targetItemIds`（复数数组）走现有全量生成管线，在 `tasksToRun` 构建后做清单交集过滤；勾选清单与跳过标志持久化到 `contentGenerationRuntime`（continuing 恢复）；Agent 层 `skipPostStages` 在 generating 完成点返回 `{complete:true}` 结束后处理链；补跑入口 `postProcessOnly` 利用 Agent stage 恢复机制直接从 auditing 进入。

**Tech Stack:** Electron 41 + React 19 + TypeScript + Vite（前端），CommonJS .cjs 服务（main 进程），electron-builder 打包（win zip/nsis）。

**设计文档：** `docs/superpowers/specs/2026-10-21-selective-section-generation-design.md`（本计划的唯一需求来源，实施前必读）

**⚠️ 测试策略说明：** 本项目**无测试框架**（package.json 无 test script，无 jest/vitest 依赖）。遵循现有项目模式，不为此功能引入测试框架。每个任务的验证手段：
1. `npm run build`（= `tsc --noEmit && vite build`，类型检查 + 构建双关卡）
2. 后端纯函数用 `node -e` 冒烟（见各任务）
3. Task 12 为集中 dev 模式功能验证（设计文档 §4 验证计划逐项）

**工作目录：** 所有命令在 `D:\Neo\Neo\tmp\OpenBidKit_Yibiao\client` 执行（下称 `client/`）。分支 `feature/selective-section-generation`。

---

### Task 1: 环境搭建与基线构建

**Files:** 无代码改动

- [ ] **Step 1: 安装依赖**

```powershell
cd D:\Neo\Neo\tmp\OpenBidKit_Yibiao\client
npm install
```

Expected: 成功完成。postinstall 自动执行 `patch-package` 与 `electron-builder install-app-deps`（better-sqlite3 native 编译）。若 native 编译失败，检查 Node 版本与 node-gyp 环境，勿跳过。

- [ ] **Step 2: 基线构建**

```powershell
npm run build
```

Expected: tsc 零错误，vite build 产出 `dist/`。此为改动前基线——若基线即失败，先停下报告，不要在坏基线上开发。

- [ ] **Step 3: dev 模式冒烟（可选但推荐）**

```powershell
npm run dev
```

Expected: Vite 5173 端口 + Electron 窗口启动，正文页正常渲染。确认后关闭。配置沿用 `%APPDATA%\yibiao-client\user_config.json`（智谱 glm-5.3 已配好）。

---

### Task 2: runtime 白名单扩展与 targetItemIds 解析/恢复

**Files:**
- Modify: `client/electron/services/contentGenerationTask.cjs:1070-1085`（normalizeContentGenerationRuntime）
- Modify: `client/electron/services/contentGenerationTask.cjs:1441-1447`（runContentGenerationTask 解析区）

- [ ] **Step 1: 扩展 normalizeContentGenerationRuntime 白名单**

在 1080-1081 行 `target_item_id` / `regenerate_requirement` 之间插入两行：

```js
    target_item_id: String(source.target_item_id || '').trim(),
    target_item_ids: normalizeStringArray(source.target_item_ids),
    skip_post_stages: Boolean(source.skip_post_stages),
    regenerate_requirement: String(source.regenerate_requirement || '').trim(),
```

- [ ] **Step 2: 解析区新增 targetItemIds 与恢复逻辑**

在 1441 行 `const regenerate = ...` 之前插入（contentRuntime 已于 1434 行 normalize 完成，可安全读取）：

```js
  const payloadTargetItemIds = Array.isArray(payload.targetItemIds)
    ? [...new Set(payload.targetItemIds.map((id) => String(id || '').trim()).filter(Boolean))] : [];
  // 恢复条件用 continuing（resume 与 retryFailedSections 都算），防止勾选轮失败重试膨胀为全量并误入后处理。
  const targetItemIds = continuing ? contentRuntime.target_item_ids : payloadTargetItemIds;
  const skipPostStages = continuing ? contentRuntime.skip_post_stages : payloadTargetItemIds.length > 0;
```

- [ ] **Step 3: regenerate 组合守卫**

修改 1441 行（勾选轮压制 regenerate——勾选即明确本轮范围）：

```js
  const regenerate = !resume && !retryContentCorrection && !retryFailedSections && Boolean(payload.regenerate) && !targetItemIds.length;
```

- [ ] **Step 4: runtime 落库前写入两字段**

找到 1504-1508 行的 `contentRuntime = normalizeContentGenerationRuntime({...contentRuntime, target_item_id: targetItemId, regenerate_requirement: regenerateRequirement})`，改为（全量轮 targetItemIds 为空数组、skipPostStages 为 false，自动清空 ✓）：

```js
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    target_item_ids: targetItemIds,
    skip_post_stages: skipPostStages,
    regenerate_requirement: regenerateRequirement,
  });
```

检查 1554-1558 行若存在第二次同构 normalize：`...contentRuntime` 展开已含两字段且白名单已扩展，无需重复添加；确认该处未覆盖即可。

- [ ] **Step 5: 冒烟验证 normalize**

```powershell
node -e "const m = require('./electron/services/taskService.cjs'); console.log('taskService loaded:', typeof m)"
```

Expected: 正常输出（语法无错）。normalize 函数未导出，其行为在 Task 12 dev 验证覆盖。

- [ ] **Step 6: 构建**

```powershell
npm run build
```

Expected: 通过。

- [ ] **Step 7: Commit**

```powershell
git add electron/services/contentGenerationTask.cjs
git commit -m "feat: contentRuntime 扩展 target_item_ids/skip_post_stages 字段与 payload 解析恢复"
```

---

### Task 3: taskService 早返回排除

**Files:**
- Modify: `client/electron/services/taskService.cjs:1484-1490`

- [ ] **Step 1: 早返回条件排除勾选轮**

1484-1486 行条件追加 targetItemIds 排除（否则全 success 文档勾选重生成被"已有结果直接返回"拦截）：

```js
      if (!sectionRegeneration && !continuing && !taskPayload?.regenerate
        && !taskPayload?.targetItemIds?.length
        && technicalPlan.contentGenerationTask?.status === 'success'
        && !hasPendingSections(technicalPlan.outlineData?.outline || [])) {
```

- [ ] **Step 2: 构建 + Commit**

```powershell
npm run build
git add electron/services/taskService.cjs
git commit -m "feat: startContentGeneration 早返回排除勾选生成轮"
```

---

### Task 4: tasksToRun 清单过滤与图片名额本轮限定

**Files:**
- Modify: `client/electron/services/contentGenerationTask.cjs:1549-1552`（之后插入过滤）
- Modify: `client/electron/services/contentGenerationTask.cjs:393-399`（selectContentImageTargets）
- Modify: `client/electron/services/contentGenerationTask.cjs:2152`（persistContentPlans 调用处）

- [ ] **Step 1: 插入清单过滤（必须在 1552 行 pending 过滤之后）**

1549-1552 行 `if (!fullRegenerate && !targetItemId && contentRuntime.pending_item_ids.length) {...}` 之后插入：

```js
  if (targetItemIds.length) {
    const idSet = new Set(targetItemIds);
    // 新轮以全集为基准（支持勾选已 success 节重生成——tasksToRun 默认只含非 success 节，直接交集会空集抛错）；
    // 继续/重试轮与待生成清单取交集（限定 resume/retry 范围）。
    const base = continuing ? tasksToRun : leaves;
    tasksToRun = base.filter(({ item }) => idSet.has(item.id));
    if (!tasksToRun.length) {
      throw new Error('所选小节均不是待生成的 AI 正文小节');
    }
  }
```

⚠️ 位置不可提前：若插在 1517 行后，1549 行 pending 交集会削减勾选集（大纲新增叶场景下可能清空并落入"无待生成"静默成功）。

- [ ] **Step 2: selectContentImageTargets 支持本轮 scope 与小批量保底**

393-399 行函数改为（勾选轮小批量 floor 会得 0，用 ceil 保底 1；全量轮 floor 行为不变）：

```js
// 按全文 AI 小节数确定配图名额；稳定排序保留同分小节的目录顺序，0 分不入选。
// 勾选轮（partialScope）名额基数与候选池均为本轮目标：小批量取 ceil 并保底 1，历史轮标记不参与本轮名额结算。
function selectContentImageTargets(leaves, plans, imageQuantity, partialScope = false) {
  const limit = partialScope && imageQuantity > 0
    ? Math.max(1, Math.ceil(leaves.length * imageQuantity / 100))
    : Math.floor(leaves.length * imageQuantity / 100);
  const candidates = leaves
    .filter(({ item }) => plans[item.id]?.plan?.image_suitability_score > 0)
    .sort((left, right) => plans[right.item.id].plan.image_suitability_score - plans[left.item.id].plan.image_suitability_score);
  return new Set(candidates.slice(0, limit).map(({ item }) => item.id));
}
```

- [ ] **Step 3: persistContentPlans 调用处传入本轮 scope**

2152 行改为（`targets` 是 persistContentPlans 的入参即本轮目标，闭包内 `targetItemIds` 可见）：

```js
    const imageScopeLeaves = targetItemIds.length ? targets : leaves;
    const selectedImageIds = selectContentImageTargets(imageScopeLeaves, nextPlans, imageQuantity, Boolean(targetItemIds.length));
```

- [ ] **Step 4: 构建 + Commit**

```powershell
npm run build
git add electron/services/contentGenerationTask.cjs
git commit -m "feat: tasksToRun 勾选清单过滤与配图名额本轮结算"
```

---

### Task 5: Agent 层跳过全文后处理

**Files:**
- Modify: `client/electron/services/contentGenerationAgent.cjs:514-516`（runContentGenerationAgent 签名）
- Modify: `client/electron/services/contentGenerationAgent.cjs:792-813`（continueTask 推进点）
- Modify: `client/electron/services/contentGenerationTask.cjs`（runContentGenerationAgent 调用处，约 2380-2400 区域搜 `runContentGenerationAgent({`）

- [ ] **Step 1: 函数签名加参数**

516 行参数列表 `...failTask = () => {}` 之前加：

```js
  onWordAdjustProgress = () => {}, onConsistencyProgress = () => {}, onTableCleanupProgress = () => {}, onWorkspaceReady = () => {}, failTask = () => {}, skipPostStages = false }) {
```

- [ ] **Step 2: continueTask 推进点短路**

792 行 `const startAudit = () => {` 之前插入（layout/table/consistency 分支在前，勾选轮这些 state 恒不存在，自然落到此处）：

```js
      // 勾选轮跳过字数校正与全文后处理，直接结束 Agent 任务，外层进入 Word 转换。
      if (skipPostStages) {
        onActivity?.({ message: '本轮为勾选生成，跳过字数校正与全文后处理（一致性审计、表格清理、格式自检）。' });
        return { complete: true };
      }
```

`{ complete: true }` 结束契约依据：pi/piRuntimeService.cjs:1172（`complete===true` 正常 resolve），finishLayout（contentGenerationAgent.cjs:651/660）已有先例。

- [ ] **Step 3: 调用处传参**

contentGenerationTask.cjs 中搜 `runContentGenerationAgent({`，在参数对象中（`failTask` 附近）加：

```js
    skipPostStages,
```

（闭包变量，Task 2 已定义。）

- [ ] **Step 4: 构建 + Commit**

```powershell
npm run build
git add electron/services/contentGenerationAgent.cjs electron/services/contentGenerationTask.cjs
git commit -m "feat: 勾选轮跳过字数校正与全文后处理"
```

---

### Task 6: 后处理补跑入口（postProcessOnly）

**Files:**
- Modify: `client/electron/services/taskService.cjs:1484-1490`（早返回排除）
- Modify: `client/electron/services/contentGenerationTask.cjs`（解析区 1441 后 + 外层挂接点 2621 + Agent 调用处 + 收尾 stats）
- Modify: `client/electron/services/contentGenerationAgent.cjs`（签名 + 612 行后覆盖块 + 673/674/686/691 四处 resuming 等同）

- [ ] **Step 1: taskService 早返回排除 postProcessOnly**

Task 3 已改的条件再追加（补跑恰要在"全 success 无 pending"状态启动）：

```js
      if (!sectionRegeneration && !continuing && !taskPayload?.regenerate
        && !taskPayload?.targetItemIds?.length && !taskPayload?.postProcessOnly
        && technicalPlan.contentGenerationTask?.status === 'success'
```

- [ ] **Step 2: contentGenerationTask 解析 postProcessOnly 并收口 effective 变量**

Task 2 解析区（`skipPostStages` 定义处）改造为 effective 形态（补跑强制走完整后处理链）：

```js
  const postProcessOnly = !resume && !retryFailedSections && Boolean(payload.postProcessOnly);
  const effectiveTargetItemIds = postProcessOnly ? [] : (continuing ? contentRuntime.target_item_ids : payloadTargetItemIds);
  const effectiveSkipPostStages = postProcessOnly ? false : (continuing ? contentRuntime.skip_post_stages : payloadTargetItemIds.length > 0);
```

删除 Task 2 的 `const targetItemIds = ...` / `const skipPostStages = ...` 两个定义，后续 Tasks 2/4/5 引用处全部改用 `effectiveTargetItemIds` / `effectiveSkipPostStages`（本任务统一收口，避免旧名残留）。Task 4 的过滤块、Task 5 的传参同步改名。

- [ ] **Step 3: 外层挂接点——2621 行后处理先例分支**

2620-2624 行改为（**这是无正文目标跑后处理 Agent 的唯一正确入口**——`runContentGeneration([])` 先例；不可走 2637 门之后，那里是直接收尾 done）：

```js
  try {
    if (postProcessOnly || continuingConsistency || continuingTableCleanup || continuingLayout) {
      await runContentGeneration([]);
      return;
    }
```

- [ ] **Step 4: Agent 层——签名、覆盖块、四处 resuming 等同**

(a) runContentGenerationAgent 签名再加 `postProcessOnly = false`（紧邻 skipPostStages）。

(b) 612 行 `const createAuditState = ...` 定义之后、672 行 onActivity 之前插入（createAuditState 是 const 箭头函数不提升，必须定义后调用；531 行 stage 初始化先算出旧值，此处覆盖）：

```js
  // 补跑入口：无正文生成阶段，直接从一致性审计进入，复用完整后处理链。
  if (postProcessOnly && !consistencyState) {
    consistencyState = createAuditState();
    stage = 'auditing';
  }
```

(c) **四处 resuming 等同改造**（postProcessOnly 是新轮非 resume，但不重建输入、不清产物、不清阶段状态——审计依赖上轮工作区与台账）：

673 行：
```js
  const files = planning ? planning.files : (resuming || postProcessOnly) ? [] : await prepareFiles(localContext);
```
674 行：
```js
  if (!planning && !resuming && !postProcessOnly) prepareRunSummary(files);
```
686 行：
```js
  if (reuseSession && !resuming && !postProcessOnly) clearTaskArtifacts(localContext.workspace_dir);
```
691-692 行（updatePersistentTask 的清空字段）：
```js
    ...(!resuming && !postProcessOnly ? { word_adjustment_started: false, word_adjust: null, consistency: null, table_cleanup: null, layout_check: null } : {}),
    ...(!resuming && !postProcessOnly && !continuingPlanning ? { prompted_stage: null, compaction_pending: null } : {}),
```

改后自动正确之处（无需改动，核对即可）：695 行 `stage === 'auditing'` 触发 extractLedger 补台账；702 行 prompt 选择走 consistencyPrompt；743 行 initializeContent 用上轮 decisions.targets 建图片保护（`consistencyState` 分支给 CONSISTENCY_TOOLS）；700 行 runTask 以 reuseSession resume 模式续会话。

(d) 2389 行 runContentGenerationAgent 调用处参数加 `postProcessOnly,`（紧邻 `skipPostStages`）。

- [ ] **Step 5: contentStats 暴露后处理完成标志**

外层任务 success 收尾处（2663 行 `contentStats.phase = 'done'` 附近）加：

```js
  contentStats.post_process_completed = postProcessOnly || !effectiveSkipPostStages;
```

语义：全量/补跑轮=true；勾选轮=false。置于 statsSnapshot() 最后一次调用之前，确保落库。

- [ ] **Step 6: 构建 + node 冒烟 + Commit**

```powershell
npm run build
node -e "require('./electron/services/taskService.cjs'); require('./electron/services/contentGenerationAgent.cjs'); console.log('syntax ok')"
git add electron/services/taskService.cjs electron/services/contentGenerationTask.cjs electron/services/contentGenerationAgent.cjs
git commit -m "feat: postProcessOnly 后处理补跑入口（复用审计链与上轮工作区）"
```

---

### Task 7: 前端复选状态与节列表复选框

**Files:**
- Modify: `client/src/features/technical-plan/pages/ContentEditPage.tsx`（state 区约 201 行附近 + renderTree 717-781）

- [ ] **Step 1: 添加勾选状态**

201 行 `requirementItem` state 附近加：

```tsx
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const selectedCount = selectedItemIds.size;
  const toggleSelectedItem = (id: string) => {
    setSelectedItemIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
```

- [ ] **Step 2: renderTree AI 叶子行加复选框**

726-737 行 `<button ... content-outline-item` 内、`<span className="content-outline-dot"` 之前插入：

```tsx
          {isLeaf && item.content_mode === 'ai-generate' && (
            <input
              type="checkbox"
              className="content-outline-select"
              checked={selectedItemIds.has(item.id)}
              disabled={taskBlocksGeneration}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggleSelectedItem(item.id)}
              aria-label={`选择小节 ${item.number} ${item.title}`}
            />
          )}
```

- [ ] **Step 3: 构建 + Commit**

```powershell
npm run build
git add src/features/technical-plan/pages/ContentEditPage.tsx
git commit -m "feat: 正文目录 AI 叶子小节复选框"
```

---

### Task 8: 启动链携带勾选清单（含并发弹窗与确认弹窗）

**Files:**
- Modify: `client/src/features/technical-plan/pages/ContentEditPage.tsx:560-625`（launchContentGeneration/startGeneration）、381-403（generationButtonLabel）、主按钮 onClick、947-958（并发弹窗）

- [ ] **Step 1: 组件层定义选择派生量（作用域关键）**

`selectedCount`（Task 7 已定义）旁、组件渲染逻辑区（约 240 行 `taskBlocksGeneration` 之后任意位置，须在 launchContentGeneration 与 startGeneration 两个函数定义之前求值可达——React 函数组件内直接放变量声明即可）加：

```tsx
  const selectedIdList = [...selectedItemIds];
  const hasSelection = selectedIdList.length > 0;
```

⚠️ 必须组件层定义：launchContentGeneration 内定义的话，startGeneration（612-617 行）与并发弹窗确认路径引用不到，tsc 直接报错。

- [ ] **Step 2: launchContentGeneration 携带清单**

575 行 `await window.yibiao?.tasks.startContentGeneration({regenerate, generationOptions})` 改为（直接用组件层 selectedIdList/hasSelection——并发弹窗确认路径 `startGeneration(true)` 天然携带）：

```tsx
    await window.yibiao?.tasks.startContentGeneration({
      regenerate,
      ...(hasSelection ? { targetItemIds: selectedIdList } : {}),
      generationOptions: savedGenerationOptions,
    });
```

612 行 regenerate 计算改（勾选轮压制全量重生成语义）：

```tsx
      const regenerate = !hasSelection && leaves.length > 0 && completedCount === leaves.length;
```

`contentGenerationAction`（613-617）加分支：`hasSelection ? 'selective' : ...`。任务启动成功（588 行 showToast 后）清空勾选：`setSelectedItemIds(new Set());`——放在 launchContentGeneration 成功路径末尾；失败保留（catch 不清）。

- [ ] **Step 3: 已 success 节覆盖确认弹窗**

加 state：`const [confirmSelectiveOpen, setConfirmSelectiveOpen] = useState(false);`

startGeneration 内、launchContentGeneration 调用前插入（组件层 hasSelection 在此可用）：

```tsx
      if (hasSelection && [...selectedItemIds].some((id) => sections[id]?.status === 'success')) {
        setConfirmSelectiveOpen(true);
        return;
      }
```

页面 Dialog 区（983 行 resetDialog 附近）加 AppDialog：

```tsx
      <AppDialog
        open={confirmSelectiveOpen}
        onOpenChange={setConfirmSelectiveOpen}
        title="覆盖重新生成？"
        description={`所选中 ${selectedCount} 个小节中含已生成内容的小节，将继续并覆盖这些小节的正文。`}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setConfirmSelectiveOpen(false)}>取消</button>
            <button type="button" className="primary-action" disabled={generationSubmitting} onClick={() => { setConfirmSelectiveOpen(false); void startGeneration(true, true); }}>生成所选</button>
          </>
        )}
      />
```

startGeneration 签名改 `startGeneration(confirmedConcurrency = false, confirmedOverwrite = false)`，确认弹窗路径传 `confirmedOverwrite=true` 跳过 Step 2 检查。

- [ ] **Step 4: 按钮文案优先级**

381-403 行 generationButtonLabel，在 `: paused ? '继续'` 之后插入（失败/空闲态勾选优先，运行/暂停态勾选已被禁用）：

```tsx
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : selectedCount > 0
          ? `生成所选 ${selectedCount} 节`
        : retryingSectionModification
          ? '重试小节修改'
        // ...以下保持原样
```

- [ ] **Step 5: 主按钮 onClick 勾选分支**

找到主按钮 onClick（约 545-550 行 `taskFailed ? void retryFailedSections() : void startGeneration()` 分支区），改为勾选态统一走 startGeneration：

```tsx
    if (selectedCount > 0) { void startGeneration(); return; }
    // 原有 taskFailed ? retryFailedSections() : startGeneration() 逻辑
```

- [ ] **Step 6: analytics 埋点适配**

`ContentGenerationAction` 类型定义在 **ContentEditPage.tsx:41**（`type ContentGenerationAction = ...`，非 types.ts），加 `'selective'` 联合成员；trackConfigUsage 调用（584 行）`enable_consistency_audit: true` 改为按轮次：`enable_consistency_audit: !hasSelection`。

- [ ] **Step 7: 构建 + Commit**

```powershell
npm run build
git add src/features/technical-plan/pages/ContentEditPage.tsx src/features/technical-plan/types.ts
git commit -m "feat: 生成所选启动链（并发弹窗/覆盖确认/analytics）"
```

---

### Task 9: 完成横幅与进度口径

**Files:**
- Modify: `client/src/features/technical-plan/pages/ContentEditPage.tsx:302-310`

- [ ] **Step 1: 勾选轮完成文案**

302-310 行改为（勾选轮结束不误报"全部完成"）：

```tsx
  const contentCompleted = htmlOutputProgress && task?.status === 'success' && currentProgressDetail?.phase === 'word-completed';
  const singleSectionCompleted = contentCompleted && currentProgressDetail?.mode === 'html-single';
  const selectiveCompleted = contentCompleted && !singleSectionCompleted && completedCount < leaves.length;
  const completedLabel = singleSectionCompleted ? '小节修改完成' : selectiveCompleted ? '本轮生成完成' : '全部完成';
  const completedImageCount = Object.values(contentStats?.workflow_progress?.steps['generating/0/images']?.items || {})
    .filter((item) => item.status === 'success').length;
  const completedDescription = singleSectionCompleted
    ? '小节修改完成，Word 已更新。'
    : selectiveCompleted
      ? `本轮 ${currentProgressDetail?.total || 0} 个小节生成完成，全文 ${completedCount}/${leaves.length}。清空勾选后点击"继续生成正文"可生成剩余小节；全部完成后可运行全文检查与优化。`
      : `正文生成全部完成：共 ${currentProgressDetail?.total || 0} 个小节，实际 ${contentStats?.generated_html_words || 0} 字${completedImageCount ? `，新增配图 ${completedImageCount} 张` : ''}，Word 已全部生成。`;
```

- [ ] **Step 2: 构建 + Commit**

```powershell
npm run build
git add src/features/technical-plan/pages/ContentEditPage.tsx
git commit -m "feat: 勾选轮完成横幅本轮口径"
```

---

### Task 10: 前端补跑入口按钮

**Files:**
- Modify: `client/src/features/technical-plan/pages/ContentEditPage.tsx`（主操作区，主按钮旁）

- [ ] **Step 1: 补跑条件与按钮**

主按钮（generationButtonLabel 所在操作区）旁加条件渲染按钮：

```tsx
  const postProcessPending = completedCount === leaves.length && leaves.length > 0
    && task?.status === 'success' && contentStats?.post_process_completed === false;
```

```tsx
  {postProcessPending && (
    <button
      type="button"
      className="secondary-action"
      disabled={taskBlocksGeneration}
      onClick={() => { void window.yibiao?.tasks.startContentGeneration({ postProcessOnly: true }); }}
    >运行全文检查与优化</button>
  )}
```

- [ ] **Step 2: 构建 + Commit**

```powershell
npm run build
git add src/features/technical-plan/pages/ContentEditPage.tsx
git commit -m "feat: 全文检查与优化补跑入口"
```

---

### Task 11: dev 模式集中功能验证

**Files:** 无代码改动（发现问题则回到对应 Task 修复后重跑）

- [ ] **Step 1: 启动 dev 模式**

```powershell
npm run dev
```

- [ ] **Step 2: 按设计 §4 验证清单逐项验证**

需已有或新建一个含多节 AI 小节的项目（目录+全局事实已完成）。逐项：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 勾 2 节生成 | 只产 2 节；日志见"跳过字数校正与全文后处理"；Word 出片 |
| 2 | 完成横幅 | "本轮生成完成…全文 2/N"，不显示"全部完成" |
| 3 | 并发提醒确认路径 | 弹窗确认后仍只生成勾选节（清单不丢） |
| 4 | 清空勾选→继续生成正文 | 剩余节继续，审计/表格清理/格式自检照常执行 |
| 5 | 勾含已 success 节 | 覆盖确认弹窗 → 覆盖重生成无重复内容 |
| 6 | 勾选轮中途暂停→继续 | 只继续勾选节，不触发审计 |
| 7 | 勾选轮某节失败→重试正文生成 | 重试范围=勾选轮范围，不膨胀、不进后处理 |
| 8 | 多轮勾选跑完全部叶子 | "运行全文检查与优化"入口出现，点击补跑审计链 |
| 9 | 多轮勾选配图名额 | 每轮配图数与本轮节数成比例（勾 3 节 30% 至少 1 图） |
| 10 | 部分生成状态导出 | 空占位行为与原版一致 |
| 11 | 回归：不勾选三操作 | 开始/继续/重试失败行为与原版一致；运行/暂停下"重新生成"Popover 禁用不变 |

每项记录实际结果（截图或文字），发现偏差记录并修复。

- [ ] **Step 3: 验证记录 Commit**

```powershell
git add -A
git commit -m "test: 勾选生成 dev 验证记录（11 项）" --allow-empty
```

---

### Task 12: 打包与替换

**Files:** 构建产物 `client/release/*.zip`

- [ ] **Step 1: 备份 userData**

```powershell
Copy-Item "$env:APPDATA\yibiao-client" "$env:APPDATA\yibiao-client.bak-20261021" -Recurse
```

⚠️ 必做：回滚官方版时 runtime 新字段会被官方 normalize 白名单丢弃，暂停中的勾选任务退化全量轮——有备份才有退路。

- [ ] **Step 2: 打包**

```powershell
npm run dist:win
```

Expected: `release/` 产出 nsis + zip。zip 即免安装版（现 D:\Yibiao 同形态）。首次打包含 dotnet publish OpenXmlHelper（dotnet 8 已装）。

- [ ] **Step 3: 替换 D:\Yibiao**

```powershell
Rename-Item D:\Yibiao Yibiao-official-bak
# 解压 release 下 zip 到 D:\Yibiao（用 Expand-Archive 或 7z）
Expand-Archive -Path .\release\Yibiao-0.1.0-win-x64.zip -DestinationPath D:\Yibiao-extract
# 按解压结构移动到 D:\Yibiao，保持桌面快捷方式目标路径有效
```

⚠️ 解压后核对目录结构与原 D:\Yibiao 一致（exe 在根还是子目录），快捷方式指向不变。

- [ ] **Step 4: 启动验证**

启动 D:\Yibiao 下 exe，确认：正常启动、项目数据在（userData 共用）、勾选生成入口可见。跑一轮勾选生成冒烟。

- [ ] **Step 5: Commit（若有修复）**

---

### Task 13: push fork 与收尾

- [ ] **Step 1: push 分支**

```powershell
git push -u fork feature/selective-section-generation
```

- [ ] **Step 2: 收尾检查**

- 设计文档 §4 验证计划全绿
- `git log --oneline` 确认提交序列完整
- 向用户汇报：功能清单 + 验证结果 + D:\Yibiao 已替换 + 备份位置（userData 备份、Yibiao-official-bak、fork 分支地址）

---

## 风险与回滚

| 风险 | 回滚 |
|---|---|
| 打包版异常 | `Rename-Item D:\Yibiao-extract D:\Yibiao` + 恢复 `Yibiao-official-bak` |
| userData 新字段污染 | 恢复 `yibiao-client.bak-20261021` |
| 代码回滚 | `git checkout main` 重打包，或直接用 Yibiao-official-bak |
