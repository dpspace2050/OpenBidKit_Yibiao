# 易标多项目支持（multi-project support）实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多个投标项目并行推进——上传招标文件即建项目（文件名即名），三域（标书制作/查重/废标）数据与任务严格按项目隔离，切走不中断后台生成，双项目可同时跑任务，存量数据一次性迁移进 default 项目。

**Architecture:** 每项目独立 SQLite + 项目目录 + 全局 projects 注册表；三域 store 经 app 代理（JS Proxy 拦 `getPath('userData')`）在项目目录内实例化；taskService 任务键 `projectId:type`、AI 队列 scope 分层键；IPC 缺省路由到当前活跃项目（D5③）；agent 会话按前缀键路由进项目目录（D5②）；存量迁移 journal 幂等。

**Tech Stack:** Electron 41 + React 19 + TypeScript + Vite（前端），CommonJS .cjs 服务 + better-sqlite3（main 进程），node:test（Node 内置，零新增依赖）。

**设计文档：** `docs/superpowers/specs/2026-10-30-multi-project-support-design.md`（唯一需求来源，实施前必读；D1-D5 决策不可违背）

**⚠️ 测试策略说明：** 项目无测试框架（沿用现状，不引入 jest/vitest）。**新增纯逻辑模块用 Node 内置 `node --test`**（零依赖）；改造中的存量文件用 `node --check` + `npm run build`（tsc 双关卡）+ `node -e` 冒烟；Task 14 集中做 CDP 集成验证与真实迁移实测。

**工作目录：** 所有命令在 `D:\Neo\Neo\tmp\OpenBidKit_Yibiao\client` 执行（下称 `client/`）。分支 `feature/multi-project-support`。

**全局约定（所有任务适用）：**
- 任何一步 Expected 不符 → 停下报告，不要带病继续
- 每个任务结束 commit 一次，message 用中文 conventional 风格（feat/fix/test/docs）
- 改 .cjs 后先 `node --check <file>` 再进下一步

---

### Task 0: 分支与环境基线

**Files:** 无代码改动（git 操作 + 还原 1 个损坏文件）

- [ ] **Step 1: 还原被截短的 package.json（需 Owner 已确认）**

```powershell
git -C D:\Neo\Neo\tmp\OpenBidKit_Yibiao restore client/package.json
git -C D:\Neo\Neo\tmp\OpenBidKit_Yibiao diff --stat
```

Expected: 无输出（工作区干净，除 `client/.npmrc` 未跟踪——**保留不动，勿提交**）。⚠️ 若 Owner 未确认还原则跳过本步并在汇报中标注。

- [ ] **Step 2: 建分支**

```powershell
git -C D:\Neo\Neo\tmp\OpenBidKit_Yibiao switch -c feature/multi-project-support
```

- [ ] **Step 3: 基线构建**

```powershell
cd D:\Neo\Neo\tmp\OpenBidKit_Yibiao\client
npm run build
```

Expected: tsc 零错误 + vite build 产出。坏基线即停。

---

### Task 1: projectKeys 工具 + 单测

**Files:**
- Create: `client/electron/utils/projectKeys.cjs`
- Test: `client/test/projectKeys.test.cjs`

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('generateProjectId 格式合法且可解析回', () => {
  const { generateProjectId, isValidProjectId } = require('../electron/utils/projectKeys');
  const id = generateProjectId(() => 0.5, new Date('2026-10-30T08:00:00+08:00'));
  assert.match(id, /^\d{8}-[a-z0-9]{6}$/);
  assert.equal(id.slice(0, 8), '20261030');
  assert.ok(isValidProjectId(id));
  assert.ok(!isValidProjectId('bad'));
  assert.ok(!isValidProjectId(''));
});

test('projectTaskKey 前缀与解析互逆，非法 projectId 抛错', () => {
  const { projectTaskKey, parseProjectTaskKeyDirName } = require('../electron/utils/projectKeys');
  const key = projectTaskKey('20261030-a1b2c3', 'technical-plan-outline-generation');
  assert.equal(key, '20261030-a1b2c3_technical-plan-outline-generation');
  assert.deepEqual(parseProjectTaskKeyDirName(key), { projectId: '20261030-a1b2c3', taskKey: 'technical-plan-outline-generation' });
  assert.equal(parseProjectTaskKeyDirName('technical-plan-outline-generation'), null);
  assert.throws(() => projectTaskKey('bad', 'x'));
  assert.equal(projectTaskKey('', 'feasibility-report-outline-generation'), 'feasibility-report-outline-generation');
});

test('slot 键与队列 scope 分层键格式', () => {
  const { taskSlotKey, buildQueueScopeId } = require('../electron/utils/projectKeys');
  assert.equal(taskSlotKey('20261030-a1b2c3', 'content-generation'), '20261030-a1b2c3:content-generation');
  assert.equal(taskSlotKey(null, 'feasibility-content'), '_global:feasibility-content');
  assert.equal(buildQueueScopeId('20261030-a1b2c3', 'content-generation', 't1'), '20261030-a1b2c3:content-generation:t1');
});
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test test/projectKeys.test.cjs
```

Expected: FAIL（Cannot find module '../electron/utils/projectKeys'）

- [ ] **Step 3: 实现**

```js
'use strict';

const PROJECT_ID_PATTERN = /^\d{8}-[a-z0-9]{6}$/;

function generateProjectId(random = Math.random, now = new Date()) {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += Math.floor(random() * 36).toString(36);
  return `${y}${m}${d}-${suffix}`;
}

function isValidProjectId(value) { return PROJECT_ID_PATTERN.test(String(value || '')); }

