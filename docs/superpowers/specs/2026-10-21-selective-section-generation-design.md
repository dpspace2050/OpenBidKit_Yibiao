# 易标投标工具箱：正文生成支持指定小节（targetItemIds）设计文档

- 日期：2026-10-21
- 分支：`feature/selective-section-generation`（fork 自 `FB208/OpenBidKit_Yibiao`，fork 仓库 `dpspace2050/OpenBidKit_Yibiao`）
- 状态：待评审

## 1. 背景与目标

易标（OpenBidKit_Yibiao）的正文生成步骤目前只能对所有标记为"AI生成"的叶子小节整体生成，无法挑选小节子集。实际使用有三个痛点场景：

1. **试跑验证**：43 节全量一次生成约 7.5 万字、单日 140+ 大请求，希望先挑 2-3 节验证效果（文风/事实/配图）再决定全量，节省 token。
2. **续跑挑节**：部分小节已生成后，希望指定接下来生成哪几节（控制优先级），而不是程序自动跑完所有剩余节。
3. **单节/小批按需生成**：对个别未生成过的小节单独触发生成，不想影响整份文档的生成流程。

### 目标

- 正文编辑页可勾选小节，点"生成所选"只生成勾选的节。
- 勾选生成时跳过全文后处理阶段（一致性审计/表格清理/格式自检），Word 转换保留。
- 不勾选时所有现有行为完全不变（开始/继续/重试失败/单节修改/全量重生成）。

### 非目标

- 不修改现有"单节重新生成"（`targetItemId`，改写已生成小节）功能。
- 不修改大纲 content_mode 机制（模板填写/人工填写等模式跳过生成的既有能力）。

## 2. 现状调研结论（关键代码位置）

| 位置 | 现状 |
|---|---|
| `client/electron/services/taskService.cjs:1462-1510` | `startContentGeneration` 入口。带 `targetItemId`（单数）即分流到单节修改任务 `runContentSectionRegenerationTask` |
| `client/electron/services/contentSectionRegenerationTask.cjs:41-46` | 单节修改的两个硬前提：该节 HTML 已存在 + 原正文 Agent 会话存在。因此只能"改已有"，不能"从零生成指定节" |
| `client/electron/services/contentGenerationTask.cjs:1392` | 全量生成主任务 `runContentGenerationTask`，内部已有单节过滤分支（1521-1529 行，因 taskService 分流实际不可达，属原作者预留的暗桩） |
| `client/electron/services/contentGenerationTask.cjs:1517-1529` | `tasksToRun` 构建：默认 = 非 success 或缺字数记录的叶子；带 `targetItemId` 时 = 指定单节 |
| `client/electron/services/contentGenerationAgent.cjs:792-813` | 阶段状态机推进点：generating 完成 → （字数校正）→ `startAudit()` 进入一致性审计 → 表格清理 → 格式自检。后处理为程序控制阶段，无条件执行，无开关 |
| `client/electron/services/contentGenerationTask.cjs:2408` | `checkTotalWords: !targetItemId && targets.length === leaves.length`——字数总检仅全量启用 |
| `client/src/features/technical-plan/pages/ContentEditPage.tsx` | 正文编辑页。现有主按钮逻辑：612-617 行（0 完成=start / 部分完成=continue / 全完成=regenerate）；节列表树形渲染 |
| `client/src/shared/types/ipc.ts:821` | `startContentGeneration: (payload: unknown)` — IPC payload 无强类型，新增字段无需改类型定义 |

## 3. 设计

### 3.1 payload 契约

`tasks.startContentGeneration` 新增可选字段：

```ts
{
  targetItemIds?: string[];   // 本轮生成的 AI 叶子小节 ID 清单（复数）
  // 现有字段不变：regenerate, targetItemId, requirement, resume, retryFailedSections, generationOptions...
}
```

字段语义矩阵：

| payload | 走的管线 | 行为 |
|---|---|---|
| `targetItemId`（单数，现有） | 单节修改任务 | 改写已生成小节（不动） |
| `targetItemIds`（复数，新增） | 全量管线 + 清单过滤 | 只生成本轮勾选的节，跳过全文后处理 |
| 都不带 | 现有全量管线 | 开始/继续/重试，行为不变 |

