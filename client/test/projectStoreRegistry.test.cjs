'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectRegistry } = require('../electron/services/projectRegistry.cjs');
const { createProjectStoreRegistry } = require('../electron/services/projectStoreRegistry.cjs');

function makeFakeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-reg-test-'));
  const app = { getPath: (name) => (name === 'userData' ? root : path.join(root, name)) };
  const db = new (require('better-sqlite3'))(':memory:');
  const registry = createProjectRegistry({ db });
  const deps = {
    fileService: {},
    agentService: {},
    taskLogStore: {},
    configStore: { load: () => ({}), save: () => {} },
  };
  return { root, app, registry, deps };
}

test('项目库建在项目目录且三域表齐备；路径经代理落到项目内', () => {
  const { root, app, registry, deps } = makeFakeEnv();
  registry.create({ id: '20261030-a1b2c3', name: '测试项目' });
  const opened = [];
  const reg = createProjectStoreRegistry({ app, registry, deps, onProjectOpened: (id) => opened.push(id) });
  const stores = reg.resolveStores('20261030-a1b2c3');
  assert.ok(stores.technicalPlanStore && stores.duplicateCheckStore && stores.rejectionCheckStore);
  assert.ok(fs.existsSync(path.join(root, 'workspace', 'projects', '20261030-a1b2c3', 'project.sqlite')));
  assert.deepEqual(opened, ['20261030-a1b2c3']);
});

test('resolveStores 缺省当前项目；无项目时抛错', () => {
  const { app, registry, deps } = makeFakeEnv();
  const reg = createProjectStoreRegistry({ app, registry, deps });
  assert.throws(() => reg.resolveStores(), /尚未选择项目/);
  registry.create({ id: '20261030-a1b2c3', name: 'A' });
  reg.setCurrent('20261030-a1b2c3');
  assert.equal(reg.getCurrentProjectId(), '20261030-a1b2c3');
  assert.ok(reg.resolveStores().technicalPlanStore);
});

test('LRU 池满且全被钉住时，新项目不自淘汰', () => {
  const { app, registry, deps } = makeFakeEnv();
  const reg = createProjectStoreRegistry({ app, registry, deps, maxOpenProjects: 2 });
  for (const id of ['20261030-a1b2c3', '20261031-b2c3d4', '20261032-c3d4e5']) registry.create({ id, name: id });
  const rA = reg.acquire('20261030-a1b2c3');
  const rB = reg.acquire('20261031-b2c3d4');
  const storesC = reg.resolveStores('20261032-c3d4e5'); // 第 3 个，池满且 A/B 被钉住
  assert.ok(storesC.technicalPlanStore);
  assert.ok(reg.openProjectIds().includes('20261032-c3d4e5'));
  assert.ok(reg.openProjectIds().includes('20261030-a1b2c3')); // 钉住的不淘汰
  assert.ok(reg.openProjectIds().includes('20261031-b2c3d4'));
  rA(); rB();
});

test('pi 会话前缀键路由进项目目录', () => {
  const { getPersistentAgentTaskPaths } = require('../electron/services/pi/piPersistentTaskStore.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pi-'));
  const app = { getPath: (name) => (name === 'userData' ? root : path.join(root, name)) };
  const globalPaths = getPersistentAgentTaskPaths(app, 'feasibility-report-outline-generation');
  const projectPaths = getPersistentAgentTaskPaths(app, '20261030-a1b2c3_technical-plan-outline-generation');
  assert.ok(globalPaths.taskRoot.startsWith(path.join(root, 'agent-runtime')));
  assert.ok(projectPaths.taskRoot.startsWith(path.join(root, 'workspace', 'projects', '20261030-a1b2c3', 'agent-runtime')));
});
