const { ipcMain, shell } = require('electron');
const { previewContentSection } = require('../services/contentGenerationOutput.cjs');

// 注册技术方案接口，正文预览转换交给输出服务处理。
// 三域 store 不再是单例（T9）：每个 handler 经 resolveCurrentStores 解析当前项目实例，
// withProjectStores 在执行期间持有项目引用计数，防止上下文被 LRU 淘汰。
function registerTechnicalPlanIpc({ resolveCurrentStores, withProjectStores, taskService, agentService, openXmlHelperService }) {
  ipcMain.handle('technical-plan:load-state', withProjectStores(() => resolveCurrentStores().technicalPlanStore.loadTechnicalPlan(), 'technical-plan:load-state'));
  ipcMain.handle('technical-plan:load-generation-config', withProjectStores(() => resolveCurrentStores().technicalPlanStore.loadGenerationConfig(), 'technical-plan:load-generation-config'));
  ipcMain.handle('technical-plan:save-generation-config', withProjectStores((_event, partial) => resolveCurrentStores().technicalPlanStore.saveGenerationConfig(partial), 'technical-plan:save-generation-config'));
  ipcMain.handle('technical-plan:import-tender-document', withProjectStores((_event, filePaths) => taskService.importTenderDocument(filePaths), 'technical-plan:import-tender-document'));
  ipcMain.handle('technical-plan:remove-tender-document', withProjectStores((_event, sourceId) => taskService.removeTenderDocument(sourceId), 'technical-plan:remove-tender-document'));
  ipcMain.handle('technical-plan:import-original-plan-document', withProjectStores((_event, filePaths) => taskService.importOriginalPlanDocument(filePaths), 'technical-plan:import-original-plan-document'));
  ipcMain.handle('technical-plan:remove-original-plan-document', withProjectStores(() => taskService.removeOriginalPlanDocument(), 'technical-plan:remove-original-plan-document'));
  ipcMain.handle('technical-plan:check-bid-sections', withProjectStores(() => resolveCurrentStores().technicalPlanStore.checkBidSections(), 'technical-plan:check-bid-sections'));
  ipcMain.handle('technical-plan:select-bid-section', withProjectStores((_event, selectedSection) => resolveCurrentStores().technicalPlanStore.selectBidSection(selectedSection), 'technical-plan:select-bid-section'));
  ipcMain.handle('technical-plan:read-tender-markdown', withProjectStores(() => resolveCurrentStores().technicalPlanStore.readTenderMarkdown(), 'technical-plan:read-tender-markdown'));
  ipcMain.handle('technical-plan:read-content-word', withProjectStores((_event, sectionId) => resolveCurrentStores().technicalPlanStore.readContentWord(sectionId), 'technical-plan:read-content-word'));
  ipcMain.handle('technical-plan:preview-content-word', withProjectStores((_event, sectionId) => previewContentSection({
    sectionId,
    agentService,
    openXmlHelperService,
    projectId: taskService.getCurrentProjectId?.() || null,
  }), 'technical-plan:preview-content-word'));
  ipcMain.handle('technical-plan:read-tender-source-markdown', withProjectStores((_event, sourceId) => resolveCurrentStores().technicalPlanStore.readTenderSourceMarkdown(sourceId), 'technical-plan:read-tender-source-markdown'));
  ipcMain.handle('technical-plan:update-step', withProjectStores((_event, step) => resolveCurrentStores().technicalPlanStore.updateStep(step), 'technical-plan:update-step'));
  ipcMain.handle('technical-plan:save-bid-analysis-config', withProjectStores((_event, payload) => resolveCurrentStores().technicalPlanStore.saveBidAnalysisConfig(payload), 'technical-plan:save-bid-analysis-config'));
  ipcMain.handle('technical-plan:save-outline-selection', withProjectStores((_event, payload) => resolveCurrentStores().technicalPlanStore.saveOutlineSelection(payload), 'technical-plan:save-outline-selection'));
  ipcMain.handle('technical-plan:save-outline', withProjectStores((_event, outlineData) => resolveCurrentStores().technicalPlanStore.saveOutline(outlineData), 'technical-plan:save-outline'));
  ipcMain.handle('technical-plan:save-global-facts', withProjectStores((_event, globalFacts) => resolveCurrentStores().technicalPlanStore.saveGlobalFacts(globalFacts), 'technical-plan:save-global-facts'));
  ipcMain.handle('technical-plan:save-content-generation-options', withProjectStores((_event, options) => resolveCurrentStores().technicalPlanStore.saveContentGenerationOptions(options), 'technical-plan:save-content-generation-options'));
  ipcMain.handle('technical-plan:save-chapter-content', withProjectStores((_event, payload) => resolveCurrentStores().technicalPlanStore.saveChapterContent(payload), 'technical-plan:save-chapter-content'));
  ipcMain.handle('technical-plan:reset-content-generation', withProjectStores(() => taskService.resetContentGeneration(), 'technical-plan:reset-content-generation'));
  ipcMain.handle('technical-plan:clear', withProjectStores(() => taskService.resetTechnicalPlan(), 'technical-plan:clear'));
  ipcMain.handle('technical-plan:open-bid-template', withProjectStores(async () => {
    const { technicalPlanStore } = resolveCurrentStores();
    const filePath = technicalPlanStore.getBidTemplatePath?.();
    if (!filePath || !technicalPlanStore.hasBidTemplate?.()) {
      return { success: false, message: '还没有投标模版，请先确认一级目录' };
    }
    const errorMessage = await shell.openPath(filePath);
    if (errorMessage) {
      return { success: false, message: errorMessage };
    }
    return { success: true };
  }, 'technical-plan:open-bid-template'));
}

module.exports = {
  registerTechnicalPlanIpc,
};
