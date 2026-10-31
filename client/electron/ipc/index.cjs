const { clipboard, dialog, ipcMain, powerMonitor, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { registerAgentIpc } = require('./agentIpc.cjs');
const { registerAiIpc } = require('./aiIpc.cjs');
const { registerAutoConfirmationIpc } = require('./autoConfirmationIpc.cjs');
const { registerConfigIpc } = require('./configIpc.cjs');
const { registerCredentialLibraryIpc } = require('./credentialLibraryIpc.cjs');
const { registerDeveloperIpc } = require('./developerIpc.cjs');
const { registerDonationIpc } = require('./donationIpc.cjs');
const { registerDuplicateCheckIpc } = require('./duplicateCheckIpc.cjs');
const { registerExportIpc } = require('./exportIpc.cjs');
const { registerFileIpc } = require('./fileIpc.cjs');
const { registerKnowledgeBaseIpc } = require('./knowledgeBaseIpc.cjs');
const { registerLicenseIpc } = require('./licenseIpc.cjs');
const { registerOfficialAccountIpc, registerOfficialInvoiceIpc } = require('./officialAccountIpc.cjs');
const { registerRejectionCheckIpc } = require('./rejectionCheckIpc.cjs');
const { registerTaskIpc } = require('./taskIpc.cjs');
const { registerTechnicalPlanIpc } = require('./technicalPlanIpc.cjs');
const { registerFeasibilityReportIpc } = require('./feasibilityReportIpc.cjs');
const { registerTemplateIpc } = require('./templateIpc.cjs');
const { registerSystemFontIpc } = require('./systemFontIpc.cjs');
const { registerPluginIpc } = require('./pluginIpc.cjs');
const { registerProjectsIpc } = require('./projectsIpc.cjs');
const { createProjectStoreRouting } = require('./projectStoreRouting.cjs');
const pluginService = require('../services/pluginService.cjs');
const { createAgentService } = require('../services/agentService.cjs');
const { createTechnicalPlanExport } = require('../services/technicalPlanExport.cjs');
const { createAiService } = require('../services/aiService.cjs');
const { createAutoConfirmationService } = require('../services/autoConfirmationService.cjs');
const { createConfigStore } = require('../services/configStore.cjs');
const { createCredentialLibraryService } = require('../services/credentialLibraryService.cjs');
const { createDeveloperExpansionReplaceTestService } = require('../services/developerExpansionReplaceTest.cjs');
const { createDeveloperLayoutFigureService } = require('../services/developerLayoutFigureService.cjs');
const { createDonationService } = require('../services/donationService.cjs');
const { createDuplicateCheckService } = require('../services/duplicateCheckService.cjs');
const { createCheckResultExportService } = require('../services/checkResultExportService.cjs');
const { createExportService } = require('../services/exportService.cjs');
const { createFileService } = require('../services/fileService.cjs');
const { createKnowledgeBaseService } = require('../services/knowledgeBaseService.cjs');
const { createKnowledgeBaseStore } = require('../services/knowledgeBaseStore.cjs');
const { createLicenseService } = require('../services/licenseService.cjs');
const { createOfficialAccountService } = require('../services/officialAccountService.cjs');
const { createProjectRegistry } = require('../services/projectRegistry.cjs');
const { createProjectStoreRegistry } = require('../services/projectStoreRegistry.cjs');
const { runLegacyMigration } = require('../services/projectMigration.cjs');
const { createSqliteDatabase } = require('../services/sqliteDatabase.cjs');
const { createSystemFontService } = require('../services/systemFontService.cjs');
const { clearOrphanedGeneratedImages, clearStalePiTaskArchives, runHistoricalStorageCleanup } = require('../services/storageCleanupService.cjs');
const { createTaskService } = require('../services/taskService.cjs');
const { createAgentWorkspaceService } = require('../services/agentWorkspaceService.cjs');
const { createTaskLogStore } = require('../services/taskLogStore.cjs');
const { createFeasibilityReportStore } = require('../services/feasibilityReportStore.cjs');
const { createOfficialInvoiceStore } = require('../services/officialInvoiceStore.cjs');
const { createTemplateStore } = require('../services/templateStore.cjs');
const { checkRequiredOnlineServices, getRequiredOnlineServiceStatus } = require('../services/requiredOnlineServices.cjs');
const { initLocalImageRenderService } = require('../services/localImageRenderService.cjs');
const { createOpenXmlHelperService } = require('../services/openXmlHelperService.cjs');
const { cleanupTrashDirSync } = require('../utils/forceRemove.cjs');
const { getGeneratedImagesDir, getImportedImagesDir, getProjectsRootDir, getWorkspaceDatabasePath, getWorkspaceTrashDir } = require('../utils/paths.cjs');

let pendingUiCurrentView = null;
let agentWorkspaceServiceRef = null;
let currentViewWebContentsId = null;
const currentViewLifetimeBound = new WeakSet();

function clearUiCurrentView() {
  pendingUiCurrentView = null;
  currentViewWebContentsId = null;
  if (agentWorkspaceServiceRef?.setCurrentView) {
    agentWorkspaceServiceRef.setCurrentView({});
  }
}

function bindCurrentViewLifetime(webContents) {
  if (!webContents || currentViewLifetimeBound.has(webContents)) return;
  currentViewLifetimeBound.add(webContents);
  const webContentsId = webContents.id;
  const clearIfCurrent = () => {
    if (currentViewWebContentsId === webContentsId) {
      clearUiCurrentView();
    }
  };
  webContents.once('destroyed', clearIfCurrent);
  webContents.on('render-process-gone', clearIfCurrent);
}

function applyUiCurrentView(view, senderWebContents) {
  if (senderWebContents?.isDestroyed?.()) {
    clearUiCurrentView();
    return;
  }
  pendingUiCurrentView = view && typeof view === 'object' ? view : {};
  currentViewWebContentsId = senderWebContents?.id ?? null;
  bindCurrentViewLifetime(senderWebContents);
  if (agentWorkspaceServiceRef?.setCurrentView) {
    agentWorkspaceServiceRef.setCurrentView(pendingUiCurrentView);
  }
}

function normalizeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;

  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function sendToWebContents(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed?.()) {
    return false;
  }

  try {
    webContents.send(channel, payload);
    return true;
  } catch (error) {
    console.warn('[ipc] 发送渲染进程事件失败', { channel, message: error?.message || String(error) });
    return false;
  }
}