function projectTaskKey(projectId, taskKey) {
  if (!projectId) return String(taskKey);
  if (!isValidProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
  return `${projectId}_${taskKey}`;
}

function parseProjectTaskKeyDirName(dirName) {
  const match = /^(\d{8}-[a-z0-9]{6})_(.+)$/.exec(String(dirName || ''));
  return match ? { projectId: match[1], taskKey: match[2] } : null;
}

function taskSlotKey(projectId, type) { return `${projectId || '_global'}:${type}`; }

function buildQueueScopeId(projectId, type, taskId) { return `${projectId || '_global'}:${type}:${taskId}`; }

module.exports = { PROJECT_ID_PATTERN, generateProjectId, isValidProjectId, projectTaskKey, parseProjectTaskKeyDirName, taskSlotKey, buildQueueScopeId };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node --test test/projectKeys.test.cjs
```

Expected: 3 pass, 0 fail

- [ ] **Step 5: Commit**

```powershell
git add ../client/electron/utils/projectKeys.cjs ../client/test/projectKeys.test.cjs 2>$null; git add electron/utils/projectKeys.cjs test/projectKeys.test.cjs; git commit -m "feat: projectKeys 工具（id生成/前缀键/slot键/队列scope分层键）"
```

（在 client/ 下执行：`git add electron/utils/projectKeys.cjs test/projectKeys.test.cjs`）

---

### Task 2: projectRegistry（projects 表 CRUD）+ 单测

**Files:**
- Create: `client/electron/services/projectRegistry.cjs`
- Test: `client/test/projectRegistry.test.cjs`

- [ ] **Step 1: 写失败测试（用内存库）**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createProjectRegistry } = require('../electron/services/projectRegistry');

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
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
node --test test/projectRegistry.test.cjs
```

Expected: FAIL（module 不存在）

- [ ] **Step 3: 实现**

```js
'use strict';

function createProjectRegistry({ db }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      name_source    TEXT NOT NULL DEFAULT 'filename',
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      current_step   TEXT,
      gen_summary    TEXT
    );
  `);

  const now = () => Date.now();

  function getAny(id) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  }
  function get(id) {
    const row = getAny(id);
    return row && row.status !== 'deleted' ? row : null;
  }
  function list() {
    return db.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY last_active_at DESC").all();
  }
  function create({ id, name, nameSource = 'filename', status = 'active' }) {
    const ts = now();
    db.prepare('INSERT INTO projects (id, name, name_source, status, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, String(name || '未命名项目'), nameSource, status, ts, ts, ts);
    return getAny(id);
  }
  function rename(id, name) {
    db.prepare("UPDATE projects SET name = ?, name_source = 'manual', updated_at = ? WHERE id = ?").run(String(name), now(), id);
    return getAny(id);
  }
  function updateNameFromAi(id, name) {
    if (!name) return false;
    const result = db.prepare("UPDATE projects SET name = ?, name_source = 'ai', updated_at = ? WHERE id = ? AND name_source != 'manual'").run(String(name), now(), id);
    return result.changes > 0;
  }
  function remove(id) {
    db.prepare("UPDATE projects SET status = 'deleted', current_step = NULL, gen_summary = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  }
  function markMigrating(id) { db.prepare("UPDATE projects SET status = 'migrating', updated_at = ? WHERE id = ?").run(now(), id); }
  function markActive(id) { db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(now(), id); }
  function touch(id, { currentStep, genSummary } = {}) {
    db.prepare('UPDATE projects SET last_active_at = ?, updated_at = ?, current_step = COALESCE(?, current_step), gen_summary = COALESCE(?, gen_summary) WHERE id = ?')
      .run(now(), now(), currentStep ?? null, genSummary ?? null, id);
  }
  return { list, get, getAny, create, rename, updateNameFromAi, remove, markMigrating, markActive, touch };
}

module.exports = { createProjectRegistry };
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
node --test test/projectRegistry.test.cjs
```

Expected: 4 pass

- [ ] **Step 5: Commit**（`git add electron/services/projectRegistry.cjs test/projectRegistry.test.cjs`，message: `feat: projectRegistry（projects 注册表 CRUD + name_source 状态机）`）

---

### Task 3: sqliteDatabase 拆组（项目库 health + 三域表清单）

**Files:**
- Modify: `client/electron/services/sqliteDatabase.cjs`（schemaHealthTableGroups :1237-1338、schemaHealthColumnGroups :1344-1544、ensureWorkspaceSchemaHealth :1564-1605）

- [ ] **Step 1: 提取三域表清单常量**

在 `const schemaVersion = 36`（:6）之后新增：

```js
const THREE_DOMAIN_TABLES = [
  'technical_plan_meta', 'technical_plan_generation_config', 'technical_plan_generation_bid_tasks',
  'technical_plan_generation_reference_docs', 'technical_plan_tasks', 'technical_plan_bid_items',
  'technical_plan_outline_nodes', 'technical_plan_content_sections', 'technical_plan_content_plans',
  'technical_plan_global_fact_groups',
  'duplicate_check_meta', 'duplicate_check_files', 'duplicate_check_tasks', 'duplicate_check_analysis_sections',
  'duplicate_check_content_files', 'duplicate_check_metadata_items', 'duplicate_check_outline_items',
  'duplicate_check_outline_groups', 'duplicate_check_outline_pairwise', 'duplicate_check_content_duplicates',
  'duplicate_check_content_occurrences', 'duplicate_check_image_files', 'duplicate_check_duplicate_images',
  'duplicate_check_image_occurrences',
  'rejection_check_meta', 'rejection_check_documents', 'rejection_check_tasks', 'rejection_check_extraction',
  'rejection_check_results', 'rejection_check_risk_findings', 'rejection_check_typo_findings', 'rejection_check_logic_findings',
];
```

用 `git show HEAD:sql/workspace_schema.sql`（或直接读仓库根 `sql/workspace_schema.sql`）核对表名与实际一致——**逐个核对，多一个少一个都算错**。若与实际 schema 有出入，以 `sqliteDatabase.cjs` 迁移代码里的实际建表为准修正此数组。

- [ ] **Step 2: 拆 health 组**

把 `schemaHealthTableGroups` 中三域的 3 个组条目（technical_plan / duplicate_check / rejection_check 的 `{version, tables, repair}`）移入新数组 `projectSchemaTableGroups`；`schemaHealthColumnGroups` 中表名以 `technical_plan_` / `duplicate_check_` / `rejection_check_` 开头的条目移入 `projectSchemaColumnGroups`。**移动条目，不复制**——全局组里不再含三域表（否则迁移 DROP 后会被健康检查重建空表，spec §4.1 红线）。

- [ ] **Step 3: 新增 ensureProjectSchemaHealth**

```js
function ensureProjectSchemaHealth(db, onStatus) {
  for (const group of projectSchemaTableGroups) {
    const missing = group.tables.filter((table) => !db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    if (missing.length === 0) continue;
    onStatus?.(`补建项目表: ${group.description || group.tables.join(',')}`);
    group.repair(db);
  }
  for (const group of projectSchemaColumnGroups) {
    const columns = db.prepare(`PRAGMA table_info(${group.table})`).all().map((c) => c.name);
    const missing = Object.keys(group.columns).filter((name) => !columns.includes(name));
    if (missing.length === 0) continue;
    onStatus?.(`补列: ${group.table}`);
    for (const name of missing) db.prepare(`ALTER TABLE ${group.table} ADD COLUMN ${name} ${group.columns[name]}`).run();
  }
}
```

（对照现有 ensureWorkspaceSchemaHealth 的实现风格调整——保持同样的事务/容错模式，不发明新写法。）

- [ ] **Step 4: 导出**

`module.exports` 增加 `ensureProjectSchemaHealth`、`THREE_DOMAIN_TABLES`。

- [ ] **Step 5: 冒烟 + 构建**

```powershell
node --check electron/services/sqliteDatabase.cjs
node -e "const m = require('./electron/services/sqliteDatabase.cjs'); console.log(typeof m.ensureProjectSchemaHealth, m.THREE_DOMAIN_TABLES.length)"
npm run build
```

Expected: `function 32`（表数与 Step 1 核对结果一致，technical_plan 10 + duplicate_check 14 + rejection_check 8 = 32）+ 构建通过。

- [ ] **Step 6: Commit**（`feat: sqliteDatabase 拆全局/项目 health 组，导出三域表清单`）

---

### Task 4: projectStoreRegistry（app 代理 + 项目库 + store 三件套 + LRU）

**Files:**
- Modify: `client/electron/utils/paths.cjs`（新增 1 个函数）
- Create: `client/electron/services/projectStoreRegistry.cjs`
- Test: `client/test/projectStoreRegistry.test.cjs`

- [ ] **Step 1: paths.cjs 新增**

在 `getWorkspaceDatabasePath`（:42-44）附近新增并加入 module.exports（:202-241）：

```js
function getProjectsRootDir(app) { return path.join(getWorkspaceDir(app), 'projects'); }
```

- [ ] **Step 2: 写失败测试（临时目录 + 假 app + stub 依赖）**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectRegistry } = require('../electron/services/projectRegistry');
const { createProjectStoreRegistry } = require('../electron/services/projectStoreRegistry');

function makeFakeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-reg-test-'));
  const app = { getPath: (name) => (name === 'userData' ? root : path.join(root, name)) };
  const db = new (require('better-sqlite3'))(':memory:');
  const registry = createProjectRegistry({ db });
  const deps = { fileService: {}, agentService: {}, taskLogStore: {}, configStore: { load: () => ({}), save: () => {} } };
  return { root, app, registry, deps };
}

test('项目库建在项目目录且三域表齐备；路径经代理落到项目内', async () => {
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
```

⚠️ 若 store 构造函数在构造期调用了 stub 未提供的方法（报 `xxx is not a function`），给 stub 补最小方法，**不要改 store 源码**。

- [ ] **Step 3: 跑测试确认失败**

```powershell
node --test test/projectStoreRegistry.test.cjs
```

- [ ] **Step 4: 实现**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getProjectsRootDir } = require('../utils/paths');
const { ensureProjectSchemaHealth, THREE_DOMAIN_TABLES } = require('./sqliteDatabase');
const { createTechnicalPlanStore } = require('./technicalPlanStore');
const { createDuplicateCheckStore } = require('./duplicateCheckStore');
const { createRejectionCheckStore } = require('./rejectionCheckStore');

// 项目作用域 app：只拦截 getPath('userData') → 项目目录，其余成员透传真 app（D5①）
function createProjectAppProxy(app, projectRoot) {
  return new Proxy(app, {
    get(target, prop) {
      if (prop === 'getPath') {
        return (name) => (name === 'userData' ? projectRoot : Reflect.apply(target.getPath, target, [name]));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createProjectStoreRegistry({ app, registry, deps, onProjectOpened, onProjectEvicted, maxOpenProjects = 8 }) {
  const contexts = new Map();
  let currentProjectId = null;
  let seq = 0;

  function getProjectDir(projectId) { return path.join(getProjectsRootDir(app), projectId); }

  function storesOf(ctx) {
    return { technicalPlanStore: ctx.technicalPlanStore, duplicateCheckStore: ctx.duplicateCheckStore, rejectionCheckStore: ctx.rejectionCheckStore };
  }

  function buildContext(projectId) {
    if (!registry.get(projectId)) throw new Error(`项目不存在或已删除: ${projectId}`);
    const projectDir = getProjectDir(projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    const db = new Database(path.join(projectDir, 'project.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    ensureProjectSchemaHealth(db);
    const projectApp = createProjectAppProxy(app, projectDir);
    const { fileService, agentService, taskLogStore, configStore } = deps;
    const technicalPlanStore = createTechnicalPlanStore({ app: projectApp, db, fileService, agentService, taskLogStore, configStore });
    const duplicateCheckStore = createDuplicateCheckStore({ app: projectApp, db, taskLogStore });
    const rejectionCheckStore = createRejectionCheckStore({ app: projectApp, db, fileService, technicalPlanStore, taskLogStore });
    return { projectId, db, projectApp, ...{ technicalPlanStore, duplicateCheckStore, rejectionCheckStore }, refCount: 0, lastUsed: ++seq };
  }

  function getContext(projectId) {
    let ctx = contexts.get(projectId);
    if (!ctx) {
      ctx = buildContext(projectId);
      contexts.set(projectId, ctx);
      evictIfNeeded();
      try { onProjectOpened?.(projectId, storesOf(ctx)); } catch (error) { console.warn('[project-registry] 项目打开回调失败', error); }
    }
    ctx.lastUsed = ++seq;
    return ctx;
  }

  function evictIfNeeded() {
    if (contexts.size <= maxOpenProjects) return;
    const evictable = [...contexts.values()].filter((c) => c.refCount === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    while (contexts.size > maxOpenProjects && evictable.length) {
      const ctx = evictable.shift();
      contexts.delete(ctx.projectId);
      try { ctx.db.close(); onProjectEvicted?.(ctx.projectId); } catch (error) { console.warn('[project-registry] 连接关闭失败', error); }
    }
  }

  // 引用计数：任务起止与三域 IPC handler 出入口成对调用（spec §5.1）
  function acquire(projectId) { const ctx = getContext(projectId); ctx.refCount += 1; let released = false; return () => { if (!released) { released = true; ctx.refCount = Math.max(0, ctx.refCount - 1); } }; }
  function resolveStores(projectId = currentProjectId) {
    if (!projectId) throw new Error('尚未选择项目，请先在项目列表选择或新建');
    return storesOf(getContext(projectId));
  }
  function setCurrent(projectId) {
    currentProjectId = projectId || null;
    if (currentProjectId) registry.touch(currentProjectId);
  }
  function getCurrentProjectId() { return currentProjectId; }
  function openProjectIds() { return [...contexts.keys()]; }
  function closeAll() { for (const ctx of contexts.values()) { try { ctx.db.close(); } catch (_) {} } contexts.clear(); }

  return { getContext, acquire, resolveStores, setCurrent, getCurrentProjectId, openProjectIds, closeAll, createProjectAppProxy };
}

module.exports = { createProjectStoreRegistry, createProjectAppProxy };
```

- [ ] **Step 4b: 打开失败的标错隔离（spec §10，评审建议）**

buildContext 抛错时包装为 `{ code: 'PROJECT_OPEN_FAILED', projectId, message }`；projectsIpc 的 list/setActive 捕获后给该项目附 `openError` 字段返回（列表页显示错误态、禁入，不拖垮其他项目与全局库）。项目库版本高于客户端的降级保护（沿用 sqliteDatabase :1834-1835 思路）归入同一错误通道。

- [ ] **Step 5: 跑测试确认通过**

```powershell
node --test test/projectStoreRegistry.test.cjs
```

Expected: 2 pass

- [ ] **Step 6: 冒烟 + 构建 + Commit**（`feat: projectStoreRegistry（app代理/项目库惰性打开/store三件套/LRU+引用计数）`）

```powershell
node --check electron/services/projectStoreRegistry.cjs
npm run build
```

---

### Task 5: piPersistentTaskStore 前缀键路由

**Files:**
- Modify: `client/electron/services/pi/piPersistentTaskStore.cjs`（getPersistentAgentTaskPaths :20-30、safeTaskKey :13-17）

- [ ] **Step 1: 改路径解析**

getPersistentAgentTaskPaths 改为按 taskKey 前缀路由（D5②）。⚠️ 文件在 `services/pi/` 子目录，require 路径用 `../../`：

```js
const { getProjectsRootDir } = require('../../utils/paths');
const { parseProjectTaskKeyDirName } = require('../../utils/projectKeys');

function getPersistentAgentTaskPaths(app, taskKey) {
  const parsed = parseProjectTaskKeyDirName(taskKey);
  if (parsed) {
    // 项目会话落项目目录：projects/<id>/agent-runtime/pi/tasks/<dir>（删除项目自动带走）
    const taskRoot = path.join(getProjectsRootDir(app), parsed.projectId, 'agent-runtime', 'pi', 'tasks', safeTaskKey(taskKey));
    return { taskRoot, workspaceDir: taskRoot + '/workspace', sessionsDir: taskRoot + '/sessions', stateFile: taskRoot + '/task-state.json', resultFile: taskRoot + '/result.json' };
  }
  const layout = createPiEnvironmentLayout(app);
  const taskRoot = path.join(layout.tasksRoot, safeTaskKey(taskKey));
  return { taskRoot, workspaceDir: taskRoot + '/workspace', sessionsDir: taskRoot + '/sessions', stateFile: taskRoot + '/task-state.json', resultFile: taskRoot + '/result.json' };
}
```

注意：该文件可能不止这一处用 `createPiEnvironmentLayout` 解析 tasks 路径——`Select-String -Path electron/services/pi/piPersistentTaskStore.cjs -Pattern "tasksRoot"` 逐处核对，所有以 taskKey 定位目录的路径统一走上述路由（会话文件读取处 `getPersistentAgentSessionPath` 同理——它接收 taskKey + session_file，必须用同一 taskRoot 推导）。

- [ ] **Step 2: 单测补一条路由断言（追加到 projectStoreRegistry.test.cjs 或新建）**

```js
test('pi 会话前缀键路由进项目目录', () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { getPersistentAgentTaskPaths } = require('../electron/services/pi/piPersistentTaskStore');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pi-'));
  const app = { getPath: (name) => (name === 'userData' ? root : path.join(root, name)) };
  const globalPaths = getPersistentAgentTaskPaths(app, 'feasibility-report-outline-generation');
  const projectPaths = getPersistentAgentTaskPaths(app, '20261030-a1b2c3_technical-plan-outline-generation');
  assert.ok(globalPaths.taskRoot.startsWith(path.join(root, 'agent-runtime')));
  assert.ok(projectPaths.taskRoot.startsWith(path.join(root, 'workspace', 'projects', '20261030-a1b2c3', 'agent-runtime')));
});
```

- [ ] **Step 3: 跑测试 + node --check + Commit**（`feat: pi 会话按项目前缀键路由进项目目录`）

```powershell
node --test test/projectStoreRegistry.test.cjs
node --check electron/services/pi/piPersistentTaskStore.cjs
```

---

### Task 6: taskService 项目化（键/冲突/队列scope/事件/checkpoint）

**Files:**
- Modify: `client/electron/services/taskService.cjs`（锚点：:298-316 createTask、:321-322 Maps、:324-334 emit、:489 buildSnapshot、:522-530 subscribe、:547-574 getActiveTaskConflict、:609-627 snapshot 落库、:665-906 startManagedTask、:773-785 checkpointTask、:895-899 finally、:909-950 cancel*、:952-1355 recover*、:1357-1370 启动恢复、:1516-1539 pause*、:1721 getActiveTasks）

本任务改**机制层**；域方法路由在 Task 7。当前 store 注入参数保持可用（Task 9 才切换注入源），改造方式：

- [ ] **Step 1: 引入 storeRegistry 与键工具**

文件头 require：

```js
const { taskSlotKey, buildQueueScopeId } = require('../utils/projectKeys');
```

构造签名（:318）追加 `storeRegistry` 参数（可空，向后兼容；本任务内所有 resolve 调用都做 `storeRegistry ? ... : 原单例` 兜底——Task 9 接线后单例兜底分支不再走到）。

- [ ] **Step 2: createTask 增加 project_id（:298-316）**

任务对象加 `project_id: payload?.projectId || null`（调用方未传时由 startManagedTask 入口补当前项目，见 Step 3）。

- [ ] **Step 3: 键改造**

- startManagedTask（:666、:683、:747）：`activeTasks.get/set(type)` → 以 `const slot = taskSlotKey(task.project_id, type)` 为键；:666 幂等检查同用 slot。
- queueScopeId（:682）：`` `${type}:${task.task_id}` `` → `buildQueueScopeId(task.project_id, type, task.task_id)`。
- finally（:900-901）：delete 用 `taskSlotKey(task.project_id, task.type)`；:900 的 `get(type) === currentTask` 守卫同改。
- applyTaskPatch（:761）：set 键随 task 对象携带——把 slot 存到 taskControl/task 内部（`task.__slot = slot`）或重复计算，取实现最小者。

- [ ] **Step 4: 冲突判定项目化（:547-574）**

getActiveTaskConflict 增加 projectId 入参；循环内加一行：

```js
    if (task.project_id !== projectId) continue; // 跨项目放行（spec §5.2）
```

调用点传 `task.project_id`。

- [ ] **Step 5: 事件与快照**

- emit（:324-334）：event 结构不变（task 自带 project_id）——所有**闭包读取三域 store 的位置**改为按 `task.project_id` resolve。新增辅助：

```js
  function resolveStoresForTask(task) {
    return storeRegistry
      ? storeRegistry.resolveStores(task.project_id || undefined)
      : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore, feasibilityReportStore };
  }
```

（feasibilityReportStore 恒为全局单例，不进 registry。）**读取点清单（评审补全，逐处核对，漏一处=跨项目写错库）**：
- buildSnapshot（:489）
- getSnapshotForTask（:505-519，订阅重放/emit 快照的真正取数点）
- snapshot 落库（:609-627）
- loadWorkspaceState（:629-643，runner 启动读初态）
- startManagedTask 的 :855 previousState 与 :867-873 runnerWorkspaceStore（runner 的 workspaceStore 参数来源）
- checkpointTask（:773-785）内 `updateWorkspaceStateWithoutReload` 调用

全部改走 `resolveStoresForTask(task)` 的对应成员。recover* 重启任务（:1028-1039）调用 startManagedTask 时 payload 已带 projectId（Step 7），上述读取点按 task.project_id 自动落对项目。

- [ ] **Step 6: cancel*/pause*/getActiveTasks（:909-950、:1516-1539、:1721）**

- cancel* 三函数增加可选 projectId 过滤参数（缺省=当前项目）：遍历时 `if (projectId && task.project_id !== projectId) continue;`
- pause*（:1516、:1534）：`activeTasks.get('content-generation')` → `activeTasks.get(taskSlotKey(resolveProjectId(), 'content-generation'))`（resolveProjectId = `payload?.projectId || storeRegistry?.getCurrentProjectId() || null`）
- getActiveTasks（:1721）与 subscribe 重放（:522-530）不改——全量输出，渲染层过滤（Task 13）。

- [ ] **Step 7: 启动恢复迁出（:1357-1370）**

构造期 recover 序列整体提取为导出方法 `recoverInterruptedTasksForProject(projectId)`（内部各 recover* 增加 (projectId, stores) 入参；feasibility 部分保留在构造期原位执行——它是全局域）。构造期只保留 feasibility 恢复调用。⚠️ outline 恢复会自动重启任务（:1028-1039）——重启任务的 payload 需带 `projectId`，使 startManagedTask 落对项目。

- [ ] **Step 8: 冒烟 + 构建**

```powershell
node --check electron/services/taskService.cjs
node -e "const m = require('./electron/services/taskService.cjs'); console.log('loaded', typeof m)"
npm run build
```

- [ ] **Step 9: Commit**（`feat: taskService 项目化机制层（slot键/项目内互斥/分层scope/事件project_id/恢复惰性化）`）

---

### Task 7: taskService 域方法路由 + agent 前缀键 + primarySession 项目化

**Files:**
- Modify: `client/electron/services/taskService.cjs`（各 start*/confirm*/import* 方法）
- Modify: `client/electron/services/agentService.cjs`（:176 primarySession、:443-476 会话判定、:274-282 pendingQuestions）
- Modify: agent taskKey 使用点（见 Step 3 grep 清单）

- [ ] **Step 1: 域方法入口路由（const 影子声明，禁止裸解构赋值）**

对下列方法（taskIpc.cjs 通道对应 + technicalPlanIpc 的 import 链），在方法体第一行插入。⚠️ 必须用 **const 局部声明**影子遮蔽外层闭包变量——裸 `({ x } = ...)` 是对外层共享变量的赋值，会把上一个项目的 store 写穿到所有方法（评审 Issue）：

```js
  const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
  const projectStores = storeRegistry
    ? storeRegistry.resolveStores(projectId)
    : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
  const technicalPlanStore = projectStores.technicalPlanStore;
  const rejectionCheckStore = projectStores.rejectionCheckStore;
  const duplicateCheckStore = projectStores.duplicateCheckStore;
```

（方法体内原有的 `technicalPlanStore` 引用自动落到本地影子；方法内闭包传给 runner 的 store 也是本地影子。）recover* 入口同样加这段影子声明再调 startManagedTask。

方法清单（逐一处理，完成后 grep 复核无遗漏）：`startBidSectionExtraction / startBidAnalysis / startOutlineGeneration / confirmOutlineSelection / suppressOutlineSelectionAutoConfirmation / startOutlineAdjustment / startGlobalFactsGeneration / startGlobalFactsAdjustment / startContentGeneration / pauseContentGeneration / startRejectionItemsExtraction / startRejectionCheck / importRejectionCheckDocument / startDuplicateAnalysis / importTenderDocument`。feasibility 系列方法**不改**。

复核命令：

```powershell
Select-String -Path electron/ipc/taskIpc.cjs -Pattern "taskService\.(\w+)" | ForEach-Object { $_.Matches[0].Groups[1].Value } | Sort-Object -Unique
```

对照上面清单，taskService 侧多出来的三域方法也要加。

- [ ] **Step 2: startManagedTask 调用点带 projectId**

上一步各方法内部调 `startManagedTask(type, payload, ...)` 时确认 payload 里有 projectId（Step 1 已注入局部变量，把它放进 payload：`payload = { ...payload, projectId }`）。

- [ ] **Step 3: agent 任务键前缀化**

```powershell
Select-String -Path electron/services/*.cjs,electron/services/agentConfigs/*.cjs -Pattern "_AGENT_TASK_KEY" -List 2>$null; Select-String -Path electron/services/*.cjs -Pattern "AGENT_TASK_KEY" | Select-Object -ExpandProperty Line
```

对每个**使用点**（launchTask / loadPersistentTask / deletePersistentTask / hasPersistentTaskSession / forkPersistentTask 调用处的 KEY 常量）：三域的 5 个 KEY（OUTLINE / TEMPLATE_EXTRACTION / GLOBAL_FACTS / ORIGINAL_RESTORATION / CONTENT_GENERATION）包 `projectTaskKey(projectId, KEY)`；feasibility 的 KEY 保持原样。recover* 里的 loadPersistentTask 同改（projectId 从 recover 入参拿）。

- [ ] **Step 4: primarySession per-project（agentService.cjs :176、:443-476）**

`let primarySession = loadPrimaryAgentSession(app)` → `const primarySessions = new Map(); let primarySession = loadPrimaryAgentSession(app);`（'' 槽=全域）。isPrimarySession/setPrimarySession/clearPrimarySessionIfMatches 增加 projectId 入参（缺省 ''）：读写 `primarySessions.get(projectId || '') ?? ((projectId || '') === '' ? primarySession : null)`（⚠️ 括号必须加——`projectId || '' === ''` 恒真值会让 map miss 恒回全局槽）。taskService bindTaskContext（:876-890）传入 task.project_id。

- [ ] **Step 5: pendingQuestions 项目标识（:173-174、:274-282、:320-382）**

requestUserQuestion 的 entry 增加 `projectName` 字段（调用侧由 taskService 从 registry.get(projectId).name 带入，feasibility 传 null）；getVisibleQuestionEntry 返回结构带上它（UI 端 Task 13 Step 4 消费，这里只保证 payload 有数据）。

- [ ] **Step 6: 冒烟 + 构建 + Commit**（`feat: taskService 域方法按项目路由 + agent 会话前缀键 + primarySession 项目化`）

```powershell
node --check electron/services/taskService.cjs
node --check electron/services/agentService.cjs
npm run build
```

---

### Task 8: 存量迁移（journal 幂等）

**Files:**
- Create: `client/electron/services/projectMigration.cjs`
- Test: `client/test/projectMigration.test.cjs`

- [ ] **Step 1: 写失败测试（合成老布局）**

测试构造：临时目录 fake app → `<root>/workspace/yibiao.sqlite`（手动建三域表 + 插 1 行 technical_plan_meta 含 outline_project_name='老项目'）+ `<root>/workspace/technical-plan/tender.md` + `duplicate-check/contents/f1.md` + `rejection-check/bids/d1.md` + `<root>/agent-runtime/pi/tasks/technical-plan-outline-generation/task-state.json`。断言迁移后：
1. `projects/<id>/project.sqlite` 存在且 technical_plan_meta 行完整；
2. 三域目录/agent 会话目录在新位置（会话目录名 = `<projectId>_technical-plan-outline-generation`）；
3. 全局库三域表已 DROP（sqlite_master 查无）；
4. registry 有 1 个 active 项目 name='老项目' name_source='ai'；
5. **再跑一次 runLegacyMigration 为 no-op**（幂等）；
6. journal 文件 `workspace/projects/.legacy-migration.json` 状态 done。

- [ ] **Step 2: 跑测试确认失败**（module 不存在）

- [ ] **Step 3: 实现**

```js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getWorkspaceDir, getProjectsRootDir, getAgentRuntimeDir } = require('../utils/paths');
const { THREE_DOMAIN_TABLES } = require('./sqliteDatabase');

const LEGACY_AGENT_KEYS = ['technical-plan-outline-generation', 'technical-plan-template-extraction', 'technical-plan-global-facts', 'technical-plan-original-restoration', 'technical-plan-content-generation'];
const STEPS = ['backup', 'copy-tables', 'move-dirs', 'move-agent-sessions', 'drop-tables', 'activate'];

function journalPath(app) { return path.join(getProjectsRootDir(app), '.legacy-migration.json'); }

function readJournal(app) { try { return JSON.parse(fs.readFileSync(journalPath(app), 'utf8')); } catch (_) { return null; } }
function writeJournal(app, journal) { fs.mkdirSync(path.dirname(journalPath(app)), { recursive: true }); fs.writeFileSync(journalPath(app), JSON.stringify(journal, null, 2)); }

function threeDomainTablesExist(db) {
  return THREE_DOMAIN_TABLES.every((t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
}
function moveDirSafe(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) {
    // 幂等：目标已存在——若源仍存在且非空则报错（人工介入），否则跳过
    if (fs.readdirSync(from).length > 0) throw new Error(`迁移目标已存在且源非空: ${from} -> ${to}`);
    return;
  }
  fs.renameSync(from, to);
}

// 返回 { migrated: boolean, projectId?: string, error?: string }
function runLegacyMigration({ app, globalDb, registry, onStatus }) {
  const log = (msg) => { onStatus?.(msg); console.log(`[migration] ${msg}`); };
  const hasLegacyTables = THREE_DOMAIN_TABLES.some((t) => globalDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  if (!hasLegacyTables) return { migrated: false };

  let journal = readJournal(app);
  const resume = Boolean(journal && journal.status === 'migrating');
  if (journal && journal.status === 'done') return { migrated: false };

  const workspaceDir = getWorkspaceDir(app);
  const projectsRoot = getProjectsRootDir(app);
  let projectId = journal?.projectId;

  if (!resume) {
    const meta = globalDb.prepare('SELECT outline_project_name FROM technical_plan_meta WHERE id = 1').get();
    const hasData = THREE_DOMAIN_TABLES.some((t) => { try { return globalDb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n > 0; } catch (_) { return false; } });
    if (!hasData) {
      // 全新安装：迁移数组建出的空三域表直接 DROP
      const dropAll = globalDb.transaction(() => { for (const t of THREE_DOMAIN_TABLES) globalDb.exec(`DROP TABLE IF EXISTS ${t}`); });
      dropAll();
      log('全新安装，直接清理空三域表');
      return { migrated: false, cleanedFresh: true };
    }
    const { generateProjectId } = require('../utils/projectKeys');
    projectId = generateProjectId();
    registry.create({ id: projectId, name: meta?.outline_project_name || '导入的项目', nameSource: 'ai' });
    registry.markMigrating(projectId);
    journal = { status: 'migrating', projectId, doneSteps: [] };
    writeJournal(app, journal);
  }

  const done = (step) => journal.doneSteps.includes(step);
  const mark = (step) => { journal.doneSteps.push(step); writeJournal(app, journal); };

  const projectDir = path.join(projectsRoot, projectId);
  const dbPath = path.join(projectDir, 'project.sqlite');

  if (!done('backup')) {
    // 复用全局库备份机制（wal_checkpoint + copy）；从备份还原前需先 close 连接（调用方负责）
    const backupDir = path.join(projectsRoot, '.legacy-backup');
    fs.mkdirSync(backupDir, { recursive: true });
    globalDb.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(globalDb.name, path.join(backupDir, 'yibiao.sqlite'));
    mark('backup');
  }

  if (!done('copy-tables')) {
    fs.mkdirSync(projectDir, { recursive: true });
    const pdb = new Database(dbPath);
    pdb.pragma('journal_mode = WAL');
    const { ensureProjectSchemaHealth } = require('./sqliteDatabase');
    ensureProjectSchemaHealth(pdb);
    pdb.exec(`ATTACH DATABASE '${globalDb.name.replace(/'/g, "''")}' AS legacy`);
    const copy = pdb.transaction(() => {
      for (const t of THREE_DOMAIN_TABLES) {
        try { pdb.exec(`INSERT INTO main.${t} SELECT * FROM legacy.${t}`); } catch (error) { throw new Error(`复制表失败 ${t}: ${error.message}`); }
      }
    });
    try { copy(); } finally { pdb.exec('DETACH DATABASE legacy'); pdb.close(); }
    mark('copy-tables');
  }

  if (!done('move-dirs')) {
    for (const dir of ['technical-plan', 'duplicate-check', 'rejection-check', 'generated-images', 'imported-images']) {
      moveDirSafe(path.join(workspaceDir, dir), path.join(projectDir, 'workspace', dir));
    }
    mark('move-dirs');
  }

  if (!done('move-agent-sessions')) {
    const legacyTasksRoot = path.join(getAgentRuntimeDir(app), 'pi', 'tasks');
    for (const key of LEGACY_AGENT_KEYS) {
      moveDirSafe(path.join(legacyTasksRoot, key), path.join(projectDir, 'agent-runtime', 'pi', 'tasks', `${projectId}_${key}`));
    }
    mark('move-agent-sessions');
  }

  if (!done('drop-tables')) {
    const drop = globalDb.transaction(() => { for (const t of THREE_DOMAIN_TABLES) globalDb.exec(`DROP TABLE IF EXISTS ${t}`); });
    drop();
    mark('drop-tables');
  }

  registry.markActive(projectId);
  journal.status = 'done';
  writeJournal(app, journal);
  log(`存量迁移完成 → 项目 ${projectId}`);
  return { migrated: true, projectId };
}

module.exports = { runLegacyMigration, journalPath };
```

- [ ] **Step 3b: 失败还原分支（spec §7 第 7 条，评审补）**

把 backup 之后到 markActive 之前的步骤序列包进 try/catch：

```js
  try {
    // …backup / copy-tables / move-dirs / move-agent-sessions / drop-tables 各步骤…
  } catch (error) {
    journal.failCount = (journal.failCount || 0) + 1;
    writeJournal(app, journal);
    if (journal.failCount >= 3) {
      // 续跑三次仍失败：请求调用方从备份还原并标错（还原需先 close 全局库连接——调用方职责）
      journal.status = 'failed';
      writeJournal(app, journal);
      return { migrated: false, fatal: true, projectId, error: String(error?.message || error), backupDir: path.join(projectsRoot, '.legacy-backup') };
    }
    throw error; // 未达阈值：本次启动标错，下次启动幂等续跑
  }
```

index.cjs 调用侧（Task 9 接线）：`fatal: true` 时 → `sqliteDatabase.close()` → 用 `.legacy-backup/yibiao.sqlite` 覆盖回 `workspace/yibiao.sqlite` → updateStatus 报「存量迁移失败，已从备份还原」并阻断工作区功能（不静默）。

⚠️ `globalDb.name` 是 better-sqlite3 暴露的库文件路径属性——若版本不符改用调用方显式传入 `globalDbPath`。task_logs 的三域触发器若随 DROP 报依赖错误，先 `DROP TRIGGER IF EXISTS` 清单处理（实施时用 sqlite_master 查实际触发器名）。

- [ ] **Step 4: 跑测试确认通过**（含幂等重跑断言）

```powershell
node --test test/projectMigration.test.cjs
```

- [ ] **Step 5: Commit**（`feat: 存量迁移 journal 幂等（备份/复制/搬目录/会话改名/DROP/激活）`）

---

### Task 9: IPC 接线（index.cjs 重构 + projectsIpc + preload + 类型 + 隐藏调用面）

**Files:**
- Modify: `client/electron/ipc/index.cjs`（:284-346 registerWorkspaceDatabaseServices、:124-226 workspaceDatabaseChannels、:302-345 隐藏调用面）
- Create: `client/electron/ipc/projectsIpc.cjs`
- Modify: `client/electron/ipc/technicalPlanIpc.cjs / duplicateCheckIpc.cjs / rejectionCheckIpc.cjs`（handler 体路由）
- Modify: `client/electron/preload.cjs`（新增 projects 段）
- Modify: `client/src/shared/types/ipc.ts`（:20-31 TaskEventTask、:579-860 YibiaoBridge）

- [ ] **Step 1: index.cjs 初始化链重构**

registerWorkspaceDatabaseServices 内，紧跟 `createSqliteDatabase` 之后按序：

```js
  const projectRegistry = createProjectRegistry({ db: sqliteDatabase.db });
  const migrationResult = runLegacyMigration({ app, globalDb: sqliteDatabase.db, registry: projectRegistry, onStatus: updateStatus });
  const projectStoreRegistry = createProjectStoreRegistry({
    app,
    registry: projectRegistry,
    deps: { fileService, agentService, taskLogStore, configStore },
    onProjectOpened: (projectId, stores) => { taskServiceRef.current?.recoverInterruptedTasksForProject(projectId); },
  });
```

初始化 currentProject：`configStore.load().last_project_id` 在 registry.list() 中存在则 setCurrent，否则取 list()[0]?.id 或 null。

- 原三域 store 的直接构造（:291-302 的 technicalPlanStore/duplicateCheckStore/rejectionCheckStore 三行）删除（registry 内构造）；feasibilityReportStore 保留。
- ⚠️ **:312 `technicalPlanStore.setAgentWorkspaceChangeListener(...)`**：变量删除后此行会 undefined 崩——把该监听注册移进 projectStoreRegistry.buildContext（store 创建后立即调用，监听回调经 deps 注入传入，回调逻辑保持原样）。
- ⚠️ **:331-338 `pluginService.updateServices({ ..., technicalPlanStore, duplicateCheckStore, rejectionCheckStore })`**（spec §6 隐藏调用面，评审补）：改为传**当前项目解出的实例**，并在 projects setActive 的 onActiveChanged 回调里重新调用一次 updateServices 刷新（插件语义=当前活跃项目）。
- taskService 构造（:309）追加 `storeRegistry: projectStoreRegistry`（taskServiceRef 模式供 onProjectOpened 时序兜底：taskService 创建后立刻补跑一次当前项目 recover）。
- `createTaskService` 原三域 store 参数保留传入（兼容 Task 6 的兜底分支，值可传 null）——**先传 null 跑冒烟，报错则回填 registry.resolveStores() 的当前值**。
- agentWorkspaceService（:310）/ checkResultExportService / duplicateCheckService（:302-308）/ technicalPlanExport（:345）：构造时捕获的三域 store 单例改为 getter `() => projectStoreRegistry.resolveStores().technicalPlanStore` 等（导出链 exportService 的 getTechnicalPlanExport 同理——exportIpc handler 入口 resolve）。
- **active-changed 广播归属**：onActiveChanged = `(projectId) => { mainWindow.webContents.send('projects:active-changed', { projectId }); pluginService.updateServices 刷新（见上）; }`，在 registerProjectsIpc 调用前于本函数内定义并传入。
- `app.once('will-quit', ...)` 增加 projectStoreRegistry.closeAll()。
- 迁移 fatal 处理：runLegacyMigration 返回 `fatal: true` 时按 Task 8 Step 3b 还原备份并 updateStatus 阻断。

- [ ] **Step 2: 三域 IPC handler 路由**

technicalPlanIpc / duplicateCheckIpc / rejectionCheckIpc 的注册函数签名增加 `resolveCurrentStores`（index.cjs 传入 `() => projectStoreRegistry.resolveStores()`）；handler 体把 `technicalPlanStore.xxx` 改为 `const { technicalPlanStore } = resolveCurrentStores();`（每 handler 一行解构 + acquire/release 包裹：参照 spec §5.1 引用计数——实现为 wrapper：

```js
function withProjectStores(resolveCurrentStores, storeRegistry, handler) {
  return async (...args) => {
    const projectId = storeRegistry.getCurrentProjectId();
    const release = projectId ? storeRegistry.acquire(projectId) : null;
    try { return await handler(...args); } finally { release?.(); }
  };
}
```

handler 逐个包裹）。resolve 入口统一打一条日志（含 handler 名与 projectId）便于 CDP 验证核对路由。rejectionCheckIpc 里 `taskService.importRejectionCheckDocument` 直通不改（taskService 内部已路由）。

- [ ] **Step 3: projectsIpc.cjs（新文件）**

```js
'use strict';
const { ipcMain } = require('electron');
const fs = require('fs');

function registerProjectsIpc({ app, registry, storeRegistry, taskService, onActiveChanged }) {
  const emitActive = (projectId) => { try { onActiveChanged?.(projectId); } catch (_) {} };

  ipcMain.handle('projects:list', () => ({ projects: registry.list(), activeProjectId: storeRegistry.getCurrentProjectId() }));
  ipcMain.handle('projects:set-active', (_e, projectId) => {
    if (projectId) {
      const project = registry.get(projectId);
      if (!project) throw new Error(`项目不存在: ${projectId}`);
    }
    storeRegistry.setCurrent(projectId || null);
    const config = configStoreSafeLoad(app);
    emitActive(projectId || null);
    return { ok: true };
  });
  ipcMain.handle('projects:rename', (_e, { projectId, name }) => { registry.rename(projectId, name); return { ok: true }; });
  ipcMain.handle('projects:remove', async (_e, { projectId }) => {
    await taskService.cancelTechnicalPlanTasks(undefined, projectId);
    await taskService.cancelDuplicateCheckTasks?.(projectId);
    await taskService.cancelRejectionCheckTasks(projectId);
    registry.remove(projectId);
    fs.rmSync(path.join(getProjectsRootDir(app), projectId), { recursive: true, force: true, maxRetries: 5 });
    if (storeRegistry.getCurrentProjectId() === projectId) { storeRegistry.setCurrent(null); emitActive(null); }
    return { ok: true };
  });
  ipcMain.handle('projects:create-from-tender-file', async (_e, { filePaths }) => {
    const { generateProjectId } = require('../utils/projectKeys');
    const first = String(filePaths?.[0] || '');
    const name = first ? path.basename(first).replace(/\.[^.]+$/, '') : '未命名项目';
    const projectId = generateProjectId();
    fs.mkdirSync(path.join(getProjectsRootDir(app), projectId, 'workspace'), { recursive: true });
    registry.create({ id: projectId, name });
    storeRegistry.setCurrent(projectId);
    try {
      emitActive(projectId);
      // importTenderDocument 现签名是 (filePaths) 数组直传（taskService.cjs:1641）——setCurrent 已完成，D5③ 缺省路由落到本项目
      const importResult = await taskService.importTenderDocument(filePaths);
      return { projectId, name, importResult };
    } catch (error) {
      // 新建失败回滚（spec §9）：不留孤儿 registry 行/目录
      registry.remove(projectId);
      try { fs.rmSync(path.join(getProjectsRootDir(app), projectId), { recursive: true, force: true, maxRetries: 5 }); } catch (_) {}
      storeRegistry.setCurrent(null);
      emitActive(null);
      throw error;
    }
  });
}
module.exports = { registerProjectsIpc };
```

（`configStoreSafeLoad`/`getProjectsRootDir`/`path` 按需 require；cancel 系列签名按 Task 6 实际实现对齐——缺省第一参是 typeFilter 时传 undefined。last_project_id 持久化在 setActive 里经注入的 configStore.save 完成，实现时从 index.cjs 传 configStore 进来。）

- [ ] **Step 4: workspaceDatabaseChannels 与占位 handler（:124-254）**

通道清单数组追加：`projects:list / projects:set-active / projects:rename / projects:remove / projects:create-from-tender-file`（pending 阶段占位 handler 覆盖，防 DB 未就绪时 pending 无响应）。

- [ ] **Step 5: preload.cjs 新增 projects 段（AppBridge 内）**

```js
projects: {
  list: () => ipcRenderer.invoke('projects:list'),
  setActive: (projectId) => ipcRenderer.invoke('projects:set-active', projectId),
  rename: (payload) => ipcRenderer.invoke('projects:rename', payload),
  remove: (payload) => ipcRenderer.invoke('projects:remove', payload),
  createFromTenderFile: (payload) => ipcRenderer.invoke('projects:create-from-tender-file', payload),
  onActiveChanged: (callback) => {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('projects:active-changed', listener);
    return () => ipcRenderer.removeListener('projects:active-changed', listener);
  },
},
```

- [ ] **Step 6: ipc.ts 类型**

- `TaskEventTask`（:20-31）加 `project_id?: string | null;`
- `YibiaoBridge` 新增：

```ts
export interface ProjectInfo { id: string; name: string; name_source: string; status: string; created_at: number; updated_at: number; last_active_at: number; current_step?: string | null; gen_summary?: string | null; }
projects: {
  list: () => Promise<{ projects: ProjectInfo[]; activeProjectId: string | null }>;
  setActive: (projectId: string | null) => Promise<{ ok: boolean }>;
  rename: (payload: { projectId: string; name: string }) => Promise<{ ok: boolean }>;
  remove: (payload: { projectId: string }) => Promise<{ ok: boolean }>;
  createFromTenderFile: (payload: { filePaths: string[] }) => Promise<{ projectId: string; name: string; importResult: unknown }>;
  onActiveChanged: (callback: (payload: { projectId: string | null }) => void) => () => void;
};
```

- [ ] **Step 7: 冒烟 + 构建 + Commit**（`feat: IPC 接线（projects通道/缺省当前项目路由/隐藏调用面getter化/类型）`）

```powershell
node --check electron/ipc/index.cjs; node --check electron/ipc/projectsIpc.cjs
npm run build
```

---

### Task 10: 图片资产项目化路由（spec §4.1，评审 Issue 1——不修则迁移后全部图片断链）

**Files:**
- Modify: `client/electron/main.cjs`（:259-293 registerAssetProtocol）
- Modify: `client/electron/services/exportService.cjs`（:1532-1553 resolveAssetImagePath）
- Modify: `client/electron/services/duplicateCheckService.cjs`（:2085-2098 resolveAssetPath）
- Modify: `client/electron/services/aiService.cjs`（:489-501 saveGeneratedImage）
- Modify: `client/electron/services/storageCleanupService.cjs`（:57-97 clearOrphanedGeneratedImages）
- Modify: `client/electron/ipc/index.cjs`（注入资产根 getter）

**机制**：三处协议解析 + 生图写入 + 孤儿清理的资产根，统一改为注入的 getter：`getGeneratedImagesRoot()` / `getImportedImagesRoot()`——有当前项目时返回 `<projectDir>/workspace/<dir>`，无项目回退全局根（credential-library 恒全局）。

- [ ] **Step 1: index.cjs 定义资产根 getter 并注入**

```js
  const getGeneratedImagesRoot = () => {
    const pid = projectStoreRegistry.getCurrentProjectId();
    return pid ? path.join(getProjectsRootDir(app), pid, 'workspace', 'generated-images')
               : getGeneratedImagesDir(app);
  };
  // getImportedImagesRoot 同构
```

注入到：main.cjs registerAssetProtocol（assetRoots 的 generated-images/imported-images 两项换 getter）、exportService、duplicateCheckService、aiService、storageCleanupService（构造参数追加，缺省回退原 paths 函数——保持单测可注入）。

- [ ] **Step 2: main.cjs 协议处理器（:259-293）**

assetRoots 中 `'generated-images'` / `'imported-images'` 两项的值改为调用注入 getter（registerAssetProtocol 需要能拿到最新值——getter 每次请求时求值，勿在注册时固化）。`credential-library` 保持原全局路径。

- [ ] **Step 3: exportService / duplicateCheckService 解析点**

:1532-1553、:2085-2098 两处资产路径解析换用注入 getter（这两个服务在 index.cjs 构造，构造参数加 getter，内部路径函数改调 getter）。

- [ ] **Step 4: aiService 生图写入落点（:489-501）**

saveGeneratedImage 写盘目录改用注入的 getGeneratedImagesRoot()（aiService 是全局单例，无法用 projectApp 代理——必须走 getter）。⚠️ URL 生成处 `yibiao-asset://generated-images/<file>` 格式不变（渲染层存量引用兼容），只是磁盘落点换根。

- [ ] **Step 5: 孤儿清理逐项目化（storageCleanupService :57-97 + 调用点 index.cjs:290）**

clearOrphanedGeneratedImages(app, db) 改签名为 `clearOrphanedGeneratedImages({ app, forEachProject })`：对 registry 每个 active 项目——打开该项目库（只读）收集 `technical_plan_outline_nodes.content` 的 `yibiao-asset://generated-images/...` 引用集 → 清理该项目 generated-images 根下未引用文件；全局根（迁移后应已空）做一次兜底清理。**引用查询失败的项目跳过并告警，绝不清图**。

- [ ] **Step 6: mermaidCache 调用点核查**

```powershell
Select-String -Path electron/**/*.cjs,electron/*.cjs -Pattern "mermaidCache|getMermaidCacheDir" | Select-Object Path,LineNumber
```

三域 store 内的调用（经 projectApp）已自动项目化 ✓；**全局上下文的调用点**（如全局 app 构造的服务/IPC）改传当前项目资产根（getter 注入同 Step 1）。

- [ ] **Step 7: 冒烟 + 构建 + Commit**（`feat: 图片资产项目化路由（协议三处/生图落点/孤儿清理/mermaid核查）`）

```powershell
node --check electron/main.cjs; node --check electron/services/storageCleanupService.cjs
npm run build
```

---

### Task 11: 前端基础设施（useProjects + 切换器 + key 重挂载）

**Files:**
- Create: `client/src/features/projects/useProjects.ts`
- Create: `client/src/features/projects/ProjectSwitcher.tsx`
- Modify: `client/src/App.tsx`（:15 activeSection、:39-47 leaveGuard）
- Modify: `client/src/components/AppShell.tsx`（:14-20）
- Modify: `client/src/app/AppRouter.tsx`（:44-81）

- [ ] **Step 1: useProjects hook**

```ts
import { useCallback, useEffect, useState } from 'react';
import type { ProjectInfo } from '../../../shared/types/ipc';

export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.yibiao?.projects.list();
    if (result) { setProjects(result.projects); setActiveProjectId(result.activeProjectId); }
  }, []);

  useEffect(() => { refresh(); return window.yibiao?.projects.onActiveChanged(() => { refresh(); }); }, [refresh]);

  const switchTo = useCallback(async (projectId: string | null) => {
    setSwitching(true);
    try { await window.yibiao?.projects.setActive(projectId); await refresh(); } finally { setSwitching(false); }
  }, [refresh]);

  return { projects, activeProjectId, switching, refresh, switchTo };
}
```

- [ ] **Step 2: App.tsx 集成**

- 顶层 `const { activeProjectId, switching } = useProjects();`
- `<AppRouter ... key={activeProjectId ?? 'none'}>`（key 变更=整树重挂载=全量 rehydrate，spec §8/D5③）
- switching 期间渲染全屏加载遮罩（复用 InlineSpinner）禁用交互
- 首启无 active 且列表非空 → useEffect 里自动 `switchTo(projects[0].id)`

- [ ] **Step 3: ProjectSwitcher（AppShell 顶栏）**

原生 `<select>`（值=activeProjectId）+「管理项目」入口（置空 active → 列表页）+ 新建按钮（跳列表页）。切换前 leaveGuard 沿用 App.tsx 既有确认逻辑（复用 requestSectionChange 的守卫函数）。

- [ ] **Step 4: AppRouter 分流**

`technical-plan` 分支：`!activeProjectId ? <ProjectListPage/> : <TechnicalPlanHome/>`；`duplicate-check / rejection-check` 分支：无 active 渲染 `EmptyState`（文案"请先选择项目"）。（ProjectListPage Task 12 实现，本任务先建占位文件返回 null，保证编译。）

- [ ] **Step 5: 构建 + Commit**（`feat: 前端项目基础设施（useProjects/切换器/key重挂载/空态分流）`）

```powershell
npm run build
```

---

### Task 12: 项目列表页（卡片/新建/重命名/删除）

**Files:**
- Create: `client/src/features/projects/ProjectListPage.tsx`（替换 Task 11 占位）

- [ ] **Step 1: 页面实现（复用 AppDialog / EmptyState / UploadBoard 风格）**

- 卡片：name / gen_summary / last_active_at（相对时间）；点击卡片=switchTo(id)（有运行中任务的卡片加 ⚡ 标记——数据源 Task 13 的 badge state，本任务先不渲染）
- 新建：`<input type="file" accept=".docx,.doc,.wps,.pdf" multiple>` → `window.yibiao.projects.createFromTenderFile({ filePaths })` → 成功后 switchTo(projectId)（错误 toast 提示并保留在列表页；main 侧失败回滚已在 Task 9 Step 3 的 try/catch 内完成）
- 重命名：AppDialog 输入框 → projects.rename → refresh
- 删除：AppDialog 二次确认（显示项目名+「该项目全部数据将被删除」）→ projects.remove → refresh
- 空状态：EmptyState + 引导上传

- [ ] **Step 2: 构建 + Commit**（`feat: 项目列表页（卡片/新建即上传/重命名/删除二次确认/空态）`）

---

### Task 13: 事件过滤 + 后台角标 + AI 项目名回写 + 提问弹窗项目标识

**Files:**
- Modify: `client/src/features/technical-plan/pages/TechnicalPlanHome.tsx`（:419-431 订阅块）
- Modify: 查重/废标页面订阅块（duplicate-check :692、rejection-check :839 对应文件——grep `onTaskEvent` 定位）
- Modify: `client/src/features/projects/useProjects.ts` 或 App.tsx（badge state）
- Modify: `client/electron/services/taskService.cjs`（outline 完成回写点）

- [ ] **Step 1: 事件过滤（三个订阅块同改）**

回调第一行：

```ts
    const eventProjectId = (event.task as { project_id?: string | null } | undefined)?.project_id ?? null;
    if (eventProjectId && eventProjectId !== activeProjectIdRef.current) return;
```

（activeProjectIdRef 为 useRef 镜像，避免订阅闭包过期。）

- [ ] **Step 2: 后台项目角标**

App.tsx 订阅 onTaskEvent（独立于页面订阅，频道是广播）：维护 `Map<projectId, activeCount>`（task.status 为运行中状态集合则 +1——对照 isActiveTaskStatus 的状态名：running/pausing/awaiting_confirmation 等，以 taskService.cjs isActiveTaskStatus 实现为准）；顶栏切换器旁渲染「⚡ N 个项目运行中」，点击展开运行中项目名列表→点击项目名=switchTo。

- [ ] **Step 3: AI 项目名回写**

`Select-String -Path electron/services/*.cjs -Pattern "outline_project_name"` 定位 outline 结果落库点（technicalPlanStore.cjs :1323/:1370 附近）——在 outline 任务完成、outline_project_name 成功写入后调用注入回调 `deps?.onProjectNameExtracted?.(projectId, name)`；index.cjs 接线为 `projectRegistry.updateNameFromAi.bind(projectRegistry)`。⚠️ name 为空不调用；手动改过名（manual）registry 内部自动跳过。

- [ ] **Step 4: agent 提问弹窗项目标识（spec §5.3，消费 Task 7 Step 5 的 projectName）**

`Select-String -Path src -Pattern "pendingQuestion|requestUserQuestion|visibleQuestion" -List` 定位提问弹窗组件——双项目并发时弹窗标题/正文显示归属项目名（projectName 非空时；feasibility 的 null 不显示标识）。

- [ ] **Step 5: 构建 + Commit**（`feat: 任务事件按项目过滤 + 后台运行角标 + AI 提取项目名回写 + 提问弹窗项目标识`）

---

### Task 14: 集成验证（CDP + 真实迁移实测）

**Files:** 无新代码（验证任务；发现问题回改对应 Task）

- [ ] **Step 1: 单测全绿**

```powershell
node --test test/projectKeys.test.cjs test/projectRegistry.test.cjs test/projectStoreRegistry.test.cjs test/projectMigration.test.cjs
```

- [ ] **Step 2: dev 启动 + 存量迁移实测（先备份！）**

```powershell
npm run dev
```

⚠️ dev 与正式版共用 userData——**启动前手动复制 `%APPDATA%\yibiao-client` 整目录作备份**。Expected: 首启触发存量迁移（日志 `[migration] 存量迁移完成 → 项目 ...`），老项目出现在列表且数据完整（55 节状态、招标文件、导出可用）。**关闭 dev 后核对正式版数据目录已按新结构落位。**

- [ ] **Step 3: CDP 集成验证（复用 `D:\Neo\Neo\tmp\cdp_eval.mjs` 模式，端口 9222）**

清单逐项验证并记录（双项目并行/隔离/切换/图片资产）：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 新建项目 B（上传第二份招标文件） | 列表出现 B（文件名即名），当前切到 B，向导从步骤 1 开始 |
| 2 | 项目 A 数据隔离 | 切回 A：小节树/生成状态/设置与迁移后一致，无 B 的数据混入 |
| 3 | 双项目并行生成 | A 启动正文生成 → 切到 B 启动标书分析 → 两边任务同时推进，task_logs 各自增长，正文落各自目录 |
| 4 | 切走不中断 | A 生成中切到 B 再切回，A 任务仍在跑（进度连续） |
| 5 | 顶栏角标 | 在 B 时 A 有运行任务 → 角标「⚡ 1 个项目运行中」，点击可见 A |
| 6 | 任务互斥语义 | A 与 B 各自内部 group 互斥仍生效（A 正文生成中再点 A 标书分析应报冲突） |
| 7 | AI 项目名回写 | B 走到目录生成后项目名从文件名更新为 AI 提取名；手动改名后再生成目录不改名 |
| 8 | 删除项目 | 删除 B：确认弹窗 → B 从列表消失，A 不受影响，目录物理删除 |
| 9 | 重启恢复 | 关闭应用重开：恢复上次活跃项目；A 若生成中被杀，重启后该项目任务转 paused 可继续 |
| 10 | 导出 | A 导出 docx：文件名规则不变、内容来自 A 库 |
| 11 | 图片资产（评审补） | 迁移项目的小节配图/mermaid 图在 UI 正常显示且导出 docx 带图；新建项目生成 1 张 AI 配图 → 图片落 `projects/<id>/workspace/generated-images/`，另一项目重置不误删；查重页图片渲染正常 |

- [ ] **Step 4: 验证记录落档**

把 11 项结果写入 `docs/superpowers/plans/2026-10-30-multi-project-support-verification.md`（沿用上一功能验证记录格式），commit。

- [ ] **Step 5: 收尾 Commit**（`docs: 多项目支持集成验证记录`）

---

## 执行顺序与依赖

```
T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14
                └──────────┴──────┴──────┘
              （T5/T6/T7 可与 T8 并行；T9 依赖 T6-T8 全部完成；T10/T11 依赖 T9，可并行）
```

## 风险提示（给执行者）

1. **Task 6/7 是全计划最高危**——taskService 1726 行，影子绑定模式务必逐方法核对 slot 键与 project_id 贯穿（含 Step 5 列出的 6 处闭包读取点）；每改 3-4 个方法跑一次 `node --check`。
2. **Task 9 接线后首启即触发真实迁移**——执行 Task 9 前先手动备份 `%APPDATA%\yibiao-client`（Task 14 Step 2 已重复强调，接线冒烟也用备份副本环境变量 ELECTRON_USER_DATA 若不可用则只做 node 层冒烟，真实启动留给 T14）。
3. **Task 10 不做完禁止进入 T14 真机验证**——图片断链在功能验证里最隐蔽，验证清单 #11 专查。
4. 任何一步发现 spec 与代码现实冲突 → 停下报告，不要自作主张改设计。
