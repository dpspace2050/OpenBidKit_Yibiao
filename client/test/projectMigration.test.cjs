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

// 老全局库的三域代表表（6/32，表结构最小化、列名与显式列交集复制兼容——覆盖项目侧 NOT NULL 无默认列）
// 与种子数据；抽成函数供重放测试重建现场（崩溃发生在 drop-tables 前 → 全局三域表仍在、数据未动）。
// duplicate_check_files / duplicate_check_outline_items 携真实外键（与 sqliteDatabase.cjs 生产 DDL 一致）：
// FK ON 的连接上按 THREE_DOMAIN_TABLES 顺序先 DROP 父表，再 DROP 子表会报
// "no such table: main.duplicate_check_files"（真实存量库迁移失败根因）。
function seedLegacyGlobalDb(db) {
  db.exec(`
    CREATE TABLE technical_plan_meta (
      id INTEGER PRIMARY KEY,
      outline_project_name TEXT,
      tender_files_json TEXT,
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
    CREATE TABLE duplicate_check_files (
      file_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      extension TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      modified_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE duplicate_check_outline_items (
      item_id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      parent_item_id TEXT,
      level INTEGER NOT NULL,
      number TEXT,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      path_titles_json TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      from_tender INTEGER NOT NULL DEFAULT 0,
      matched_tender_sentence TEXT,
      FOREIGN KEY (file_id) REFERENCES duplicate_check_files(file_id) ON DELETE CASCADE,
      FOREIGN KEY (parent_item_id) REFERENCES duplicate_check_outline_items(item_id) ON DELETE CASCADE
    );
    CREATE TABLE rejection_check_meta (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO technical_plan_meta (id, outline_project_name, created_at, updated_at) VALUES (1, '老项目', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO technical_plan_outline_nodes (node_id, title, sort_order, level, created_at, updated_at) VALUES ('node-1', '老节点', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO duplicate_check_meta (id, created_at, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO duplicate_check_files (file_id, role, file_name, file_path, extension, created_at, updated_at) VALUES ('file-1', 'bid', '查重文件1.docx', 'duplicate-check/查重文件1.docx', '.docx', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO duplicate_check_outline_items (item_id, file_id, level, title, normalized_title, path_titles_json, normalized_path, source) VALUES ('item-1', 'file-1', 1, '第一章', '第一章', '[\"第一章\"]', '第一章', 'outline')").run();
  db.prepare("INSERT INTO rejection_check_meta (id, created_at, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
}

// 合成老布局：全局库（workspace/yibiao.sqlite）只建三域代表表，目录为迁移前的平铺结构。
function makeLegacyEnv(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = makeFakeApp(root);
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const globalDbPath = path.join(workspaceDir, 'yibiao.sqlite');
  const globalDb = new Database(globalDbPath);
  // 与生产一致：createSqliteDatabase 打开全局库即 foreign_keys = ON（sqliteDatabase.cjs），
  // fixture 必须复现该连接状态才能触发 FK ON 下的 DROP 顺序失败。
  globalDb.pragma('foreign_keys = ON');
  seedLegacyGlobalDb(globalDb);
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
  // FK 两表数据完整复制（子表 FK 行不丢）
  assert.equal(pdb.prepare('SELECT COUNT(*) AS n FROM duplicate_check_files').get().n, 1);
  assert.equal(pdb.prepare('SELECT COUNT(*) AS n FROM duplicate_check_outline_items').get().n, 1);
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
  env.globalDb.exec('DELETE FROM technical_plan_meta; DELETE FROM technical_plan_outline_nodes; DELETE FROM duplicate_check_meta; DELETE FROM duplicate_check_outline_items; DELETE FROM duplicate_check_files; DELETE FROM rejection_check_meta;');
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

test('重放幂等：copy 事务已提交但未 mark → 续跑 INSERT OR REPLACE 不撞 PK（meta 行数仍 1）', () => {
  const env = makeLegacyEnv('yibiao-mig-replay-');
  const first = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(first.migrated, true);
  const projectId = first.projectId;

  // 模拟崩溃窗口：copy 事务已提交、doneSteps 未记录 copy-tables；
  // 此时 drop-tables 必然也未执行 → 重建全局三域表与数据还原现场
  seedLegacyGlobalDb(env.globalDb);
  fs.writeFileSync(journalPath(env.app), JSON.stringify({ status: 'migrating', projectId, doneSteps: ['backup'] }, null, 2));

  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(result.migrated, true, `重放应续跑成功而非撞 PK: ${result.error || ''}`);
  assert.equal(result.projectId, projectId);

  // OR REPLACE 幂等实锤：重放复制后 meta 行数仍为 1（旧行为 INSERT 撞 PK 抛错 → failCount 假累积）
  const check = new Database(path.join(env.root, 'workspace', 'projects', projectId, 'project.sqlite'), { readonly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM technical_plan_meta').get().n, 1);
  check.close();

  const journal = JSON.parse(fs.readFileSync(journalPath(env.app), 'utf8'));
  assert.equal(journal.status, 'done');
  assert.equal(env.registry.list().length, 1, '续跑不重复建项目');
  const globalTables = tableNames(env.globalDb);
  for (const t of THREE_DOMAIN_TABLES) assert.ok(!globalTables.has(t), `重放后全局表应再次 DROP: ${t}`);

  env.globalDb.close();
});

test('fatal 粘性：journal status=failed → 短路返回 fatal:true（error 含 boom），不产生新项目/不动目录', () => {
  const env = makeLegacyEnv('yibiao-mig-fatal-');
  fs.mkdirSync(path.dirname(journalPath(env.app)), { recursive: true });
  fs.writeFileSync(journalPath(env.app), JSON.stringify({ status: 'failed', projectId: 'x', error: 'boom' }, null, 2));

  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(result.migrated, false);
  assert.equal(result.fatal, true);
  assert.equal(result.projectId, 'x');
  assert.ok(String(result.error).includes('boom'), `error 应含此前记录的 boom: ${result.error}`);
  assert.equal(result.backupDir, path.join(env.root, 'workspace', 'projects', '.legacy-backup'));

  // 停机信号生效：不重跑、不覆盖 journal、现场原样
  assert.equal(env.registry.list().length, 0, '不应创建新项目');
  assert.ok(!fs.existsSync(path.join(env.root, 'workspace', 'projects', 'x')), '不应建项目目录');
  assert.ok(fs.existsSync(path.join(env.workspaceDir, 'technical-plan', 'tender.md')), '老目录应原样未动');
  const journal = JSON.parse(fs.readFileSync(journalPath(env.app), 'utf8'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.error, 'boom');

  env.globalDb.close();
});

test('项目名三级回退：outline_project_name 为 NULL + tender_files_json 有文件 → 项目名=第一份文件名去扩展名', () => {
  const env = makeLegacyEnv('yibiao-mig-name-');
  // 真实存量库实锤：AI 提取名未落库时 outline_project_name 为 NULL，
  // 第一份招标文件名（technicalPlanStore 的 tender_files_json 结构，字段 fileName）兜底。
  env.globalDb.prepare('UPDATE technical_plan_meta SET outline_project_name = NULL, tender_files_json = ? WHERE id = 1').run(JSON.stringify([
    { id: 'tender-01', fileName: '白朗县光储电站EPC总承包招标文件20261008(1)(1).doc', markdownPath: 'technical-plan/tender-files/tender-01.md' },
    { id: 'tender-02', fileName: '第二份招标文件.pdf', markdownPath: 'technical-plan/tender-files/tender-02.md' },
  ]));

  const result = runLegacyMigration({ app: env.app, globalDb: env.globalDb, registry: env.registry });
  assert.equal(result.migrated, true);

  const list = env.registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '白朗县光储电站EPC总承包招标文件20261008(1)(1)', '应取第一份文件名并去掉 .doc 扩展名');

  env.globalDb.close();
});