### 3.2 后端改动

#### (a) taskService.cjs — 分流与早返回

1. 分流条件（1468-1470 行）只认单数 `targetItemId`，数组 `targetItemIds` 自然落入全量管线。预期零改动，验证即可。
2. **早返回排除**（1484-1490 行）：`hasPendingSections` 早返回在文档全部 success 时会拦截"勾选已 success 节重生成"场景，需在早返回条件中加 `&& !taskPayload?.targetItemIds?.length`。

#### (b) contentGenerationTask.cjs — 清单过滤 + 跳过开关

1. 解析：`const targetItemIds = Array.isArray(payload.targetItemIds) ? payload.targetItemIds.map(String).filter(Boolean) : [];`
2. **组合守卫**：`targetItemIds` 轮忽略 `regenerate`（勾选即明确本轮范围，两者组合无定义）。
3. `tasksToRun` 过滤插入在 **1549-1552 行（pending_item_ids 再过滤）之后**——若插在 1517 行后，大纲新增叶子场景下 pending_item_ids 交集会削减甚至清空勾选集（清空时落入 2637 行"无待生成"静默成功）：

```js
if (targetItemIds.length) {
  const idSet = new Set(targetItemIds);
  tasksToRun = leaves.filter(({ item }) => idSet.has(item.id));
  if (!tasksToRun.length) throw new Error('所选小节均不是待生成的 AI 正文小节');
}
```

勾选的已 success 节进入 `tasksToRun` 后由现有循环（1562-1573 行）重置为 idle 重新生成，`section_words` 与 Word 分节缓存按 section_id 覆盖。

4. **清单与跳过标志持久化到 contentRuntime**（关键，resume 依赖）：`pending_item_ids` 从不写入本轮 tasksToRun（仅大纲新增叶时由 technicalPlanStore 写入，任务内 2552/2681 行只做删减），因此 resume 若只靠 pending_item_ids 会跑所有非 success 节且丢失 skip 标志。新增 runtime 字段：

```js
contentRuntime.target_item_ids = targetItemIds;      // 本轮勾选清单
contentRuntime.skip_post_stages = targetItemIds.length > 0;
```

   resume 路径（continuing 为真）时从 `contentRuntime` 恢复：`targetItemIds = resume ? contentRuntime.target_item_ids : payload 数组`，`skipPostStages` 同理恢复。全量轮（不带 targetItemIds 的新启动）将两字段清空。

#### (c) contentGenerationAgent.cjs — 后处理跳过

`runContentGenerationAgent` 新增参数 `skipPostStages = false`。在 `continueTask` 的 generating 完成点（797-813 行）：`skipPostStages` 为 true 时不进入字数校正与 `startAudit()`，按 `finishLayout` 先例（pi/piRuntimeService.cjs:651/660）返回 `{ complete: true }` 结束 Agent 任务（piRuntimeService.cjs:1172 对 `complete===true` 正常 resolve），由外层 2524→2540 行直接进入 sections-completed → word-converting（外层推进不依赖审计阶段）。同模式跳过时修正外层约 1621 行"审计为必做阶段"类日志文案，避免误导（勾选轮输出"本轮为勾选生成，跳过全文后处理"）。

### 3.3 前端改动（ContentEditPage.tsx）

1. **复选状态**：`const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())`，任务运行中禁用勾选。
2. **节列表**：AI 叶子小节（`content_mode === 'ai-generate'` 且无 children）行内加复选框；父级节点与任务执行中（`taskBlocksGeneration`）不渲染/禁用。
3. **主按钮**：`selectedItemIds.size > 0` 时文案变"生成所选 N 节"，点击调用：

```js
await window.yibiao?.tasks.startContentGeneration({
  targetItemIds: [...selectedItemIds],
  generationOptions: savedGenerationOptions,
});
```

   成功启动后清空勾选。`selectedItemIds.size === 0` 时按钮与调用完全走现有 `startGeneration` 路径（并发提醒弹窗等逻辑对勾选模式同样生效——沿用 `startGeneration` 的校验链，仅 payload 增加 `targetItemIds`）。
