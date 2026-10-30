const fs = require('node:fs');
const path = require('node:path');
const { createPiEnvironmentLayout } = require('./piEnvironment.cjs');
const { getProjectsRootDir } = require('../../utils/paths.cjs');
const { isValidProjectId } = require('../../utils/projectKeys.cjs');

const PRIMARY_SESSION_FILE = 'primary-session.json';

// 主会话按槽位持久化：projectId 真值 → projects/<id>/agent-runtime/pi/primary-session.json（随项目目录删除）；
// 缺省 → 全局 agent-runtime/pi/primary-session.json（feasibility/全域槽）。
function getPrimarySessionFile(app, projectId) {
  if (projectId) {
    if (!isValidProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
    return path.join(getProjectsRootDir(app), projectId, 'agent-runtime', 'pi', PRIMARY_SESSION_FILE);
  }
  return path.join(createPiEnvironmentLayout(app).runtimeRoot, PRIMARY_SESSION_FILE);
}

function normalizePrimarySession(value = {}) {
  const taskId = String(value.task_id || '').trim();
  const taskKey = String(value.task_key || '').trim();
  const sessionId = String(value.session_id || '').trim();
  if (!taskId && !taskKey) return null;
  return {
    task_id: taskId,
    task_key: taskKey,
    session_id: sessionId,
    updated_at: String(value.updated_at || new Date().toISOString()),
  };
}

function loadPrimaryAgentSession(app, projectId) {
  const filePath = getPrimarySessionFile(app, projectId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizePrimarySession(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

function savePrimaryAgentSession(app, value, projectId) {
  const normalized = normalizePrimarySession({
    ...value,
    updated_at: new Date().toISOString(),
  });
  if (!normalized) {
    clearPrimaryAgentSession(app, projectId);
    return null;
  }
  const filePath = getPrimarySessionFile(app, projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

function clearPrimaryAgentSession(app, projectId) {
  fs.rmSync(getPrimarySessionFile(app, projectId), { force: true });
}

module.exports = {
  clearPrimaryAgentSession,
  loadPrimaryAgentSession,
  savePrimaryAgentSession,
};
