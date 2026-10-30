'use strict';

/**
 * 三域 IPC 的当前项目路由工具（T9）。
 * technicalPlan / duplicateCheck / rejectionCheck 的 store 不再是进程级单例，
 * 每个 IPC handler 在入口解析“当前项目”的实例，并在执行期间持有引用计数，
 * 防止长任务执行中项目上下文被 LRU 淘汰（spec §5.1）。
 */
function createProjectStoreRouting(storeRegistry) {
  if (!storeRegistry) {
    throw new Error('projectStoreRegistry 未初始化，无法路由三域 IPC');
  }

  // resolve 入口统一日志（handler 名 + projectId），便于排查“路由到错误项目”的问题。
  function logRoute(handlerName, projectId) {
    if (handlerName) {
      console.log('[ipc:project-route]', handlerName, projectId || '(no-current-project)');
    }
  }

  function resolveCurrentStores(handlerName = '') {
    const projectId = storeRegistry.getCurrentProjectId();
    logRoute(handlerName, projectId);
    return storeRegistry.resolveStores(projectId);
  }

  // 引用计数包裹：handler 出入口成对 acquire/release。无当前项目时不持有引用，
  // handler 内 resolveCurrentStores 会抛“尚未选择项目”——空态下前端不调用三域 API（T11 分流保证）。
  function withProjectStores(handler, handlerName = '') {
    return async (...args) => {
      const projectId = storeRegistry.getCurrentProjectId();
      logRoute(handlerName, projectId);
      const release = projectId ? storeRegistry.acquire(projectId) : null;
      try {
        return await handler(...args);
      } finally {
        release?.();
      }
    };
  }

  return { resolveCurrentStores, withProjectStores };
}

module.exports = { createProjectStoreRouting };
