# 招标文件解析执行模式（逐项/并发）真机验证记录

> 日期：2026-11-02
> 环境：dev 模式（vite 5173 + electron --remote-debugging-port=9222），分支 feature/multi-project-support（HEAD=b43eac8），CDP 驱动
> 测试数据：既有项目 2 个（只读，配置切换已双向还原）；新建测试项目 `20261102-pjutan`（test-tender.docx，787 字，验证后已删除）
> 前置：生产易标已全部退出（验证前核查无 D:\Yibiao 进程）；Step 1 回归 25/25 全绿（旧 17 + 新 8，见 Task 5 前置子代理）
> 工具：`D:\Neo\Neo\tmp\yibiao-execmode-verify\`（cdp-eval.mjs / watch-bid-analysis.mjs / network-capture.mjs / *.watch.jsonl）

## 总结论：PASS（4/4 场景通过）

| 场景 | 结论 | 关键断言 |
|---|---|---|
| 2a UI 静态 + 双向切换 + 持久化 | PASS | 默认高亮"逐项"；UI 切并发保存后 chip/命令栏/空状态三处文案切换且 `executionMode=concurrent` 落库；重开弹窗仍"并发"；切回逐项还原；旁路字段（标段/解析范围）全程不变 |
| 2b 逐项真实运行 + 中断续跑 | PASS | 全程 maxSimultaneousRunning=1；日志含"正在解析 项目概述（1/6）"；第 5 项运行中杀 electron → 重启后 checkpoint 4 success + 1 error 持久化 → 续跑仅执行 2 个非 success 项 → 6/6 全 success |
| 2c 并发真实运行 | PASS | force_rerun 全量后 6 项同时 running（maxSimultaneousRunning=6，远超 ≥2 阈值）；早退断言命中；删除测试项目成功且无残留任务 |
| 2d 埋点 /track 抓包 | PASS | 真实 `trackConfigUsage` 代码路径发出 `POST https://analytics.agnet.top/track`，body 含 `config_key:"bidAnalysisExecutionModes", config_value:"sequential"` |

## 2a UI 静态验证（既有项目"招标正文"，零 AI 消耗）

解析页（STEP 03）默认（sequential）状态：

- chip：`单标段 · 只解析关键项 · 逐项 / 6 项`（`.bid-analysis-config-chip span`）
- 命令栏：`逐项解析招标文件，选中解析项依次完成后进入目录生成。`
- 空状态：`点击开始解析后，左侧任务会依次逐个运行（长文档分段提取仍并行）；选择任一任务查看实时输出。` —— spec 边界声明文案如实

设置弹窗（`.bid-analysis-config-preset` 六个 preset）：

- 默认高亮（is-active）：单标段 / 只解析关键项 / **逐项**（三项互不干扰，逐项默认与 spec 一致）
- UI 点"并发" → "保存配置"：
  - chip → `单标段 · 只解析关键项 · 并发`；命令栏 → `并发解析招标文件，全部选中解析项结束后进入目录生成。`
  - `loadState().executionMode === "concurrent"`，`bidSectionMode` 仍 `"single"`（旁路不变，未复现前置子代理直调 IPC 的重置坑——UI 保存路径带全量字段）
- 重开弹窗："并发" preset 仍 is-active（跨弹窗持久化）
- UI 切回"逐项"保存：chip/命令栏/空状态全部还原，`executionMode==="sequential"`，`bidSectionMode==="single"`
- 全程未触碰任务勾选与标段配置

## 2b 逐项真实运行 + 中断续跑（测试项目，真实 AI 调用）

### 第一轮（task f8a7f6c2，sequential，6 项）

- 启动：`tasks.startBidAnalysis({mode:'key', execution_mode:'sequential'})`
- 轮询（seq-run1/seq-run1b.watch.jsonl，700ms 采样）：**全程 running ≤ 1**（maxSimultaneousRunning=1）
- 日志：`正在解析 项目概述（1/6）`（分母=选中项总数）
- 中断时机：第 5 项（deliveryAndServiceRequirements）running 中 `Stop-Process` 杀全部 electron（vite 保留）
- kill 时刻快照：4 success（projectOverview/techRequirements/projectInfo/partAInfo）+ 1 running

### 重启 + 续跑（task 802ac76a）

