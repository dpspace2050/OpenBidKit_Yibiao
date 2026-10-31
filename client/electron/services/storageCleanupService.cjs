const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  getAgentRuntimeDir,
  getGeneratedImagesDir,
  getProjectsRootDir,
  getWorkspaceDir,
} = require('../utils/paths.cjs');
const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');

const STORAGE_CLEANUP_VERSION = 1;
const PERSISTENT_AGENT_TASK_KEYS = [
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
  GLOBAL_FACTS_AGENT_TASK_KEY,
  ORIGINAL_RESTORATION_AGENT_TASK_KEY,
  CONTENT_GENERATION_AGENT_TASK_KEY,
  FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
];
const LEGACY_WORKSPACE_FILES = [
  'technical_plan.json',
  'duplicate_check.json',
  'rejection_check.json',
];

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function clearDirectoryExcept(directory, retainedNames) {
  if (!fs.existsSync(directory)) return;
  const retained = new Set(retainedNames);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (retained.has(entry.name)) continue;
    removePath(path.join(directory, entry.name));
  }
}

// 每次启动清理异常关闭遗留的普通 Pi 任务归档。
function clearStalePiTaskArchives(app) {
  try {
    clearDirectoryExcept(
      path.join(getAgentRuntimeDir(app), 'pi', 'tasks'),
      PERSISTENT_AGENT_TASK_KEYS,
    );
  } catch (error) {
    console.warn('[storage-cleanup] 清理普通 Pi 任务归档失败', error?.message || String(error));
  }
}

function collectGeneratedImageReferences(db) {
  const references = new Set();
  const collect = (value) => {
    const source = String(value || '');
    const pattern = /yibiao-asset:\/\/generated-images\/([^/?#\s"'<>\)]+)/g;
    for (const match of source.matchAll(pattern)) {
      try {
        references.add(decodeURIComponent(match[1]));
      } catch {
        references.add(match[1]);
      }
    }
  };

  db.prepare(`
    SELECT content AS value
    FROM technical_plan_outline_nodes
    WHERE content LIKE '%yibiao-asset://generated-images/%'
  `).all().forEach((row) => collect(row.value));
  return references;
}

// 只读打开项目库收集生图引用；项目库不存在时返回 null（调用侧跳过该项目，绝不清图）。
function collectProjectGeneratedImageReferences(projectDir) {
  const dbPath = path.join(projectDir, 'project.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  try {
    db.pragma('query_only = true');
    return collectGeneratedImageReferences(db);
  } finally {
    try { db.close(); } catch {}
  }
}

// 只清理 generated-images 根目录中的旧生图文件，保留传入的引用集与子目录（mermaid-cache 等沿现状不动）。
function clearUnreferencedRootGeneratedImages(imagesDir, references) {
  if (!fs.existsSync(imagesDir)) return;
  for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
    if (!entry.isFile() || references.has(entry.name)) continue;
    removePath(path.join(imagesDir, entry.name));
  }
}

// 每次启动清理上次异常中断留下的未引用根目录生图（T10 起逐项目化）。
// 对每个 active 项目：只读打开项目库收集 technical_plan_outline_nodes 的生图引用，
// 清理该项目 <projectDir>/workspace/generated-images 根下未引用文件；
// 引用查询失败的项目跳过并 warn，绝不清图。全局根（迁移后应已空/只剩无项目时期文件）
// 以所有项目引用并集做一次兜底清理。
function clearOrphanedGeneratedImages({ app, projects = [] } = {}) {
  const allReferences = new Set();
  for (const project of projects) {
    const projectId = project?.id;
    if (!projectId) continue;
    const projectDir = path.join(getProjectsRootDir(app), projectId);
    try {
      const references = collectProjectGeneratedImageReferences(projectDir);
      if (!references) {
        console.warn(`[storage-cleanup] 项目 ${projectId} 无项目库，跳过该项目生图清理`);
        continue;
      }
      for (const name of references) allReferences.add(name);
      clearUnreferencedRootGeneratedImages(path.join(projectDir, 'workspace', 'generated-images'), references);
    } catch (error) {
      console.warn(`[storage-cleanup] 项目 ${projectId} 生图引用查询失败，跳过该项目清理`, error?.message || String(error));
    }
  }
  try {
    clearUnreferencedRootGeneratedImages(getGeneratedImagesDir(app), allReferences);
  } catch (error) {
    console.warn('[storage-cleanup] 清理未引用生图失败', error?.message || String(error));
  }
}

// 新清理版本首次启动时清除历史遗留；失败不阻止启动，也不写完成标记。
function runHistoricalStorageCleanup({ app, db, configStore, onStatus }) {
  const config = configStore.load();
  if (Number(config.storage_cleanup_version || 0) >= STORAGE_CLEANUP_VERSION) {
    return { completed: true, skipped: true };
  }

  onStatus?.({ phase: 'cleaning', message: '正在清理历史缓存文件' });
  const failures = [];
  const run = (label, action) => {
    try {
      action();
    } catch (error) {
      failures.push({ label, error: error?.message || String(error) });
      console.warn(`[storage-cleanup] ${label}失败`, error?.message || String(error));
    }
  };

  const userDataDir = app.getPath('userData');
  const workspaceDir = getWorkspaceDir(app);
  const agentRuntimeDir = getAgentRuntimeDir(app);
  run('清理旧 Agent 运行目录', () => clearDirectoryExcept(agentRuntimeDir, ['pi']));
  run('清理普通 Pi 任务归档', () => clearDirectoryExcept(
    path.join(agentRuntimeDir, 'pi', 'tasks'),
    PERSISTENT_AGENT_TASK_KEYS,
  ));
  run('清理旧 Agent 缓存', () => removePath(path.join(userDataDir, 'agent-cache')));
  run('清理废弃工作区状态', () => {
    LEGACY_WORKSPACE_FILES.forEach((fileName) => removePath(path.join(workspaceDir, fileName)));
  });
  run('清理未引用的旧生图', () => clearUnreferencedRootGeneratedImages(getGeneratedImagesDir(app), collectGeneratedImageReferences(db)));

  if (!failures.length) {
    run('记录历史清理版本', () => configStore.save({ storage_cleanup_version: STORAGE_CLEANUP_VERSION }));
  }
  return { completed: failures.length === 0, skipped: false, failures };
}

module.exports = {
  STORAGE_CLEANUP_VERSION,
  clearOrphanedGeneratedImages,
  clearStalePiTaskArchives,
  runHistoricalStorageCleanup,
};
