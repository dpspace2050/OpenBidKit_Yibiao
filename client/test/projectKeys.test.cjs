'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('generateProjectId 格式合法且可解析回', () => {
  const { generateProjectId, isValidProjectId } = require('../electron/utils/projectKeys.cjs');
  const id = generateProjectId(() => 0.5, new Date('2026-10-30T08:00:00+08:00'));
  assert.match(id, /^\d{8}-[a-z0-9]{6}$/);
  assert.equal(id.slice(0, 8), '20261030');
  assert.ok(isValidProjectId(id));
  assert.ok(!isValidProjectId('bad'));
  assert.ok(!isValidProjectId(''));
});

test('projectTaskKey 前缀与解析互逆，非法 projectId 抛错', () => {
  const { projectTaskKey, parseProjectTaskKeyDirName } = require('../electron/utils/projectKeys.cjs');
  const key = projectTaskKey('20261030-a1b2c3', 'technical-plan-outline-generation');
  assert.equal(key, '20261030-a1b2c3_technical-plan-outline-generation');
  assert.deepEqual(parseProjectTaskKeyDirName(key), { projectId: '20261030-a1b2c3', taskKey: 'technical-plan-outline-generation' });
  assert.equal(parseProjectTaskKeyDirName('technical-plan-outline-generation'), null);
  assert.throws(() => projectTaskKey('bad', 'x'));
  assert.equal(projectTaskKey('', 'feasibility-report-outline-generation'), 'feasibility-report-outline-generation');
});

test('slot 键与队列 scope 分层键格式', () => {
  const { taskSlotKey, buildQueueScopeId } = require('../electron/utils/projectKeys.cjs');
  assert.equal(taskSlotKey('20261030-a1b2c3', 'content-generation'), '20261030-a1b2c3:content-generation');
  assert.equal(taskSlotKey(null, 'feasibility-content'), '_global:feasibility-content');
  assert.equal(buildQueueScopeId('20261030-a1b2c3', 'content-generation', 't1'), '20261030-a1b2c3:content-generation:t1');
});