const workspaceDatabaseChannels = [
  'credential-library:load',
  'credential-library:import-test-data',
  'credential-library:save-profile',
  'credential-library:add-profile-images',
  'credential-library:delete-image',
  'credential-library:save-certificate',
  'credential-library:delete-certificate',
  'credential-library:save-employee',
  'credential-library:delete-employee',
  'credential-library:save-project',
  'credential-library:delete-project',
  'credential-library:save-other-material',
  'credential-library:delete-other-material',
  'official-account:get-invoice-info',
  'official-account:save-invoice-info',
  'technical-plan:load-state',
  'technical-plan:load-generation-config',
  'technical-plan:save-generation-config',
  'technical-plan:import-tender-document',
  'technical-plan:remove-tender-document',
  'technical-plan:import-original-plan-document',
  'technical-plan:remove-original-plan-document',
  'technical-plan:check-bid-sections',
  'technical-plan:select-bid-section',
  'technical-plan:read-tender-markdown',
  'technical-plan:read-content-word',
  'technical-plan:preview-content-word',
  'technical-plan:read-tender-source-markdown',
  'technical-plan:update-step',
  'technical-plan:save-bid-analysis-config',
  'technical-plan:save-outline-selection',
  'technical-plan:save-outline',
  'technical-plan:save-global-facts',
  'technical-plan:save-content-generation-options',
  'technical-plan:save-chapter-content',
  'technical-plan:reset-content-generation',
  'technical-plan:clear',
  'technical-plan:open-bid-template',
  'feasibility-report:load-state',
  'feasibility-report:import-source-documents',
  'feasibility-report:remove-source-document',
  'feasibility-report:read-source-markdown',
  'feasibility-report:read-combined-source-markdown',
  'feasibility-report:update-step',
  'feasibility-report:save-project-info',
  'feasibility-report:save-analysis',
  'feasibility-report:save-outline-config',
  'feasibility-report:save-outline',
  'feasibility-report:save-key-parameters',
  'feasibility-report:save-chapter-content',
  'feasibility-report:clear',
  'duplicate-check:load-state',
  'duplicate-check:save-files',
  'duplicate-check:save-ui-state',
  'duplicate-check:export-excel',
  'duplicate-check:update-state',
  'duplicate-check:clear',
  'rejection-check:load-state',
  'rejection-check:import-document',
  'rejection-check:import-tender-from-technical-plan',
  'rejection-check:remove-document',
  'rejection-check:save-ui-state',
  'rejection-check:update-state',
  'rejection-check:export-excel',
  'rejection-check:clear',
  'knowledge-base:list',
  'knowledge-base:search',
  'knowledge-base:create-folder',
  'knowledge-base:rename-folder',
  'knowledge-base:delete-folder',
  'knowledge-base:delete-document',
  'knowledge-base:upload-documents',
  'knowledge-base:start-matching',
  'knowledge-base:read-markdown',
  'knowledge-base:read-items',
  'knowledge-base:read-analysis',
  'tasks:start-bid-section-extraction',
  'tasks:start-bid-analysis',
  'tasks:start-outline-generation',
  'tasks:confirm-outline-selection',
  'tasks:suppress-outline-selection-auto-confirmation',
  'tasks:start-global-facts-generation',
  'tasks:start-content-generation',
  'tasks:pause-content-generation',
  'tasks:start-rejection-items-extraction',
  'tasks:start-rejection-check',
  'tasks:start-duplicate-analysis',
  'tasks:start-feasibility-analysis',
  'tasks:start-feasibility-outline',
  'tasks:start-feasibility-parameters',
  'tasks:start-feasibility-content',
  'tasks:pause-feasibility-content',
  'tasks:start-feasibility-human-writing',
  'tasks:get-active',
  'templates:list',
  'templates:get',
  'templates:create',
  'templates:update',
  'templates:delete',
  'templates:duplicate',
  'templates:render-preview',
  'projects:list',
  'projects:set-active',
  'projects:rename',
  'projects:remove',
  'projects:create-from-tender-file',
];