4. **勾选与"单节重新生成"对话框并存**：复选框仅控制本轮生成清单；现有节点"重新生成"入口（改写单节）保持独立。

### 3.4 数据流（三场景）

- 试跑：勾 3 节 → 编排（planning）正常做 → 只产 3 节 → 跳过后处理 → Word 转换 3 节 → 预览。之后取消勾选点"生成正文" → `hasPendingSections` 为真 → 自动继续剩余 40 节 + 完整后处理。
- 续跑挑节：部分完成后勾想要的节 → 只跑这些；未勾节保持现有状态。
- 按需单节：勾 1 节 → 生成。不依赖"该节已生成过"（补齐现有单节修改的盲区）。

### 3.5 关键语义与边界

| 边界 | 处理 |
|---|---|
| 勾全部 AI 叶子节 | `targets.length === leaves.length` → 字数总检自动恢复（2408 行现有条件），`skipPostStages` 仍为 true 跳过后处理（语义一致性：勾选=本轮局部，后处理留给全量轮） |
| 勾选节含已 success | 视为重新生成，覆盖原内容与字数记录 |
| 勾选非 AI 叶子（其他模式/父节点） | UI 不渲染复选框；后端 `leaves ∩ idSet` 天然过滤，交集为空时报错提示 |
| 中断恢复 | 勾选清单与 skip 标志持久化于 `contentRuntime`（target_item_ids / skip_post_stages），暂停后 resume 从 runtime 恢复，只继续本轮勾选节且保持跳过后处理；后续全量轮（新启动不带 targetItemIds）清空两字段恢复正常行为 |
| 部分生成的导出 | 未生成节维持现有空占位行为，导出链路不变 |
| 会话复用 | 首次勾选生成会建立原正文 Agent 会话；后续勾选轮与全量轮在同一持久会话续用（现有 reuseSession 机制） |

### 3.6 错误处理

- 交集为空：启动即报错"所选小节均不是待生成的 AI 正文小节"，不建任务、不清产物。
- `regenerate` + `targetItemIds` 组合：守卫忽略 `regenerate`，以勾选清单为准。
- 运行中重复触发：现有 `isActiveTaskStatus` 拦截（"当前正文任务正在执行"）对勾选轮同样生效。
- 单节失败：沿用现有 per-section error 状态与"重试失败小节"机制。

## 4. 验证计划

1. **dev 模式功能验证**（`npm run dev`，智谱 glm-5.3）：
   - 勾 2 节生成 → 无审计/表格清理/格式自检日志，Word 出片，目录状态正确
   - 取消勾选 → "生成正文" → 剩余节继续生成，审计照常
   - 勾含已 success 节 → 覆盖重生成，无重复内容（文档全 success 状态下勾选也能启动，不被早返回拦截）
   - 勾选生成中途暂停 → resume 只继续勾选节且不触发审计
   - 不勾选的三个原始操作（开始/继续/重试失败）回归不变
2. **打包**：`npm install`（postinstall: patch-package + electron-builder install-app-deps）→ `npm run dist:win`（含 dotnet publish OpenXmlHelper，dotnet 8.0.422 已验证）→ 产出 zip 免安装版替换 `D:\Yibiao`
3. **生产验证**：用打包版跑一轮勾选生成。

## 5. Git 与交付

- fork：`dpspace2050/OpenBidKit_Yibiao`（AGPL-3.0：内部使用无额外义务；若将来对外分发修改版需保留版权声明并开源）
- 分支：`feature/selective-section-generation`，中文提交信息
- 交付：验证通过后打包替换本机 `D:\Yibiao`，日常转用 fork 版

## 6. 工作量评估

| 项 | 估计 |
|---|---|
| 后端改动 | taskService 验证 + contentGenerationTask 过滤/开关 + contentGenerationAgent 跳过，合计约 40 行 |
| 前端改动 | 复选状态 + 节列表复选框 + 按钮逻辑，约 80-100 行 |
| 环境搭建 | npm install（node_modules 缺失，含 native 编译 better-sqlite3） |
| 构建打包 | dist:win 全链路首次跑通 |
