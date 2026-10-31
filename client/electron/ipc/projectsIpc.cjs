'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { getProjectsRootDir } = require('../utils/paths.cjs');
const { generateProjectId } = require('../utils/projectKeys.cjs');

/**
 * 项目管理 IPC（T9）：列表 / 切换 / 重命名 / 删除 / 从招标文件新建。
 * 注意：必须在 clearWorkspaceDatabaseIpc() 之后注册（覆盖 pending 占位 handler）。
 */
function registerProjectsIpc({ app, registry, storeRegistry, taskService, configStore, agentService, onActiveChanged }) {
  const emitActive = (projectId) => { try { onActiveChanged?.(projectId || null); } catch (_) {} };
  const persistLastProject = (projectId) => {
    try {
      const config = configStore.load();
      configStore.save({ ...config, last_project_id: projectId || null });
    } catch (error) {
      console.warn('[projects] 记住上次项目失败', error?.message || String(error));
    }
  };
  const removeProjectDir = (projectId) => {
    fs.rmSync(path.join(getProjectsRootDir(app), projectId), { recursive: true, force: true, maxRetries: 5 });
  };
  const disposeProjectSlots = (projectId) => { try { agentService?.disposeProject?.(projectId); } catch (_) {} };

  ipcMain.handle('projects:list', () => ({
    projects: registry.list().map((p) => ({ ...p, openError: storeRegistry.getOpenErrors()[p.id] || null })),
    activeProjectId: storeRegistry.getCurrentProjectId(),
  }));

  ipcMain.handle('projects:set-active', (_e, projectId) => {
    if (projectId) {
      const project = registry.get(projectId);
      if (!project) throw new Error(`项目不存在: ${projectId}`);
    }
    storeRegistry.setCurrent(projectId || null);
    // 显式打开一次上下文：触发主会话恢复 + 中断任务恢复（onProjectOpened）；打开失败会标错并向上抛出。
    if (projectId) storeRegistry.resolveStores(projectId);
    persistLastProject(projectId || null);
    emitActive(projectId);
    return { ok: true };
  });

  ipcMain.handle('projects:rename', (_e, { projectId, name }) => {
    registry.rename(projectId, name);
    return { ok: true };
  });

  ipcMain.handle('projects:remove', async (_e, { projectId }) => {
    // 先取消该项目后台任务并等待退出，再关项目连接（Windows 句柄占用会导致删除失败），最后落盘清理。
    await taskService.cancelTechnicalPlanTasks('项目已删除，后台任务已取消', { projectId });
    await taskService.cancelDuplicateCheckTasks('项目已删除，后台任务已取消', { projectId });
    await taskService.cancelRejectionCheckTasks('项目已删除，后台任务已取消', { projectId });
    storeRegistry.closeProject(projectId);
    disposeProjectSlots(projectId);
    registry.remove(projectId);
    removeProjectDir(projectId);
    if (storeRegistry.getCurrentProjectId() === projectId) {
      storeRegistry.setCurrent(null);
      persistLastProject(null);
      emitActive(null);
    }
    return { ok: true };
  });

  ipcMain.handle('projects:create-from-tender-file', async (_e, { filePaths }) => {
    const first = String(filePaths?.[0] || '');
    const name = first ? path.basename(first).replace(/\.[^.]+$/, '') : '未命名项目';
    const projectId = generateProjectId();
    fs.mkdirSync(path.join(getProjectsRootDir(app), projectId, 'workspace'), { recursive: true });
    registry.create({ id: projectId, name });
    storeRegistry.setCurrent(projectId);
    try {
      emitActive(projectId);
      // setCurrent 已完成：importTenderDocument 内部按当前项目缺省路由（D5③）
      const importResult = await taskService.importTenderDocument(filePaths);
      if (importResult && importResult.success === false) {
        // 软失败（格式不支持/解析为空/缺 LibreOffice 等）不返回结果，转 throw 走下方统一回滚。
        const error = new Error(importResult.message || '招标文件导入失败');
        error.importResult = importResult; // 挂原始结果，供渲染层展示解析提示
        throw error;
      }
      persistLastProject(projectId);
      return { projectId, name, importResult };
    } catch (error) {
      // 导入失败即回滚整个项目（新建项目尚无用户数据，安全）
      registry.remove(projectId);
      storeRegistry.closeProject(projectId);
      disposeProjectSlots(projectId);
      try { removeProjectDir(projectId); } catch (_) {}
      storeRegistry.setCurrent(null);
      emitActive(null);
      throw error;
    }
  });
}

module.exports = { registerProjectsIpc };
