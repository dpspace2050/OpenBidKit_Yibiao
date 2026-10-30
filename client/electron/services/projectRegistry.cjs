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
