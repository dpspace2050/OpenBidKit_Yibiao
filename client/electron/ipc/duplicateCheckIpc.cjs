const { ipcMain } = require('electron');

// 查重域 IPC（T9）：store 经 resolveCurrentStores 解析当前项目实例，withProjectStores 持引用计数。
// export-excel 走 checkResultExportService，其内部的 store 引用已在 index.cjs getter 化为当前项目路由。
function registerDuplicateCheckIpc({ resolveCurrentStores, withProjectStores, checkResultExportService }) {
  ipcMain.handle('duplicate-check:load-state', withProjectStores(() => resolveCurrentStores().duplicateCheckStore.loadDuplicateCheck(), 'duplicate-check:load-state'));
  ipcMain.handle('duplicate-check:save-files', withProjectStores((_event, payload) => resolveCurrentStores().duplicateCheckStore.saveFiles(payload), 'duplicate-check:save-files'));
  ipcMain.handle('duplicate-check:save-ui-state', withProjectStores((_event, payload) => resolveCurrentStores().duplicateCheckStore.saveUiState(payload), 'duplicate-check:save-ui-state'));
  ipcMain.handle('duplicate-check:update-state', withProjectStores((_event, partial) => resolveCurrentStores().duplicateCheckStore.updateDuplicateCheckWithoutReload(partial), 'duplicate-check:update-state'));
  ipcMain.handle('duplicate-check:export-excel', withProjectStores((_event, request) => checkResultExportService.exportDuplicateExcel(request), 'duplicate-check:export-excel'));
  ipcMain.handle('duplicate-check:clear', withProjectStores(() => resolveCurrentStores().duplicateCheckStore.clearDuplicateCheck(), 'duplicate-check:clear'));
}

module.exports = {
  registerDuplicateCheckIpc,
};