function clearWorkspaceDatabaseIpc() {
  workspaceDatabaseChannels.forEach((channel) => ipcMain.removeHandler(channel));
  ipcMain.removeAllListeners('tasks:subscribe');
}

function registerPendingWorkspaceDatabaseIpc(getStatus) {
  clearWorkspaceDatabaseIpc();
  const throwPending = () => {
    const status = getStatus();
    const message = status?.message || '本地数据库正在检查或升级，请稍候';
    throw new Error(message);
  };
  workspaceDatabaseChannels.forEach((channel) => ipcMain.handle(channel, throwPending));
  ipcMain.on('tasks:subscribe', () => {});
}

function registerUnavailableWorkspaceDatabaseIpc(error) {
  const message = `工作区数据库初始化失败：${error?.message || String(error)}`;
  const throwUnavailable = () => {
    throw new Error(message);
  };

  console.error('[ipc] 工作区数据库初始化失败', error);
  clearWorkspaceDatabaseIpc();
  workspaceDatabaseChannels.forEach((channel) => ipcMain.handle(channel, throwUnavailable));
  ipcMain.on('tasks:subscribe', () => {});
}

function registerWorkspaceDatabaseStatusIpc({ mainWindow }) {
  let status = {
    phase: 'checking',
    ready: false,
    message: '正在准备本地数据库',
    updatedAt: new Date().toISOString(),
  };

  const updateStatus = (nextStatus) => {
    status = {
      ...status,
      ...nextStatus,
      ready: nextStatus?.phase === 'ready' ? true : Boolean(nextStatus?.ready),
      updatedAt: new Date().toISOString(),
    };
    if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('workspace-database:status', status);
    }
  };

  ipcMain.handle('workspace-database:get-status', () => status);

  return {
    getStatus: () => status,
    updateStatus,
  };
}

