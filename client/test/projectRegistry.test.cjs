'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createProjectRegistry } = require('../electron/services/projectRegistry.cjs');

function makeRegistry() { return createProjectRegistry({ db: new Database(':memory:') }); }

test('create/list/get 基本流 + name_source 默认 filename', () => {
  const r = makeRegistry();
  const p = r.create({ id: '20261030-a1b2c3', name: '白朗县项目' });
  assert.equal(p.name_source, 'filename');
  assert.equal(p.status, 'active');
  assert.equal(r.list().length, 1);
  assert.equal(r.get('20261030-a1b2c3').name, '白朗县项目');
});

test('updateNameFromAi 尊重 manual；rename 置 manual', () => {
  const r = makeRegistry();
  r.create({ id: '20261030-a1b2c3', name: '白朗县' });
  assert.equal(r.updateNameFromAi('20261030-a1b2c3', 'AI 提取名'), true);
  r.rename('20261030-a1b2c3', '手动名');
  assert.equal(r.updateNameFromAi('20261030-a1b2c3', 'AI 再提取'), false);
  assert.equal(r.get('20261030-a1b2c3').name, '手动名');
  assert.equal(r.get('20261030-a1b2c3').name_source, 'manual');
});

test('remove 软删后 list 不可见 get 返回 null；touch 更新 last_active_at 与摘要', () => {
  const r = makeRegistry();
  r.create({ id: '20261030-a1b2c3', name: 'A' });
  r.touch('20261030-a1b2c3', { currentStep: 'content', genSummary: '正文 3/5 节' });
  assert.equal(r.get('20261030-a1b2c3').gen_summary, '正文 3/5 节');
  r.remove('20261030-a1b2c3');
  assert.equal(r.list().length, 0);
  assert.equal(r.get('20261030-a1b2c3'), null);
});

test('migrating 状态机：markMigrating/markActive', () => {
  const r = makeRegistry();
  r.create({ id: '20261030-a1b2c3', name: 'A' });
  r.markMigrating('20261030-a1b2c3');
  assert.equal(r.getAny('20261030-a1b2c3').status, 'migrating');
  r.markActive('20261030-a1b2c3');
  assert.equal(r.getAny('20261030-a1b2c3').status, 'active');
});
