const { ipcMain } = require('electron');

// 废标检查域 IPC（T9）：store 经 resolveCurrentStores 解析当前项目实例，withProjectStores 持引用计数。
// taskService.xxx 调用保持直通（taskService 内部已按当前项目/任务 project_id 路由）。
function registerRejectionCheckIpc({ resolveCurrentStores, withProjectStores, taskService, checkResultExportService }) {
  ipcMain.handle('rejection-check:load-state', withProjectStores(() => resolveCurrentStores().rejectionCheckStore.loadRejectionCheck(), 'rejection-check:load-state'));
  ipcMain.handle('rejection-check:import-document', withProjectStores((_event, role, filePaths) => taskService.importRejectionCheckDocument(role, filePaths), 'rejection-check:import-document'));
  ipcMain.handle('rejection-check:import-tender-from-technical-plan', withProjectStores(() => taskService.importRejectionCheckTenderFromTechnicalPlan(), 'rejection-check:import-tender-from-technical-plan'));
  ipcMain.handle('rejection-check:remove-document', withProjectStores((_event, role, documentId) => taskService.removeRejectionCheckDocument(role, documentId), 'rejection-check:remove-document'));
  ipcMain.handle('rejection-check:save-ui-state', withProjectStores((_event, payload) => resolveCurrentStores().rejectionCheckStore.saveUiState(payload), 'rejection-check:save-ui-state'));
  ipcMain.handle('rejection-check:update-state', withProjectStores((_event, partial) => resolveCurrentStores().rejectionCheckStore.updateRejectionCheckWithoutReload(partial), 'rejection-check:update-state'));
  ipcMain.handle('rejection-check:export-excel', withProjectStores((_event, request) => checkResultExportService.exportRejectionExcel(request), 'rejection-check:export-excel'));
  ipcMain.handle('rejection-check:clear', withProjectStores(() => taskService.resetRejectionCheck(), 'rejection-check:clear'));
}

module.exports = {
  registerRejectionCheckIpc,
};