function registerWorkspaceDatabaseServices({ app, mainWindow, configStore, aiService, agentService, autoConfirmationService, fileService, openXmlHelperService, updateStatus, assetRootsBinding, assetRootsRef }) {
  const sqliteDatabase = createSqliteDatabase(app, { onStatus: updateStatus });
  runHistoricalStorageCleanup({ app, db: sqliteDatabase.db, configStore, onStatus: updateStatus });
  // 清理上次强制删除时因占用未能物理删除、被移入回收目录的残留
  cleanupTrashDirSync(getWorkspaceTrashDir(app));

  // 项目注册表（T2）+ 存量迁移（T8）：三域数据搬进项目目录后才进入项目化世界。
  const projectRegistry = createProjectRegistry({ db: sqliteDatabase.db });
  const migrationResult = runLegacyMigration({ app, globalDb: sqliteDatabase.db, registry: projectRegistry, onStatus: (message) => updateStatus({ message }) });
  if (migrationResult?.fatal) {
    // 审计B/T8：迁移判死 → 先关全局库连接（Windows 句柄占用），再从备份还原全局库，阻断启动。
    sqliteDatabase.close();
    const backupFile = path.join(getProjectsRootDir(app), '.legacy-backup', 'yibiao.sqlite');
    if (fs.existsSync(backupFile)) {
      fs.copyFileSync(backupFile, getWorkspaceDatabasePath(app));
    } else {
      console.error('[ipc] 存量迁移备份文件不存在，跳过还原', backupFile);
    }
    updateStatus({ phase: 'error', ready: false, message: `存量迁移失败，已从备份还原：${migrationResult.error}` });
    throw new Error(`存量迁移失败: ${migrationResult.error}`);
  }
  // 必须在 runLegacyMigration 之后：迁移先把三域会话目录搬进项目目录，再清全局 tasksRoot 的
  // 陈旧归档（顺序颠倒会把尚未搬走的老会话目录当垃圾清掉）。
  clearStalePiTaskArchives(app);

  // 生图孤儿清理（T10 逐项目化）：逐项目只读打开项目库收集引用 + 全局根兜底清理。
  // 必须在 runLegacyMigration 之后：引用已随三域数据迁入各项目库，全局库三域表已 DROP
  // （旧的全局库引用查询路径不复存在）；引用查询失败的项目跳过，绝不清图。
  clearOrphanedGeneratedImages({ app, projects: projectRegistry.list() });

  const taskLogStore = createTaskLogStore({ db: sqliteDatabase.db });
  const credentialLibraryService = createCredentialLibraryService({ app, db: sqliteDatabase.db });
  const knowledgeBaseStore = createKnowledgeBaseStore({ app, db: sqliteDatabase.db });
  const knowledgeBaseService = createKnowledgeBaseService({ app, aiService, configStore, knowledgeBaseStore });
  // feasibility 仍为全局域：store 留在全局库；三域 store 全部改由 projectStoreRegistry 按项目构造（T4）。
  const feasibilityReportStore = createFeasibilityReportStore({ app, db: sqliteDatabase.db, fileService, taskLogStore, agentService });
  const templateStore = createTemplateStore({ db: sqliteDatabase.db });
  // 系统预设模板的真源在代码里，每次启动对齐一次，保证首启和版本升级都能拿到最新预设。
  templateStore.syncSystemTemplates();

  // taskService 可能早于首个项目上下文打开：onProjectOpened 先经 ref 持有，创建后立刻补跑当前项目恢复。
  const taskServiceRef = { current: null };

  const projectStoreRegistry = createProjectStoreRegistry({
    app,
    registry: projectRegistry,
    deps: {
      fileService,
      agentService,
      taskLogStore,
      configStore,
      // 原 technicalPlanStore.setAgentWorkspaceChangeListener(...) 的单例接线移到 store 构造点（T4 buildContext）。
      onTechnicalPlanStoreCreated: (technicalPlanStore) => {
        technicalPlanStore.setAgentWorkspaceChangeListener(() => agentWorkspaceServiceRef?.emitWorkspacesChanged?.());
      },
    },
    onProjectOpened: (projectId) => {
      try { agentService.restorePrimarySessionForProject?.(projectId); } catch (error) { console.warn('[ipc] 恢复项目主会话失败', error?.message || String(error)); }
      try { taskServiceRef.current?.recoverInterruptedTasksForProject(projectId); } catch (error) { console.warn('[ipc] 恢复项目中断任务失败', error?.message || String(error)); }
    },
  });
  app.once('will-quit', () => projectStoreRegistry.closeAll());

  // T10：图片资产根项目化——有当前项目时资产根在 <projectDir>/workspace 下，
  // 无项目回退全局 workspace 根（credential-library 恒全局，不经此路由）。
  // getter 请求时读 getCurrentProjectId，跟随项目切换。
  const getProjectGeneratedImagesRoot = () => {
    const projectId = projectStoreRegistry.getCurrentProjectId();
    return projectId
      ? path.join(getProjectsRootDir(app), projectId, 'workspace', 'generated-images')
      : getGeneratedImagesDir(app);
  };
  const getProjectImportedImagesRoot = () => {
    const projectId = projectStoreRegistry.getCurrentProjectId();
    return projectId
      ? path.join(getProjectsRootDir(app), projectId, 'workspace', 'imported-images')
      : getImportedImagesDir(app);
  };
  // 回填晚绑定容器（aiService/exportService 先于 registry 构造，经 wrapper 持有）；
  // main.cjs 的 yibiao-asset:// 协议处理器跨模块注入：赋函数引用，请求时求值（未注入前回退全局根）。
  assetRootsBinding.getGeneratedImagesRoot = getProjectGeneratedImagesRoot;
  assetRootsBinding.getImportedImagesRoot = getProjectImportedImagesRoot;
  if (assetRootsRef) {
    assetRootsRef.generatedImages = getProjectGeneratedImagesRoot;
    assetRootsRef.importedImages = getProjectImportedImagesRoot;
  }

  // 初始化当前项目：上次使用的项目 > 最近活跃项目 > 无（空态）。只 setCurrent + 显式打开一次上下文，
  // 此时 taskService 尚未创建（onProjectOpened 只做主会话恢复），中断任务恢复由创建后的补跑完成，
  // 与 onProjectOpened 的恢复互斥不重入。
  try {
    const lastProjectId = configStore.load().last_project_id || null;
    const activeProjects = projectRegistry.list();
    const initialProjectId = activeProjects.some((p) => p.id === lastProjectId)
      ? lastProjectId
      : (activeProjects[0]?.id || null);
    if (initialProjectId) {
      projectStoreRegistry.setCurrent(initialProjectId);
      projectStoreRegistry.resolveStores(initialProjectId);
    }
  } catch (error) {
    console.warn('[ipc] 初始化当前项目失败', error?.message || String(error));
  }

  // 隐藏调用面（T9）：以下服务仍按“store 单例”签名构造，改为惰性代理按当前项目解析。
  // 空态（未选项目）返回空操作 store（方法返回 undefined），与原全局空 store 行为对齐（loadX() || {} 模式）。
  const VOID_STORE = new Proxy({}, { get: () => () => undefined });
  const lazyCurrentStore = (pickStore) => new Proxy({}, {
    get(_target, prop) {
      let store = null;
      if (projectStoreRegistry.getCurrentProjectId()) {
        try { store = pickStore(projectStoreRegistry.resolveStores()); } catch (error) { console.warn('[ipc] 解析当前项目 store 失败', error?.message || String(error)); }
      }
      const target = store || VOID_STORE;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const duplicateCheckService = createDuplicateCheckService({
    app,
    configStore,
    workspaceStore: lazyCurrentStore((stores) => stores.duplicateCheckStore),
    getGeneratedImagesRoot: getProjectGeneratedImagesRoot,
    getImportedImagesRoot: getProjectImportedImagesRoot,
  });
  const checkResultExportService = createCheckResultExportService({
    app,
    dialog,
    rejectionCheckStore: lazyCurrentStore((stores) => stores.rejectionCheckStore),
    duplicateCheckStore: lazyCurrentStore((stores) => stores.duplicateCheckStore),
  });
  // 三域 store 闭包参数传 null：storeRegistry 存在时 taskService 的兜底分支不再走到（T6）。
  const taskService = createTaskService({
    templateStore,
    aiService,
    agentService,
    autoConfirmationService,
    technicalPlanStore: null,
    rejectionCheckStore: null,
    duplicateCheckStore: null,
    feasibilityReportStore,
    storeRegistry: projectStoreRegistry,
    knowledgeBaseService,
    duplicateCheckService,
    openXmlHelperService,
  });
  taskServiceRef.current = taskService;
  // 补跑当前项目的中断任务恢复：上下文已在前面临时打开（缓存命中），不会再次触发 onProjectOpened。
  if (projectStoreRegistry.getCurrentProjectId()) {
    try { taskService.recoverInterruptedTasksForProject(projectStoreRegistry.getCurrentProjectId()); } catch (error) { console.warn('[ipc] 补跑项目任务恢复失败', error?.message || String(error)); }
  }
  const agentWorkspaceService = createAgentWorkspaceService({ agentService, taskService, technicalPlanStore: lazyCurrentStore((stores) => stores.technicalPlanStore), feasibilityReportStore });
  agentWorkspaceServiceRef = agentWorkspaceService;
  feasibilityReportStore.setAgentWorkspaceChangeListener(() => agentWorkspaceService.emitWorkspacesChanged());
  if (pendingUiCurrentView) {
    agentWorkspaceService.setCurrentView(pendingUiCurrentView);
  }

  // 三域 IPC 的当前项目路由（resolve + 引用计数包裹）
  const { resolveCurrentStores, withProjectStores } = createProjectStoreRouting(projectStoreRegistry);

  // 更新 pluginService 的服务引用：三域 store 传“当前项目”解出的实例，切换项目时刷新。
  const refreshPluginServices = () => {
    try {
      const projectId = projectStoreRegistry.getCurrentProjectId();
      const stores = projectId
        ? projectStoreRegistry.resolveStores(projectId)
        : { technicalPlanStore: null, duplicateCheckStore: null, rejectionCheckStore: null };
      pluginService.updateServices({
        agentService,
        taskService,
        agentWorkspaceService,
        technicalPlanStore: stores.technicalPlanStore || null,
        duplicateCheckStore: stores.duplicateCheckStore || null,
        rejectionCheckStore: stores.rejectionCheckStore || null,
      });
    } catch (error) {
      console.warn('[ipc] 刷新插件服务引用失败', error?.message || String(error));
    }
  };
  // 项目切换：广播给渲染进程（mainWindow 经 registerWorkspaceDatabaseServices 参数传入）+ 刷新插件 store 实例。
  const onActiveChanged = (projectId) => {
    sendToWebContents(mainWindow?.webContents, 'projects:active-changed', { projectId: projectId || null });
    refreshPluginServices();
  };

  clearWorkspaceDatabaseIpc();
  // registerProjectsIpc 必须在 clearWorkspaceDatabaseIpc() 之后（覆盖 pending 占位 handler）
  registerProjectsIpc({ app, registry: projectRegistry, storeRegistry: projectStoreRegistry, taskService, configStore, agentService, onActiveChanged });
  registerCredentialLibraryIpc({ credentialLibraryService, configStore });
  registerKnowledgeBaseIpc({ knowledgeBaseService });
  registerTechnicalPlanIpc({ resolveCurrentStores, withProjectStores, taskService, agentService, openXmlHelperService });
  registerFeasibilityReportIpc({ feasibilityReportStore, taskService });
  registerDuplicateCheckIpc({ resolveCurrentStores, withProjectStores, checkResultExportService });
  registerRejectionCheckIpc({ resolveCurrentStores, withProjectStores, taskService, checkResultExportService });
  registerTemplateIpc({ templateStore, openXmlHelperService });
  registerOfficialInvoiceIpc({ officialInvoiceStore: createOfficialInvoiceStore({ db: sqliteDatabase.db }) });
  registerTaskIpc({ taskService });
  updateStatus({ phase: 'ready', ready: true, message: '本地数据库已就绪' });

  refreshPluginServices();

  // 在服务就绪后启用已启用的插件
  pluginService.activateEnabledPlugins().catch((error) => {
    console.error('[plugin-service] 启用插件失败:', error);
  });

  // 整本导出按“导出时刻的当前项目”解 store 与 projectId（T9；exportService 经 getter 每次导出重新取）。
  const getTechnicalPlanExport = () => {
    const projectId = projectStoreRegistry.getCurrentProjectId();
    const { technicalPlanStore } = projectStoreRegistry.resolveStores(projectId);
    return createTechnicalPlanExport({ technicalPlanStore, templateStore, agentService, openXmlHelperService, projectId });
  };

  return { sqliteDatabase, projectStoreRegistry, getTechnicalPlanExport };
}

function registerIpcHandlers({ app, mainWindow, assetRootsRef, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall, getLatestVersion, getUpdateDownloadUrl, gpuStartupState = {}, gpuTrialArg = '--yibiao-trial-hardware-acceleration', forceDisableGpuArgs = [], openDeveloperTokenStatsWindow, closeDeveloperTokenStatsWindow, openDeveloperAgentMonitorWindow, closeDeveloperAgentMonitorWindow }) {
  void checkRequiredOnlineServices();
  const configStore = createConfigStore(app);
  // T10：图片资产根项目化。projectStoreRegistry 在 registerWorkspaceDatabaseServices 内部才创建，
  // 而 aiService/exportService 先于此构造——经此稳定容器晚绑定（registry 就绪后回填项目化实现），
  // 回填前（或实现抛错/无项目）回退全局 workspace 根。
  const assetRootsBinding = { getGeneratedImagesRoot: null, getImportedImagesRoot: null };
  const getGeneratedImagesRoot = () => {
    try {
      return assetRootsBinding.getGeneratedImagesRoot?.() || getGeneratedImagesDir(app);
    } catch {
      return getGeneratedImagesDir(app);
    }
  };
  const getImportedImagesRoot = () => {
    try {
      return assetRootsBinding.getImportedImagesRoot?.() || getImportedImagesDir(app);
    } catch {
      return getImportedImagesDir(app);
    }
  };
  initLocalImageRenderService({ configStore });
  const licenseService = createLicenseService({ app, configStore });
  const officialAccountService = createOfficialAccountService({ app, configStore, powerMonitor });
  const aiService = createAiService({ app, configStore, getGeneratedImagesRoot });
  const developerExpansionReplaceTestService = createDeveloperExpansionReplaceTestService({ aiService });
  const developerLayoutFigureService = createDeveloperLayoutFigureService({ app, aiService });
  const donationService = createDonationService({
    app,
    onPrompt: (payload) => sendToWebContents(mainWindow.webContents, 'donation:prompt', payload),
    onPaid: () => sendToWebContents(mainWindow.webContents, 'donation:paid'),
  });
  const autoConfirmationService = createAutoConfirmationService({ configStore });
  const agentService = createAgentService({ app, configStore, aiService, licenseService, autoConfirmationService });
  const fileService = createFileService({ app, configStore });
  const openXmlHelperService = createOpenXmlHelperService({ app, configStore });
  let getTechnicalPlanExport = null;
  const exportService = createExportService({
    configStore,
    openXmlHelperService,
    getTechnicalPlanExport: () => getTechnicalPlanExport?.() || null,
    getGeneratedImagesRoot,
    getImportedImagesRoot,
  });
  const systemFontService = createSystemFontService();
  const databaseStatus = registerWorkspaceDatabaseStatusIpc({ mainWindow });
  let workspaceDatabaseStarted = false;
  let gpuTrialRelaunchStarted = false;

  const closeServices = async () => {
    await officialAccountService.close();
    donationService.close?.();
    await agentService.close?.();
    autoConfirmationService.close?.();
    await openXmlHelperService.close?.();
  };

  const closeServicesBeforeExit = async () => {
    try {
      await closeServices();
    } catch (error) {
      console.warn('[ipc] 关闭后台服务失败', error?.message || String(error));
    }
  };

  const saveGpuHardwareAccelerationPreference = (enabled) => {
    const nextEnabled = Boolean(enabled);
    const currentConfig = configStore.load();
    const result = configStore.save({
      ...currentConfig,
      gpu_hardware_acceleration_enabled: nextEnabled,
      gpu_hardware_acceleration_configured: true,
    });
    return {
      ...result,
      enabled: nextEnabled,
      configured: true,
      restartRequired: nextEnabled !== Boolean(gpuStartupState.hardwareAccelerationEnabled),
    };
  };

  const buildGpuTrialRelaunchArgs = () => {
    const excludedArgs = new Set([gpuTrialArg, ...forceDisableGpuArgs]);
    return process.argv
      .slice(1)
      .filter((arg) => !excludedArgs.has(String(arg).split('=')[0]))
      .concat(gpuTrialArg);
  };

  const buildGpuDisabledRelaunchArgs = () => {
    const excludedArgs = new Set([gpuTrialArg, ...forceDisableGpuArgs]);
    return process.argv
      .slice(1)
      .filter((arg) => !excludedArgs.has(String(arg).split('=')[0]))
      .concat('--disable-gpu');
  };

  // 按开发者配置打开启动辅助窗口。
  const openDeveloperWindowsOnStartup = () => {
    try {
      const config = configStore.load();
      if (config.developer_mode && config.developer_token_stats_auto_open) {
        openDeveloperTokenStatsWindow?.();
      }
      if (config.developer_mode && config.developer_agent_monitor_auto_open) {
        openDeveloperAgentMonitorWindow?.();
      }
    } catch (error) {
      console.warn('[developer] 自动打开开发者辅助窗口失败', error?.message || String(error));
    }
  };

  registerConfigIpc({
    configStore,
    aiService,
    onConfigChanged(nextConfig, previousConfig) {
      agentService.handleConfigChanged?.(nextConfig, previousConfig);
      autoConfirmationService.handleConfigChanged?.(nextConfig, previousConfig);
    },
    onDeveloperModeChange(developerMode) {
      if (!developerMode) {
        closeDeveloperTokenStatsWindow?.();
        closeDeveloperAgentMonitorWindow?.();
      }
    },
  });
  registerDeveloperIpc({
    configStore,
    aiService,
    agentService,
    openDeveloperTokenStatsWindow,
    openDeveloperAgentMonitorWindow,
    developerExpansionReplaceTestService,
    developerLayoutFigureService,
    openXmlHelperService,
  });
  registerDonationIpc({ donationService });
  registerLicenseIpc({ licenseService });
  registerOfficialAccountIpc({ officialAccountService });
  void officialAccountService.start().catch(() => undefined);
  registerAiIpc({ aiService });
  registerAgentIpc({ agentService });
  registerAutoConfirmationIpc({ autoConfirmationService });
  registerFileIpc({ fileService });
  registerExportIpc({ exportService, donationService });
  registerSystemFontIpc({ systemFontService });
  registerPluginIpc(ipcMain, app, {
    agentService,
    taskService: null,
    technicalPlanStore: null,
    duplicateCheckStore: null,
    rejectionCheckStore: null,
  });
  ipcMain.handle('ui:set-current-view', (event, view) => {
    applyUiCurrentView(view, event.sender);
    return { success: true };
  });
  registerPendingWorkspaceDatabaseIpc(databaseStatus.getStatus);

  setTimeout(() => {
    void licenseService.refreshOnStartup?.().catch((error) => {
      console.warn('[license] startup refresh failed', error?.message || String(error));
    });
  }, 800);

  const startWorkspaceDatabase = () => {
    if (workspaceDatabaseStarted) return;
    workspaceDatabaseStarted = true;
    databaseStatus.updateStatus({ phase: 'checking', ready: false, message: '正在检查本地数据库' });
    setTimeout(() => {
      try {
        ({ getTechnicalPlanExport } = registerWorkspaceDatabaseServices({ app, mainWindow, configStore, aiService, agentService, autoConfirmationService, fileService, openXmlHelperService, updateStatus: databaseStatus.updateStatus, assetRootsBinding, assetRootsRef }));
        setTimeout(() => {
          void agentService.warmup?.().catch((error) => {
            console.warn('[agent] warmup failed', error?.message || String(error));
          });
        }, 500);
      } catch (error) {
        databaseStatus.updateStatus({
          phase: 'error',
          ready: false,
          message: `本地数据库初始化失败：${error?.message || String(error)}`,
        });
        registerUnavailableWorkspaceDatabaseIpc(error);
      }
    }, 120);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', () => {
      startWorkspaceDatabase();
      openDeveloperWindowsOnStartup();
    });
  } else {
    startWorkspaceDatabase();
    openDeveloperWindowsOnStartup();
  }

  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('required-online-services:get-status', () => getRequiredOnlineServiceStatus());

  ipcMain.handle('app:get-gpu-hardware-acceleration-status', () => {
    const config = configStore.load();
    return {
      configured: Boolean(config.gpu_hardware_acceleration_configured),
      enabled: Boolean(config.gpu_hardware_acceleration_enabled),
      currentEnabled: Boolean(gpuStartupState.hardwareAccelerationEnabled),
      trial: Boolean(gpuStartupState.trial),
      forcedDisabled: Boolean(gpuStartupState.forcedDisabled),
    };
  });

  ipcMain.handle('app:save-gpu-hardware-acceleration-preference', (_event, enabled) => saveGpuHardwareAccelerationPreference(enabled));

  ipcMain.handle('app:start-gpu-hardware-acceleration-trial', async () => {
    if (gpuTrialRelaunchStarted) {
      return { success: true };
    }

    gpuTrialRelaunchStarted = true;
    const args = buildGpuTrialRelaunchArgs();
    await closeServicesBeforeExit();
    app.relaunch({ args });
    app.exit(0);
    return { success: true };
  });

  ipcMain.handle('app:relaunch-with-gpu-hardware-acceleration-disabled', async () => {
    saveGpuHardwareAccelerationPreference(false);
    if (gpuTrialRelaunchStarted) {
      return { success: true };
    }

    gpuTrialRelaunchStarted = true;
    const args = buildGpuDisabledRelaunchArgs();
    await closeServicesBeforeExit();
    app.relaunch({ args });
    app.exit(0);
    return { success: true };
  });

  ipcMain.handle('app:open-external', async (_event, url) => {
    const externalUrl = normalizeExternalUrl(url);
    if (!externalUrl) {
      return { success: false, message: '不支持的外部链接' };
    }
    try {
      await shell.openExternal(externalUrl);
      return { success: true };
    } catch (error) {
      const preview = externalUrl.length > 300 ? `${externalUrl.slice(0, 300)}...` : externalUrl;
      console.warn('[app] 打开外部链接失败', { url: preview, message: error.message || String(error) });
      clipboard.writeText(externalUrl);
      return { success: false, message: '系统无法启动默认浏览器，链接已复制，请手动粘贴到浏览器访问' };
    }
  });

  ipcMain.handle('app:get-latest-version', () => getLatestVersion({ configStore }));
  ipcMain.handle('app:get-update-download-url', () => getUpdateDownloadUrl({ configStore }));
  ipcMain.handle('app:quit-and-install', async () => {
    await closeServicesBeforeExit();
    return quitAndInstall({ app });
  });

  /** 与主程序更新检查并行检查插件，并使用独立事件通知 Renderer。 */
  const checkPluginUpdates = (webContents) => {
    void pluginService.checkAvailableUpdates()
      .then((updates) => {
        if (updates.length > 0) {
          sendToWebContents(webContents, 'plugins:updates-available', updates);
        }
      })
      .catch((error) => {
        console.warn('[plugin-service] 自动检查插件更新失败:', error?.message || String(error));
      });
  };

  ipcMain.handle('app:check-update', (event) => {
    const webContents = event.sender;
    checkPluginUpdates(webContents);
    return checkAndDownloadUpdate({
      app,
      mainWindow,
      configStore,
      onProgress: (percent) => {
        sendToWebContents(webContents, 'app:update-progress', { percent });
      },
      onDownloaded: (version) => {
        sendToWebContents(webContents, 'app:update-downloaded', { version });
      },
      onError: (message) => {
        sendToWebContents(webContents, 'app:update-error', { message });
      },
    });
  });

  ipcMain.handle('app:start-update', (event) => {
    const webContents = event.sender;
    checkPluginUpdates(webContents);
    return triggerUpdateDownload({
      app,
      mainWindow,
      configStore,
      onProgress: (percent) => {
        sendToWebContents(webContents, 'app:update-progress', { percent });
      },
      onDownloaded: (version) => {
        sendToWebContents(webContents, 'app:update-downloaded', { version });
      },
      onError: (message) => {
        sendToWebContents(webContents, 'app:update-error', { message });
      },
    });
  });

  return {
    closeServices,
  };
}

module.exports = {
  registerIpcHandlers,
};
