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
  const checkpoints = [];
  const checkpointTask = (partial) => {
    if (controller.signal.aborted) throw controller.signal.reason || new Error('后台任务已取消');
    checkpoints.push(partial);
  };
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

test('逐项模式取消：第 1 项结束后不再启动后续项，取消不伪装成单项失败', async () => {
  const harness = createHarness({
    chatImpl: async () => {
      await delay(10);
      harness.controller.abort();
      return '模拟解析结果';
    },
  });
  await assert.rejects(() => runPayload(harness, {}));
  assert.equal(realChatCount(harness), 1, `取消后应只跑 1 项，实际 ${realChatCount(harness)}`);
  assert.ok(!harness.checkpoints.some((c) => String(c.error || '').includes('解析失败')), '取消不得落"解析失败"checkpoint');
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
