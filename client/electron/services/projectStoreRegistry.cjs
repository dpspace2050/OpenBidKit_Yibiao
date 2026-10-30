'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getProjectsRootDir } = require('../utils/paths.cjs');
const { ensureProjectSchemaHealth } = require('./sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('./technicalPlanStore.cjs');
const { createDuplicateCheckStore } = require('./duplicateCheckStore.cjs');
const { createRejectionCheckStore } = require('./rejectionCheckStore.cjs');

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
  const openErrors = new Map(); // projectId -> message（打开失败标错，spec §10）
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
    // technicalPlanStore 需感知 projectId：store 内部清理 Agent 持久会话时按项目前缀键路由
    const technicalPlanStore = createTechnicalPlanStore({ app: projectApp, db, fileService, agentService, taskLogStore, configStore, projectId });
    const duplicateCheckStore = createDuplicateCheckStore({ app: projectApp, db, taskLogStore });
    const rejectionCheckStore = createRejectionCheckStore({ app: projectApp, db, fileService, technicalPlanStore, taskLogStore });
    return { projectId, db, projectApp, technicalPlanStore, duplicateCheckStore, rejectionCheckStore, refCount: 0, lastUsed: ++seq };
  }

  function getContext(projectId) {
    let ctx = contexts.get(projectId);
    if (!ctx) {
      try {
        ctx = buildContext(projectId);
        openErrors.delete(projectId);
      } catch (error) {
        openErrors.set(projectId, String(error?.message || error)); // spec §10：标错隔离，不拖垮其他项目
        throw Object.assign(new Error(`项目打开失败: ${openErrors.get(projectId)}`), { code: 'PROJECT_OPEN_FAILED', projectId });
      }
      contexts.set(projectId, ctx);
      evictIfNeeded(projectId); // 新建 ctx 排除在本轮淘汰候选外——池满且其余全被钉住时不能把自己淘汰成僵尸连接
      try { onProjectOpened?.(projectId, storesOf(ctx)); } catch (error) { console.warn('[project-registry] 项目打开回调失败', error); }
    }
    ctx.lastUsed = ++seq;
    return ctx;
  }

  function evictIfNeeded(excludeProjectId) {
    if (contexts.size <= maxOpenProjects) return;
    const evictable = [...contexts.values()].filter((c) => c.refCount === 0 && c.projectId !== excludeProjectId).sort((a, b) => a.lastUsed - b.lastUsed);
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
  // 项目名供任务提问面板等展示用（agentService 不直接依赖 registry，经调用侧传入）
  function getProjectName(projectId) {
    return registry.get(projectId)?.name || null;
  }
  function getOpenErrors() { return Object.fromEntries(openErrors); }
  function openProjectIds() { return [...contexts.keys()]; }
  // 删除项目前必须先关它的连接（Windows 下句柄打开中 rmSync 必 EBUSY——审计B Issue 2）
  function closeProject(projectId) {
    const ctx = contexts.get(projectId);
    if (!ctx) return;
    contexts.delete(projectId);
    try { ctx.db.close(); } catch (_) {}
  }
  function closeAll() { for (const ctx of contexts.values()) { try { ctx.db.close(); } catch (_) {} } contexts.clear(); }

  return { getContext, acquire, resolveStores, setCurrent, getCurrentProjectId, getProjectName, getOpenErrors, closeProject, openProjectIds, closeAll, createProjectAppProxy };
}

module.exports = { createProjectStoreRegistry, createProjectAppProxy };
