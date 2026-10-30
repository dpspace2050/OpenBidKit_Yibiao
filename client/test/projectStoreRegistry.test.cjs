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
