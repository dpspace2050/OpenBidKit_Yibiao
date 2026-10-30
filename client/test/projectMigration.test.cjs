'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createProjectRegistry } = require('../electron/services/projectRegistry.cjs');
const { THREE_DOMAIN_TABLES, ensureProjectSchemaHealth } = require('../electron/services/sqliteDatabase.cjs');
const { runLegacyMigration, journalPath } = require('../electron/services/projectMigration.cjs');

function makeFakeApp(root) {
  return { getPath: (name) => (name === 'userData' ? root : path.join(root, name)) };
}

function putFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
}

// 合成老布局：全局库（workspace/yibiao.sqlite）只建三域代表表（4/32，表结构最小化、
// 列名与显式列交集复制兼容——覆盖项目侧 NOT NULL 无默认列），目录为迁移前的平铺结构。
function makeLegacyEnv(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = makeFakeApp(root);
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const globalDbPath = path.join(workspaceDir, 'yibiao.sqlite');
  const globalDb = new Database(globalDbPath);
  globalDb.exec(`
    CREATE TABLE technical_plan_meta (
      id INTEGER PRIMARY KEY,
      outline_project_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE technical_plan_outline_nodes (
      node_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      level INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE duplicate_check_meta (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE rejection_check_meta (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  globalDb.prepare("INSERT INTO technical_plan_meta (id, outline_project_name, created_at, updated_at) VALUES (1, '老项目', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  globalDb.prepare("INSERT INTO technical_plan_outline_nodes (node_id, title, sort_order, level, created_at, updated_at) VALUES ('node-1', '老节点', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  globalDb.prepare("INSERT INTO duplicate_check_meta (id, created_at, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  globalDb.prepare("INSERT INTO rejection_check_meta (id, created_at, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  putFile(path.join(workspaceDir, 'technical-plan', 'tender.md'), '# 标书');
  putFile(path.join(workspaceDir, 'duplicate-check', 'contents', 'f1.md'), '查重文件');
  putFile(path.join(workspaceDir, 'rejection-check', 'bids', 'd1.md'), '废标文件');
  putFile(path.join(workspaceDir, 'generated-images', 'img1.png'), 'png-generated');
  putFile(path.join(workspaceDir, 'imported-images', 'b1.png'), 'png-imported');
  putFile(path.join(root, 'logs', 'technical-plan', 'log.txt'), 'log');
  putFile(path.join(root, 'agent-runtime', 'pi', 'tasks', 'technical-plan-outline-generation', 'task-state.json'), '{}');
  const registry = createProjectRegistry({ db: globalDb });
  return { root, app, workspaceDir, globalDb, globalDbPath, registry };
}

test('存量迁移主流程：表复制/目录搬迁/全局DROP/registry激活 + journal 幂等（断言1-7）', () => {
  const env = makeLegacyEnv('yibiao-mig-main-');
  // globalDb.name 是 better-sqlite3 的库文件路径属性（实现依赖它做备份与 ATTACH）——先验证
  assert.equal(env.globalDb.name, env.globalDbPath);

  const statuses = [];
  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry, onStatus: (msg) => statuses.push(msg) });
  assert.equal(result.migrated, true);
  const projectId = result.projectId;
  assert.match(projectId, /^\d{8}-[a-z0-9]{6}$/);
  assert.ok(statuses.some((m) => m.includes('存量迁移完成')));

  const projectDir = path.join(env.root, 'workspace', 'projects', projectId);
  const projectDbPath = path.join(projectDir, 'project.sqlite');

  // 断言1：项目库存在，三域数据完整（项目库由 ensureProjectSchemaHealth 建全 32 表，列交集复制补齐）
  assert.ok(fs.existsSync(projectDbPath), 'project.sqlite 应存在');
  const pdb = new Database(projectDbPath, { readonly: true });
  const projectTables = tableNames(pdb);
  for (const t of THREE_DOMAIN_TABLES) assert.ok(projectTables.has(t), `项目库缺表 ${t}`);
  const meta = pdb.prepare('SELECT * FROM technical_plan_meta WHERE id = 1').get();
  assert.equal(meta.outline_project_name, '老项目');
  assert.equal(meta.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(meta.updated_at, '2026-01-02T00:00:00.000Z');
  assert.equal(pdb.prepare('SELECT COUNT(*) AS n FROM technical_plan_outline_nodes').get().n, 1);
  assert.equal(pdb.prepare('SELECT COUNT(*) AS n FROM duplicate_check_meta').get().n, 1);
  assert.equal(pdb.prepare('SELECT COUNT(*) AS n FROM rejection_check_meta').get().n, 1);
  pdb.close();

  // 断言2：目录搬迁到位（工作区目录 / agent 会话前缀目录 / 模块日志）
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'technical-plan', 'tender.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'duplicate-check', 'contents', 'f1.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'rejection-check', 'bids', 'd1.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'generated-images', 'img1.png')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'imported-images', 'b1.png')));
  assert.ok(fs.existsSync(path.join(projectDir, 'agent-runtime', 'pi', 'tasks', `${projectId}_technical-plan-outline-generation`, 'task-state.json')));
  assert.ok(fs.existsSync(path.join(projectDir, 'logs', 'technical-plan', 'log.txt')));
  // 老位置已腾空（是搬迁不是复制）
  assert.ok(!fs.existsSync(path.join(env.workspaceDir, 'technical-plan')));
  assert.ok(!fs.existsSync(path.join(env.workspaceDir, 'duplicate-check')));
  assert.ok(!fs.existsSync(path.join(env.workspaceDir, 'rejection-check')));
  assert.ok(!fs.existsSync(path.join(env.workspaceDir, 'generated-images')));
  assert.ok(!fs.existsSync(path.join(env.workspaceDir, 'imported-images')));
  assert.ok(!fs.existsSync(path.join(env.root, 'logs', 'technical-plan')));
  assert.ok(!fs.existsSync(path.join(env.root, 'agent-runtime', 'pi', 'tasks', 'technical-plan-outline-generation')));

  // 断言3：全局库三域表已 DROP
  const globalTables = tableNames(env.globalDb);
  for (const t of THREE_DOMAIN_TABLES) assert.ok(!globalTables.has(t), `全局库三域表未 DROP: ${t}`);
  assert.ok(globalTables.has('projects'), 'projects 注册表仍在全局库');

  // 断言4：registry 有 1 个 active 项目，名称来自老库、name_source='ai'
  const list = env.registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, projectId);
  assert.equal(list[0].name, '老项目');
  assert.equal(list[0].name_source, 'ai');
  assert.equal(list[0].status, 'active');

  // 断言5：再跑一次是 no-op
  const again = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(again.migrated, false);

  // 断言6：journal 落盘 status='done' 且 projectId 与 registry 一致
  const journal = JSON.parse(fs.readFileSync(journalPath(env.app), 'utf8'));
  assert.equal(journal.status, 'done');
  assert.equal(journal.projectId, projectId);
  assert.deepEqual(journal.doneSteps, ['backup', 'copy-tables', 'move-dirs', 'move-agent-sessions', 'drop-tables']);

  // 断言7：全局库备份存在
  assert.ok(fs.existsSync(path.join(env.root, 'workspace', 'projects', '.legacy-backup', 'yibiao.sqlite')));

  env.globalDb.close();
});

test('断言8 全新安装：三域表全空 → 直接清理（cleanedFresh），不建项目', () => {
  const env = makeLegacyEnv('yibiao-mig-fresh-');
  env.globalDb.exec('DELETE FROM technical_plan_meta; DELETE FROM technical_plan_outline_nodes; DELETE FROM duplicate_check_meta; DELETE FROM rejection_check_meta;');
  for (const dir of ['technical-plan', 'duplicate-check', 'rejection-check', 'generated-images', 'imported-images']) {
    fs.rmSync(path.join(env.workspaceDir, dir), { recursive: true, force: true });
  }
  fs.rmSync(path.join(env.root, 'logs'), { recursive: true, force: true });
  fs.rmSync(path.join(env.root, 'agent-runtime'), { recursive: true, force: true });

  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.deepEqual(result, { migrated: false, cleanedFresh: true });

  const globalTables = tableNames(env.globalDb);
  for (const t of THREE_DOMAIN_TABLES) assert.ok(!globalTables.has(t), `全新安装清理后仍残留: ${t}`);
  assert.equal(env.registry.list().length, 0, '不应创建项目');
  assert.ok(!fs.existsSync(path.join(env.root, 'workspace', 'projects')), '不应产生 projects 目录/journal');

  env.globalDb.close();
});

test('加分项 断点续跑：journal=migrating 且 backup/copy-tables 已完成 → 续跑补齐且不重复复制', () => {
  const env = makeLegacyEnv('yibiao-mig-resume-');
  const projectId = '20261030-r3sum3';
  env.registry.create({ id: projectId, name: '老项目', nameSource: 'ai' });
  env.registry.markMigrating(projectId);
  const projectDir = path.join(env.root, 'workspace', 'projects', projectId);

  // 已完成 copy-tables 的项目库：健康检查建全表 + meta 行已复制到位
  fs.mkdirSync(projectDir, { recursive: true });
  const pdb = new Database(path.join(projectDir, 'project.sqlite'));
  ensureProjectSchemaHealth(pdb);
  pdb.prepare("INSERT INTO technical_plan_meta (id, outline_project_name, created_at, updated_at) VALUES (1, '老项目', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  pdb.close();

  // 已搬一半：technical-plan 已进项目目录，其余仍在老位置
  fs.mkdirSync(path.join(projectDir, 'workspace'), { recursive: true });
  fs.renameSync(path.join(env.workspaceDir, 'technical-plan'), path.join(projectDir, 'workspace', 'technical-plan'));

  // 手工 journal：备份与复制已完成
  fs.mkdirSync(path.dirname(journalPath(env.app)), { recursive: true });
  fs.writeFileSync(journalPath(env.app), JSON.stringify({ status: 'migrating', projectId, doneSteps: ['backup', 'copy-tables'] }, null, 2));

  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(result.migrated, true);
  assert.equal(result.projectId, projectId);

  // 不重复复制：technical_plan_meta 主键 id=1，若重跑复制必然冲突失败；迁移成功且行数仍为 1 即证明跳过
  const check = new Database(path.join(projectDir, 'project.sqlite'), { readonly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM technical_plan_meta').get().n, 1);
  check.close();

  // 续跑补齐搬迁 / 全局 DROP / 激活 / journal done
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'duplicate-check', 'contents', 'f1.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'rejection-check', 'bids', 'd1.md')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'generated-images', 'img1.png')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'imported-images', 'b1.png')));
  assert.ok(fs.existsSync(path.join(projectDir, 'agent-runtime', 'pi', 'tasks', `${projectId}_technical-plan-outline-generation`, 'task-state.json')));
  assert.ok(fs.existsSync(path.join(projectDir, 'logs', 'technical-plan', 'log.txt')));
  assert.ok(fs.existsSync(path.join(projectDir, 'workspace', 'technical-plan', 'tender.md')), '已搬过的目录不被破坏');
  const globalTables = tableNames(env.globalDb);
  for (const t of THREE_DOMAIN_TABLES) assert.ok(!globalTables.has(t));
  const list = env.registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, projectId);
  assert.equal(list[0].status, 'active');
  const journal = JSON.parse(fs.readFileSync(journalPath(env.app), 'utf8'));
  assert.equal(journal.status, 'done');

  env.globalDb.close();
});