- 重启 electron 后 checkpoint 持久化核对：`4×success + deliveryAndServiceRequirements:error`（被杀项落 error，第 6 项无条目），`executionMode:"sequential"` 跨重启保持
- 再次 `startBidAnalysis`（无 force_rerun）：**仅 2 个非 success 项被调度**（deliveryAndServiceRequirements、responseFileRequirements，jsonl 中 4 个已 success 项从未回到 running）——与"只跑非 success 项"契约一致，故进度日志分母 N=2（源码 bidAnalysisTask.cjs:450-455：`tasksToRun.length` 即剩余数；日志行已在完成后随任务出列，未逐字抓到（1/2）行，以项集行为证据 + run1 实抓（1/6）行佐证）
- 终态：6/6 全部 success（含被中断项重跑成功）

## 2c 并发真实运行（同测试项目，force_rerun 全量）

- UI 切"并发"保存（执行路径同 2a，测试项目上落库 `executionMode:"concurrent"`）
- 启动：`startBidAnalysis({mode:'key', execution_mode:'concurrent', force_rerun:true})`（task b68fb343）
- 轮询（conc-run.watch.jsonl，400ms 采样，`--exit-on-running 2` 早退）：**首个采样点即 6/6 项同时 running**（maxSimultaneousRunning=6，达标 ≥2 即刻命中早退，控住观察成本；6 个 AI 调用已在途）
- 并发模式无"正在解析 X（i/N）"串行计数日志（seqLogs=[]，与实现 Promise.all 分支一致）
- 清理：`projects.remove({projectId:'20261102-pjutan'})`（内部先 cancelTechnicalPlanTasks 再关库删目录，projectsIpc.cjs:52-63）→ `{ok:true}`，项目列表仅剩 2 个既有项目，activeTasks 空，测试项目目录删除
- 收尾：`projects.setActive('20261102-6i5zmf')` 还原原活跃项目指针

## 2d 埋点抓包（零 AI 消耗）

- 方法：CDP `Network.enable` + 页面内动态 `import('/src/shared/analytics/analytics.ts')` 调真实 `trackConfigUsage({bid_analysis_execution_mode:'sequential'})`（与 BidAnalysisPage.tsx:399 启动埋点同一函数与字段），抓 requestWillBeSent
- 捕获（network-capture.mjs 输出）：

```json
{"url":"https://analytics.agnet.top/track",
 "body":"{...\"event\":\"config_usage\",...,\"config_key\":\"bidAnalysisExecutionModes\",\"config_value\":\"sequential\"}"}
```

- 同批正常携带既有键（fileParserProviders/imageProviders/imageModelStatuses），新键与旧键同构
- 说明：UI 点击启动路径的埋点未单独抓包（UI 按钮 .click() 被 checkBidSections 分支拦截未启动任务，改走 IPC 启动不影响功能断言；埋点函数/字段已由上述真实调用实证）

## AI 调用量

- 第一轮 5（4 success + 1 被杀在途）+ 续跑 2 + 并发全量 6 ≈ **13 次真实解析调用**，预算 ~25 内

## 已知残留（follow-up，非本次范围）

1. **analytics 聚合白名单**：`bidAnalysisExecutionModes` 已随 /track 上报，但 worker/dashboard 聚合白名单未登记（Task 3 已知残留），数据可回溯补聚合
2. **Task 1 Minor**：逐项模式下单项失败日志会被"正在解析 X（i/N）"进度日志顶掉（task.logs 只保留最后若干行），spec §8 已记录
3. 观察项：UI"开始解析"按钮经 CDP `.click()` 未触发任务启动（疑 checkBidSections 分支弹窗拦截），真机手动点击路径不受影响（Task 4 已由单测与 UI 接线覆盖）；如需自动化回归可后续用 CDP Input.dispatchMouseEvent 派发可信事件

## 环境与产物

- 轮询原始数据：`D:\Neo\Neo\tmp\yibiao-execmode-verify\{seq-run1,seq-run1b,seq-resume,conc-run}.watch.jsonl` + watcher 摘要
- 抓包脚本与输出：`D:\Neo\Neo\tmp\yibiao-execmode-verify\network-capture.mjs`
- 既有项目零写入核对：招标正文项目最终 `executionMode=sequential / bidSectionMode=single`（原值）；两项目列表/内容未动
