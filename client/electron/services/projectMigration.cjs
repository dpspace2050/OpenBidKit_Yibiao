'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getWorkspaceDir, getProjectsRootDir, getAgentRuntimeDir, getUserDataPath } = require('../utils/paths.cjs');
const { THREE_DOMAIN_TABLES } = require('./sqliteDatabase.cjs');

const LEGACY_AGENT_KEYS = ['technical-plan-outline-generation', 'technical-plan-template-extraction', 'technical-plan-global-facts', 'technical-plan-original-restoration', 'technical-plan-content-generation'];

function journalPath(app) { return path.join(getProjectsRootDir(app), '.legacy-migration.json'); }

function readJournal(app) { try { return JSON.parse(fs.readFileSync(journalPath(app), 'utf8')); } catch (_) { return null; } }
function writeJournal(app, journal) { fs.mkdirSync(path.dirname(journalPath(app)), { recursive: true }); fs.writeFileSync(journalPath(app), JSON.stringify(journal, null, 2)); }

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
  // fatal 粘性：上次已判死（failCount 达阈值）→ 停机信号跨启动持续，绝不自动重跑
  if (journal && journal.status === 'failed') {
    return { migrated: false, fatal: true, projectId: journal.projectId, error: journal.error || '迁移此前已失败', backupDir: path.join(getProjectsRootDir(app), '.legacy-backup') };
  }
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
    const { generateProjectId } = require('../utils/projectKeys.cjs');
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

  try {
    if (!done('backup')) {
      const backupDir = path.join(projectsRoot, '.legacy-backup');
      fs.mkdirSync(backupDir, { recursive: true });
      globalDb.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(globalDb.name, path.join(backupDir, 'yibiao.sqlite'));
      mark('backup');
    }

    if (!done('copy-tables')) {
      fs.mkdirSync(projectDir, { recursive: true });
      const pdb = new Database(dbPath);
      try {
        pdb.pragma('journal_mode = WAL');
        const { ensureProjectSchemaHealth } = require('./sqliteDatabase.cjs');
        ensureProjectSchemaHealth(pdb);
        pdb.exec(`ATTACH DATABASE '${globalDb.name.replace(/'/g, "''")}' AS legacy`);
        // 显式列交集复制：SELECT * 按位映射，两库列序不一致会静默错位；
        // INSERT OR REPLACE：copy 事务提交后、mark('copy-tables') 前崩溃的重放幂等（不撞 PK）
        const copy = pdb.transaction(() => {
          for (const t of THREE_DOMAIN_TABLES) {
            const projectCols = pdb.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
            const legacyCols = pdb.prepare(`PRAGMA legacy.table_info(${t})`).all().map((c) => c.name);
            // 老库缺表按空表跳过（与复制零行等价，项目侧仍由 ensureProjectSchemaHealth 建全表）；
            // 表存在但无交集列仍按原计划抛错（schema 漂移防护）。
            if (legacyCols.length === 0) continue;
            const cols = projectCols.filter((c) => legacyCols.includes(c));
            if (cols.length === 0) throw new Error(`复制表失败 ${t}: 无交集列`);
            const colList = cols.join(', ');
            try { pdb.exec(`INSERT OR REPLACE INTO main.${t} (${colList}) SELECT ${colList} FROM legacy.${t}`); } catch (error) { throw new Error(`复制表失败 ${t}: ${error.message}`); }
          }
        });
        copy();
      } finally {
        // 建表/ATTACH/复制任一环抛错都要释放句柄；未成功 ATTACH 时 DETACH 报错可忽略
        try { pdb.exec('DETACH DATABASE legacy'); } catch (_) {}
        pdb.close();
      }
      mark('copy-tables');
    }

    if (!done('move-dirs')) {
      for (const dir of ['technical-plan', 'duplicate-check', 'rejection-check', 'generated-images', 'imported-images']) {
        moveDirSafe(path.join(workspaceDir, dir), path.join(projectDir, 'workspace', dir));
      }
      // 三域模块日志（userData/logs/<module>）：迁入项目 logs/（代理路径 <projectDir>/logs/<module>）
      for (const module of ['technical-plan', 'duplicate-check', 'rejection-check']) {
        moveDirSafe(path.join(getUserDataPath(app), 'logs', module), path.join(projectDir, 'logs', module));
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
  } catch (error) {
    journal.failCount = (journal.failCount || 0) + 1;
    writeJournal(app, journal);
    if (journal.failCount >= 3) {
      journal.status = 'failed';
      journal.error = String(error?.message || error); // 落盘死因，供粘性短路原样带回
      writeJournal(app, journal);
      return { migrated: false, fatal: true, projectId, error: journal.error, backupDir: path.join(projectsRoot, '.legacy-backup') };
    }
    throw error; // 未达阈值：本次启动标错，下次启动幂等续跑
  }

  registry.markActive(projectId);
  journal.status = 'done';
  writeJournal(app, journal);
  log(`存量迁移完成 → 项目 ${projectId}`);
  return { migrated: true, projectId };
}

module.exports = { runLegacyMigration, journalPath };
