const crypto = require('node:crypto');
const { runBidSectionExtractionTask } = require('./bidSectionExtractionTask.cjs');
const { runBidAnalysisTask } = require('./bidAnalysisTask.cjs');
const { runContentGenerationTask, prepareContentGenerationStart } = require('./contentGenerationTask.cjs');
const { runContentSectionRegenerationTask } = require('./contentSectionRegenerationTask.cjs');
const { runGlobalFactsTaskV2 } = require('./globalFactsTaskV2.cjs');
const { runOutlineGenerationTaskV2 } = require('./outlineGenerationTaskV2.cjs');
const { runOutlineAdjustmentTask } = require('./outlineAdjustmentTask.cjs');
const { runGlobalFactsAdjustmentTask } = require('./globalFactsAdjustmentTask.cjs');
const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { ORIGINAL_RESTORATION_AGENT_TASK_KEY } = require('./originalPlanRestorationAgentConfig.cjs');
const { CONTENT_GENERATION_AGENT_TASK_KEY } = require('./contentGenerationAgent.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');
const {
  clearContent,
  runFeasibilityAnalysisTask,
  runFeasibilityParametersTask,
  runFeasibilityContentTask,
  runFeasibilityHumanWritingTask,
} = require('./feasibilityReportTasks.cjs');
const { runFeasibilityOutlineTask } = require('./feasibilityOutlineTask.cjs');
const { runFeasibilityOutlineAdjustmentTask } = require('./feasibilityOutlineAdjustmentTask.cjs');
const { normalizeLogs } = require('./taskLogStore.cjs');
const { taskSlotKey, buildQueueScopeId, projectTaskKey } = require('../utils/projectKeys.cjs');

const taskDefinitions = {
  'bid-section-extraction': {
    label: '多标段识别',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidSectionExtractionTask',
  },
  'bid-analysis': {
    label: '招标文件解析',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'bidAnalysisTask',
  },
  'outline-generation': {
    label: '目录生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineGenerationTask',
  },
  'outline-adjustment': {
    label: '目录AI调整',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'outlineAdjustmentTask',
  },
  'global-facts-generation': {
    label: '全局事实设定',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsTask',
  },
  'global-facts-adjustment': {
    label: '全局事实AI调整',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'globalFactsAdjustmentTask',
  },
  'content-generation': {
    label: '正文生成',
    group: 'technical-plan',
    groupLabel: '技术方案',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'technicalPlan',
    field: 'contentGenerationTask',
  },
  'rejection-items-extraction': {
    label: '无效与废标项解析',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 1,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'extractionTask',
  },
  'rejection-check-run': {
    label: '废标项检查',
    group: 'rejection-check',
    groupLabel: '废标项检查',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'rejectionCheck',
    field: 'checkTask',
  },
  'duplicate-analysis': {
    label: '标书查重分析',
    group: 'duplicate-check',
    groupLabel: '标书查重',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'duplicateCheck',
    field: 'analysisTask',
  },
  'feasibility-analysis': {
    label: '可研项目资料分析',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 2,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'analysisTask',
  },
  'feasibility-outline': {
    label: '可研报告目录生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'outlineTask',
  },
  'feasibility-outline-adjustment': {
    label: '可研报告目录AI调整',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 3,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'outlineAdjustmentTask',
  },
  'feasibility-parameters': {
    label: '可研关键参数生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 4,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'parametersTask',
  },
  'feasibility-content': {
    label: '可研报告正文生成',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'contentTask',
  },
  'feasibility-human-writing': {
    label: '可研自然化审校',
    group: 'feasibility-report',
    groupLabel: '可行性研究报告',
    step: 5,
    lockPolicy: 'group-exclusive',
    stateKey: 'feasibilityReport',
    field: 'humanWritingTask',
  },
};

function now() {
  return new Date().toISOString();
}

function getTaskDefinition(type) {
  return taskDefinitions[type] || { label: type, stateKey: 'technicalPlan', field: undefined, lockPolicy: 'none' };
}

function getScopeId(payload) {
  const scopeId = payload?.scopeId ?? payload?.scope_id;
  return scopeId === undefined || scopeId === null ? '' : String(scopeId);
}

function createDuplicateCheckPayloadSignature(payload = {}) {
  const tenderFiles = Array.isArray(payload.tenderFiles) ? payload.tenderFiles : [payload.tenderFile].filter(Boolean);
  const files = [...tenderFiles, ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

function getPayloadSignature(type, payload) {
  if (type === 'duplicate-analysis') {
    return createDuplicateCheckPayloadSignature(payload);
  }
  return undefined;
}

function isActiveTaskStatus(status) {
  return status === 'running' || status === 'pausing';
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function copyPatchFields(target, source, fields) {
  for (const field of fields) {
    if (hasOwn(source, field)) {
      target[field] = source[field];
    }
  }
}

// 提取技术方案流程中由用户选择或填写的任务参数，不包含生成结果和正文缓存。
function createTechnicalPlanUserSettings(state = {}) {
  const settings = {};
  copyPatchFields(settings, state, [
    'step',
    'tenderFile',
    'tenderFiles',
    'originalPlanFile',
    'bidAnalysisMode',
    'bidAnalysisSelectedTaskIds',
    'bidSectionMode',
    'outlineMode',
    'outlineExpansionMode',
    'outlineWordControlOptions',
    'outlineWordControlSnapshot',
    'referenceKnowledgeDocumentIds',
    'contentGenerationOptions',
  ]);
  return settings;
}

const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';

function clearOutlineContentByIds(items, interruptedIds) {
  if (!(interruptedIds instanceof Set) || !interruptedIds.size) {
    return items;
  }

  return (items || []).map((item) => {
    const nextItem = interruptedIds.has(item.id) ? { ...item, content: '' } : { ...item };
    if (item?.children?.length) {
      nextItem.children = clearOutlineContentByIds(item.children, interruptedIds);
    }
    return nextItem;
  });
}

function normalizeInterruptedContentSections(technicalPlan) {
  const sections = technicalPlan?.contentGenerationSections || {};
  const interruptedIds = new Set();
  const nextSections = { ...sections };

  for (const [itemId, section] of Object.entries(sections)) {
    if (section?.status !== 'running') {
      continue;
    }
    interruptedIds.add(itemId);
    // 单小节重新生成时异常退出可能丢失旧正文；场景极窄，恢复优先保证可继续重跑，不额外保存旧正文。
    nextSections[itemId] = {
      ...section,
      status: 'error',
      content: '',
      error: INTERRUPTED_SECTION_ERROR,
      updated_at: now(),
    };
  }

  if (!interruptedIds.size) {
    return { sections, outlineData: technicalPlan?.outlineData, interruptedIds };
  }

  const outlineData = technicalPlan?.outlineData?.outline
    ? {
      ...technicalPlan.outlineData,
      outline: clearOutlineContentByIds(technicalPlan.outlineData.outline, interruptedIds),
    }
    : technicalPlan?.outlineData;

  return { sections: nextSections, outlineData, interruptedIds };
}

function inferContentGenerationPhase(technicalPlan) {
  return technicalPlan?.contentGenerationTask?.stats?.content?.phase
    || technicalPlan?.contentGenerationRuntime?.phase
    || 'planning';
}

function createTask(type, payload) {
  const definition = getTaskDefinition(type);
  const scopeId = getScopeId(payload);
  const payloadSignature = getPayloadSignature(type, payload);
  return {
    task_id: crypto.randomUUID(),
    type,
    group: definition.group,
    step: definition.step,
    lock_policy: definition.lockPolicy,
    scope_id: scopeId || undefined,
    payload_signature: payloadSignature,
    project_id: payload?.projectId || null,
    status: 'running',
    progress: 0,
    logs: [],
    started_at: now(),
    updated_at: now(),
  };
}

function createTaskService({ templateStore, aiService, agentService, autoConfirmationService, technicalPlanStore, rejectionCheckStore, duplicateCheckStore, feasibilityReportStore, storeRegistry, knowledgeBaseService, duplicateCheckService, openXmlHelperService }) {
  const subscribers = new Set();
  const callbackSubscribers = new Set();
  // 任务注册表：键为 `${projectId||'_global'}:${type}`（taskSlotKey），每项目每 type 一槽。
  const activeTasks = new Map();
  const activeTaskControls = new Map();

  // 当前项目（pause/confirm 等 payload 无 projectId 的入口用；接线前恒 null → '_global'）
  const resolveProjectId = () => (storeRegistry ? storeRegistry.getCurrentProjectId() : null);

  // 三域 store 按 task.project_id 路由；feasibilityReportStore 恒全局单例不进 registry。
  // registry 未接线（T9 前）或任务无 project_id（feasibility/legacy）时回退闭包单例，保持既有行为。
  function resolveStoresForTask(task) {
    if (storeRegistry && task?.project_id) {
      return { ...storeRegistry.resolveStores(task.project_id), feasibilityReportStore };
    }
    return { technicalPlanStore, rejectionCheckStore, duplicateCheckStore, feasibilityReportStore };
  }

  function emit(task, snapshot) {
    const event = { task, ...snapshot };
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', event);
      }
    }
    for (const callback of callbackSubscribers) {
      callback(event);
    }
  }

  function buildTechnicalPlanSnapshot(task, state = {}, eventPatch = {}) {
    const patch = { ...(eventPatch.technicalPlanPatch || {}) };
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = task || state?.[taskField];
    }

    if (task.type === 'bid-analysis') {
      copyPatchFields(patch, state, ['bidAnalysisMode', 'bidAnalysisProgress', 'projectOverview', 'techRequirements', 'bidAnalysisTasks']);
      if (state.outlineData === null) {
        copyPatchFields(patch, state, [
          'outlineData',
          'outlineWordControlSnapshot',
          'outlineGenerationTask',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationOptions',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'bid-section-extraction') {
      copyPatchFields(patch, state, [
        'bidSectionMode',
        'bidSections',
        'bidSectionExtractionStatus',
        'bidSectionExtractionError',
        'tenderFile',
        'bidAnalysisTask',
        'bidAnalysisTasks',
        'bidAnalysisProgress',
        'projectOverview',
        'techRequirements',
        'outlineData',
        'outlineWordControlSnapshot',
        'outlineGenerationTask',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'contentGenerationTask',
        'contentGenerationOptions',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'outline-generation') {
      copyPatchFields(patch, state, [
        'outlineMode',
        'outlineExpansionMode',
        'outlineWordControlOptions',
        'outlineWordControlSnapshot',
        'referenceKnowledgeDocumentIds',
        'globalFactsTask',
        'globalFactsAdjustmentTask',
        'globalFacts',
        'bidTemplateExists',
      ]);
      if (task.status === 'success' || state.outlineData === null || hasOwn(eventPatch, 'outlineData')) {
        copyPatchFields(patch, state, [
          'outlineData',
          'globalFactsTask',
          'globalFactsAdjustmentTask',
          'globalFacts',
          'contentGenerationTask',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (task.type === 'global-facts-generation') {
      copyPatchFields(patch, state, ['globalFacts', 'globalFactsAdjustmentTask']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'global-facts-adjustment') {
      copyPatchFields(patch, state, ['globalFacts']);
      copyPatchFields(patch, state, [
        'contentGenerationTask',
        'contentGenerationSections',
        'contentGenerationPlans',
        'contentGenerationRuntime',
      ]);
    }

    if (task.type === 'content-generation') {
      copyPatchFields(patch, state, ['outlineWordControlSnapshot', 'contentGenerationRuntime']);
      if (!isActiveTaskStatus(task.status)) {
        copyPatchFields(patch, state, [
          'outlineData',
          'contentGenerationSections',
          'contentGenerationPlans',
          'contentGenerationRuntime',
        ]);
      }
    }

    if (hasOwn(eventPatch, 'outlineData')) {
      patch.outlineData = eventPatch.outlineData;
    }
    if (hasOwn(eventPatch, 'contentRuntime')) {
      patch.contentGenerationRuntime = eventPatch.contentRuntime;
    }

    const event = { technicalPlanPatch: patch };
    if (hasOwn(eventPatch, 'bidItem')) event.bidItem = eventPatch.bidItem;
    if (hasOwn(eventPatch, 'outlineData')) event.outlineData = eventPatch.outlineData;
    if (hasOwn(eventPatch, 'contentSection')) event.contentSection = eventPatch.contentSection;
    if (hasOwn(eventPatch, 'contentPlan')) event.contentPlan = eventPatch.contentPlan;
    if (hasOwn(eventPatch, 'contentRuntime')) event.contentRuntime = eventPatch.contentRuntime;
    return event;
  }

  function buildFeasibilityReportSnapshot(task, state = {}) {
    const patch = {};
    const taskField = getTaskField(task.type);
    if (taskField) {
      patch[taskField] = state?.[taskField] || task;
    }
    copyPatchFields(patch, state, [
      'step',
      'projectInfo',
      'sourceFiles',
      'analysisMarkdown',
      'outlineTemplate',
      'targetWords',
      'referenceDocumentIds',
      'keyParametersMarkdown',
      'outlineData',
      'analysisTask',
      'outlineTask',
      'outlineAdjustmentTask',
      'parametersTask',
      'contentTask',
      'humanWritingTask',
    ]);
    return { feasibilityReportPatch: patch };
  }

  function buildSnapshot(definition, state, task, eventPatch) {
    if (definition.stateKey === 'technicalPlan') {
      return buildTechnicalPlanSnapshot(task, state, eventPatch);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheckPatch: state };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheckPatch: state };
    }
    if (definition.stateKey === 'feasibilityReport') {
      return buildFeasibilityReportSnapshot(task, state, eventPatch);
    }
    return {};
  }

  function getSnapshotForTask(task) {
    const definition = getTaskDefinition(task.type);
    const stores = resolveStoresForTask(task);
    if (definition.stateKey === 'technicalPlan') {
      return buildSnapshot(definition, stores.technicalPlanStore.loadTechnicalPlan(), task);
    }
    if (definition.stateKey === 'rejectionCheck') {
      return { rejectionCheck: stores.rejectionCheckStore.loadRejectionCheck() };
    }
    if (definition.stateKey === 'duplicateCheck') {
      return { duplicateCheck: stores.duplicateCheckStore.loadDuplicateCheck() };
    }
    if (definition.stateKey === 'feasibilityReport') {
      return buildSnapshot(definition, stores.feasibilityReportStore.loadFeasibilityReport(), task);
    }
    return {};
  }

  function subscribe(webContents) {
    subscribers.add(webContents);
    for (const task of activeTasks.values()) {
      if (!webContents.isDestroyed()) {
        webContents.send('tasks:event', { task, ...getSnapshotForTask(task) });
      }
    }
    webContents.once('destroyed', () => subscribers.delete(webContents));
  }

  /**
   * 订阅 Main 进程中的任务事件，并返回取消订阅函数
   */
  function subscribeCallback(callback) {
    callbackSubscribers.add(callback);
    for (const task of activeTasks.values()) {
      callback({ task, ...getSnapshotForTask(task) });
    }
    return () => callbackSubscribers.delete(callback);
  }

  function getTaskField(type) {
    return getTaskDefinition(type).field;
  }

  function getActiveTaskConflict(type, payload, projectId = null) {
    const definition = getTaskDefinition(type);
    if (definition.lockPolicy === 'none' || !definition.group) {
      return null;
    }

    const nextScopeId = getScopeId(payload);
    for (const task of activeTasks.values()) {
      if (!isActiveTaskStatus(task.status) || task.type === type) {
        continue;
      }
      if (task.project_id !== projectId) {
        continue; // 跨项目放行（spec §5.2）：互斥只作用于同项目任务
      }

      const activeDefinition = getTaskDefinition(task.type);
      if (activeDefinition.group !== definition.group) {
        continue;
      }

      if (definition.lockPolicy === 'group-exclusive' || activeDefinition.lockPolicy === 'group-exclusive') {
        return { task, definition: activeDefinition };
      }

      if (definition.lockPolicy === 'scope-exclusive' && nextScopeId && task.scope_id === nextScopeId) {
        return { task, definition: activeDefinition };
      }
    }

    return null;
  }

  function assertTaskCanStart(type, payload) {
    const projectId = payload?.projectId || null;
    const conflict = getActiveTaskConflict(type, payload, projectId);
    if (!conflict) {
      const definition = getTaskDefinition(type);
      const startStores = resolveStoresForTask({ project_id: projectId });
      if (definition.group === 'technical-plan') {
        const technicalPlan = startStores.technicalPlanStore.loadTechnicalPlan() || {};
        const pausedContentTask = technicalPlan.contentGenerationTask;
        if (pausedContentTask?.status === 'paused') {
          const developerRestart = type === 'content-generation'
            && payload?.developerRestart
            && Boolean(aiService?.isDeveloperMode?.());
          if (type === 'content-generation' && (payload?.resume || developerRestart)) {
            return;
          }
          throw new Error('正文生成已暂停，请先继续当前正文生成任务或重置技术方案后再启动新的任务。');
        }
      }
      if (definition.group === 'feasibility-report' && feasibilityReportStore) {
        const report = startStores.feasibilityReportStore.loadFeasibilityReport() || {};
        if (report.contentTask?.status === 'paused') {
          if (type === 'feasibility-content' && (payload?.resume || payload?.onlyMissing)) {
            return;
          }
          throw new Error('可研正文生成已暂停，请先继续当前正文生成或重置可研后再启动新的任务。');
        }
      }
      return;
    }

    const definition = getTaskDefinition(type);
    throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${conflict.definition.label || conflict.task.type}”，请完成后再启动“${definition.label || type}”。`);
  }

  function updateWorkspaceStateWithoutReload(definition, partial, task) {
    const stores = resolveStoresForTask(task);
    if (definition.stateKey === 'technicalPlan') {
      stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'rejectionCheck') {
      stores.rejectionCheckStore.updateRejectionCheckWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'duplicateCheck') {
      stores.duplicateCheckStore.updateDuplicateCheckWithoutReload(partial);
      return;
    }
    if (definition.stateKey === 'feasibilityReport') {
      stores.feasibilityReportStore.updateFeasibilityReportWithoutReload(partial);
      return;
    }
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
  }

  function loadWorkspaceState(definition, task) {
    const stores = resolveStoresForTask(task);
    if (definition.stateKey === 'technicalPlan') {
      return stores.technicalPlanStore.loadTechnicalPlan();
    }
    if (definition.stateKey === 'rejectionCheck') {
      return stores.rejectionCheckStore.loadRejectionCheck();
    }
    if (definition.stateKey === 'duplicateCheck') {
      return stores.duplicateCheckStore.loadDuplicateCheck();
    }
    if (definition.stateKey === 'feasibilityReport') {
      return stores.feasibilityReportStore.loadFeasibilityReport();
    }
    return stores.technicalPlanStore.loadTechnicalPlan();
  }

  // 在 Agent 失败时采集父任务及其前置步骤的用户参数快照。
  function createAgentUserTaskContext(type, definition, payload, currentTask) {
    const workspaceState = loadWorkspaceState(definition, currentTask) || {};
    return {
      managed_task: {
        type,
        label: definition.label || type,
        group: definition.group || '',
        group_label: definition.groupLabel || '',
        step: definition.step,
        state_key: definition.stateKey || '',
        payload,
        state: currentTask,
      },
      workflow_settings: definition.stateKey === 'technicalPlan'
        ? createTechnicalPlanUserSettings(workspaceState)
        : {},
    };
  }

  function startManagedTask(type, payload, runner, initialPartial = {}, startOptions = {}) {
    const startSlot = taskSlotKey(payload?.projectId || null, type);
    const existingTask = activeTasks.get(startSlot);
    if (existingTask && isActiveTaskStatus(existingTask.status)) {
      const nextPayloadSignature = getPayloadSignature(type, payload);
      if (existingTask.payload_signature && nextPayloadSignature && existingTask.payload_signature !== nextPayloadSignature) {
        const definition = getTaskDefinition(type);
        throw new Error(`当前${definition.groupLabel || '任务组'}正在执行“${definition.label || type}”，请等待当前任务完成后再重新分析新的文件集合。`);
      }
      emit(existingTask, getSnapshotForTask(existingTask));
      return existingTask;
    }

    assertTaskCanStart(type, payload);
    startOptions.beforeStart?.();

    const definition = getTaskDefinition(type);
    const task = startOptions.existingTask || createTask(type, payload);
    const slot = taskSlotKey(task.project_id, type);
    const queueScopeId = buildQueueScopeId(task.project_id, type, task.task_id);
    // 任务运行期间钉住项目连接，防止 LRU 淘汰正在使用的库连接（spec §5.1）
    const release = task.project_id ? storeRegistry?.acquire(task.project_id) : null;
    activeTasks.set(slot, task);
    const taskField = getTaskField(type);
    let currentTask = task;
    const abortController = new AbortController();
    let resolveSettled;
    const settledPromise = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    const taskControl = {
      queueScopeId,
      signal: abortController.signal,
      pauseRequested: false,
      outlineSelectionWaiter: null,
      outlineSelectionResult: null,
      outlineSelectionAutoConfirmationId: null,
      isPauseRequested() {
        return this.pauseRequested;
      },
      requestPause() {
        this.pauseRequested = true;
        const pausedLogs = currentTask.logs?.length
          ? currentTask.logs
          : ['已请求暂停，正在等待当前 AI 请求完成。'];
        return checkpointTask({ status: 'pausing', pause_requested: true, logs: pausedLogs }).task;
      },
      waitForOutlineSelection() {
        if (abortController.signal.aborted) {
          throw abortController.signal.reason || new Error('目录生成任务已取消');
        }
        if (this.outlineSelectionResult) return Promise.resolve(this.outlineSelectionResult);
        if (this.outlineSelectionWaiter) {
          this.registerOutlineSelectionAutoConfirmation?.();
          return this.outlineSelectionWaiter.promise;
        }
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        promise.catch(() => undefined);
        this.outlineSelectionWaiter = { promise, resolve, reject };
        this.registerOutlineSelectionAutoConfirmation?.();
        return promise;
      },
      cancel(reason = '后台任务已取消') {
        const error = new Error(reason);
        error.code = 'TASK_CANCELLED';
        this.outlineSelectionWaiter?.reject?.(error);
        this.outlineSelectionWaiter = null;
        autoConfirmationService.unregister(this.outlineSelectionAutoConfirmationId);
        this.outlineSelectionAutoConfirmationId = null;
        if (!abortController.signal.aborted) abortController.abort(error);
      },
      waitForSettlement() {
        return settledPromise;
      },
      dispose() {
        this.outlineSelectionWaiter?.reject?.(new Error('目录生成任务已结束'));
        this.outlineSelectionWaiter = null;
        autoConfirmationService.unregister(this.outlineSelectionAutoConfirmationId);
        this.outlineSelectionAutoConfirmationId = null;
      },
    };
    activeTaskControls.set(slot, taskControl);

    const applyTaskPatch = (partial) => {
      const nextStatus = currentTask.status === 'pausing' && partial.status === 'running'
        ? 'pausing'
        : partial.status || currentTask.status;
      currentTask = {
        ...currentTask,
        ...partial,
        status: nextStatus,
        pause_requested: partial.pause_requested === false ? false : taskControl.pauseRequested || partial.pause_requested,
        logs: partial.logs ? normalizeLogs(partial.logs) : currentTask.logs,
        updated_at: now(),
      };
      activeTasks.set(slot, currentTask);
      return currentTask;
    };

    // 仅更新内存并推送 Renderer，用于无恢复价值的高频展示状态。
    const updateTask = (partial, workspaceState = {}, eventPatch) => {
      const nextTask = applyTaskPatch(partial);
      emit(nextTask, buildSnapshot(definition, { ...(workspaceState || {}), [taskField]: nextTask }, nextTask, eventPatch));
      return nextTask;
    };

    // 将业务状态和任务状态作为同一个 checkpoint 落库，并在提交后统一推送事件。
    const checkpointTask = (taskPartial, workspacePartial = {}, eventPatch) => {
      if (taskControl.signal.aborted) {
        throw taskControl.signal.reason || new Error('后台任务已取消');
      }
      const nextTask = applyTaskPatch(taskPartial);
      const persistedPatch = {
        ...(workspacePartial || {}),
        [taskField]: nextTask,
      };
      updateWorkspaceStateWithoutReload(definition, persistedPatch, nextTask);
      emit(nextTask, buildSnapshot(definition, persistedPatch, nextTask, eventPatch));
      return { task: nextTask };
    };

    // 为一级目录默认选择注册自动确认，并把截止时间同步到任务状态。
    taskControl.registerOutlineSelectionAutoConfirmation = () => {
      if (type !== 'outline-generation' || taskControl.outlineSelectionAutoConfirmationId) return;
      const selection = currentTask.stats?.outline_selection;
      if (!selection?.items?.length || !selection.selected_ids?.length || selection.confirmed) return;
      const confirmationId = `outline-selection:${currentTask.task_id}`;
      const defaultItems = selection.items;
      const defaultSelectedIds = selection.selected_ids;
      taskControl.outlineSelectionAutoConfirmationId = confirmationId;
      autoConfirmationService.register({
        id: confirmationId,
        submit: () => taskControl.confirmOutlineSelection({
          taskId: currentTask.task_id,
          items: defaultItems,
          selectedIds: defaultSelectedIds,
        }),
        onStateChange: ({ auto_answer_at: autoAnswerAt }) => {
          const currentSelection = currentTask.stats?.outline_selection;
          if (!currentSelection || currentSelection.confirmed) return;
          const nextSelection = { ...currentSelection };
          if (autoAnswerAt) nextSelection.auto_answer_at = autoAnswerAt;
          else delete nextSelection.auto_answer_at;
          currentTask = checkpointTask({
            stats: {
              ...(currentTask.stats || {}),
              outline_selection: nextSelection,
            },
          }).task;
        },
      });
    };

    taskControl.confirmOutlineSelection = (request = {}) => {
      if (type !== 'outline-generation' || request.taskId !== currentTask.task_id) {
        throw new Error('一级目录生成结果已变化，请重新打开后再选择');
      }
      const waiter = taskControl.outlineSelectionWaiter;
      if (!waiter) throw new Error('当前目录任务不在一级目录确认阶段');
      const items = Array.isArray(request.items) ? request.items : [];
      const selectedIds = Array.isArray(request.selectedIds) ? request.selectedIds : [];
      autoConfirmationService.unregister(taskControl.outlineSelectionAutoConfirmationId);
      taskControl.outlineSelectionAutoConfirmationId = null;
      const checkpoint = checkpointTask({
        stats: {
          ...(currentTask.stats || {}),
          outline_selection: {
            items,
            selected_ids: selectedIds,
            confirmed: true,
          },
        },
      });
      currentTask = checkpoint.task;
      taskControl.outlineSelectionWaiter = null;
      taskControl.outlineSelectionResult = { items, selectedIds };
      waiter.resolve(taskControl.outlineSelectionResult);
      return { success: true };
    };

    // 用户修改一级目录草稿后停止当前确认项的自动提交。
    taskControl.suppressOutlineSelectionAutoConfirmation = (request = {}) => {
      if (type !== 'outline-generation' || request.taskId !== currentTask.task_id) {
        return { success: true };
      }
      autoConfirmationService.suppress(taskControl.outlineSelectionAutoConfirmationId);
      return { success: true };
    };

    const previousState = loadWorkspaceState(definition, task) || {};
    const initialState = startOptions.skipInitialStateUpdate
      ? previousState
      : { ...initialPartial, [taskField]: currentTask };
    if (!startOptions.skipInitialStateUpdate) {
      updateWorkspaceStateWithoutReload(definition, initialState, currentTask);
    }
    emit(currentTask, buildSnapshot(definition, initialState, currentTask));
    if (startOptions.restoreOutlineSelectionWaiter) {
      taskControl.waitForOutlineSelection();
    }

    const taskStores = resolveStoresForTask(task);
    const runnerWorkspaceStore = definition.stateKey === 'technicalPlan'
      ? taskStores.technicalPlanStore
      : definition.stateKey === 'rejectionCheck'
        ? taskStores.rejectionCheckStore
        : definition.stateKey === 'feasibilityReport'
          ? taskStores.feasibilityReportStore
          : taskStores.duplicateCheckStore;
    const runnerAiService = aiService?.withQueueScope ? aiService.withQueueScope(queueScopeId, taskControl.signal) : aiService;
    const agentTaskContextProvider = () => createAgentUserTaskContext(type, definition, payload, currentTask);
    // 项目内执行时把 project_id/project_name 传给 Agent：持久任务键自动加前缀（T5 路由），提问面板显示项目名。
    const taskProjectName = task.project_id && typeof storeRegistry?.getProjectName === 'function'
      ? (storeRegistry.getProjectName(task.project_id) ?? null)
      : null;
    const runnerAgentService = agentService.bindTaskContext(
      agentTaskContextProvider,
      {
        queueScopeId,
        signal: taskControl.signal,
        primary_session: startOptions.primarySession === true,
        project_id: task.project_id,
        project_name: taskProjectName,
      },
    );
    const runnerOrdinaryAgentService = agentService.bindTaskContext(
      agentTaskContextProvider,
      {
        queueScopeId,
        signal: taskControl.signal,
        project_id: task.project_id,
        project_name: taskProjectName,
      },
    );
    runner({ templateStore, aiService: runnerAiService, agentService: runnerAgentService, ordinaryAgentService: runnerOrdinaryAgentService, workspaceStore: runnerWorkspaceStore, knowledgeBaseService, openXmlHelperService, updateTask, checkpointTask, payload, taskControl, previousState }).catch((error) => {
      if (!taskControl.signal.aborted) {
        checkpointTask({ status: 'error', error: error.message || '任务执行失败' });
      }
    }).finally(() => {
      taskControl.dispose();
      if (aiService?.resumeQueueScope) {
        aiService.resumeQueueScope(queueScopeId);
      }
      if (activeTasks.get(slot) === currentTask) activeTasks.delete(slot);
      if (activeTaskControls.get(slot) === taskControl) activeTaskControls.delete(slot);
      release?.();
      resolveSettled();
    });

    return currentTask;
  }

  // 取消指定组的运行中任务并等待退出，避免清空下游后旧任务继续提交 checkpoint。
  // projectId 显式传入才过滤（缺省=所有项目的该组任务，禁止"缺省=当前项目"语义）；taskTypes 为类型白名单。
  // 第二参数兼容旧的位置参数数组（等价于 { taskTypes }）。
  function collectGroupTaskControls(group, options = {}) {
    if (Array.isArray(options)) options = { taskTypes: options };
    const typeFilter = Array.isArray(options.taskTypes) && options.taskTypes.length ? new Set(options.taskTypes) : null;
    const controls = [];
    for (const [slot, task] of activeTasks.entries()) {
      const definition = getTaskDefinition(task.type);
      const control = activeTaskControls.get(slot);
      if (definition.group !== group || !isActiveTaskStatus(task.status) || !control?.cancel) continue;
      if (options.projectId && task.project_id !== options.projectId) continue;
      if (typeFilter && !typeFilter.has(task.type)) continue;
      controls.push(control);
    }
    return controls;
  }

  async function cancelTechnicalPlanTasks(reason, options = {}) {
    const controls = collectGroupTaskControls('technical-plan', options);
    for (const control of controls) control.cancel(reason);
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  // 取消废标检查任务并等待退出，避免清空下游后旧任务继续提交 checkpoint。
  async function cancelRejectionCheckTasks(reason, options = {}) {
    const controls = collectGroupTaskControls('rejection-check', options);
    for (const control of controls) control.cancel(reason);
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  // 取消标书查重任务并等待退出，避免清空下游后旧任务继续提交 checkpoint。
  async function cancelDuplicateCheckTasks(reason, options = {}) {
    const controls = collectGroupTaskControls('duplicate-check', options);
    for (const control of controls) control.cancel(reason);
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  async function cancelFeasibilityReportTasks(reason, options = {}) {
    const controls = collectGroupTaskControls('feasibility-report', options);
    for (const control of controls) control.cancel(reason);
    await Promise.all(controls.map((control) => control.waitForSettlement()));
  }

  function recoverInterruptedContentGenerationTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'content-generation'))) {
      return;
    }

    const contentTask = technicalPlan.contentGenerationTask;
    if (!isActiveTaskStatus(contentTask?.status)) {
      return;
    }

    const { sections, outlineData, interruptedIds } = normalizeInterruptedContentSections(technicalPlan);
    const normalizedPlan = interruptedIds.size
      ? { ...technicalPlan, contentGenerationSections: sections, outlineData }
      : technicalPlan;
    const phase = inferContentGenerationPhase(normalizedPlan);
    const nextLogs = [
      ...(Array.isArray(contentTask.logs) ? contentTask.logs : []),
      '上次正文生成因应用关闭而暂停，可点击继续恢复。',
    ];
    const nextStats = {
      ...(contentTask.stats || {}),
      content: {
        ...(contentTask.stats?.content || {}),
        phase,
      },
    };
    const pausedTask = {
      ...contentTask,
      project_id: contentTask.project_id ?? projectId,
      status: 'paused',
      pause_requested: false,
      logs: nextLogs,
      stats: nextStats,
      updated_at: now(),
    };
    const partial = {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationTask: pausedTask,
      contentGenerationRuntime: {
        ...(normalizedPlan.contentGenerationRuntime || {}),
        phase,
        updated_at: now(),
      },
    };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(pausedTask, buildSnapshot(getTaskDefinition('content-generation'), partial, pausedTask));
  }

  function recoverInterruptedOutlineGenerationTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'outline-generation'))) {
      return;
    }

    const outlineTask = technicalPlan.outlineGenerationTask;
    if (!isActiveTaskStatus(outlineTask?.status)) {
      return;
    }

    const agentState = outlineTask.stats?.agent || {};
    let persistentTask = null;
    let templatePersistentTask = null;
    try {
      persistentTask = agentService.loadPersistentTask(projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY));
    } catch {}
    try {
      templatePersistentTask = agentService.loadPersistentTask(projectTaskKey(projectId, TEMPLATE_EXTRACTION_AGENT_TASK_KEY));
    } catch {}
    const recoverableWaiting = persistentTask?.state?.run_id === outlineTask.task_id
      && persistentTask.state.status === 'waiting-outline-selection'
      && persistentTask.state.phase === 'outline-selection'
      && persistentTask.state.agent_connection === 'idle'
      && Boolean(persistentTask.state.session_file)
      && agentService.hasPersistentTaskSession(projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY))
      && Boolean(outlineTask.stats?.outline_selection?.items?.length)
      && outlineTask.stats.outline_selection.confirmed !== true;
    if (recoverableWaiting) {
      // 自动重启必须带 projectId，使 slot/queueScope/store 落到对应项目
      startManagedTask('outline-generation', {
        ...(agentState.resume_payload || {}),
        projectId,
        agent_resume: {
          phase: 'outline-selection',
        },
      }, runOutlineGenerationTaskV2, {}, {
        existingTask: { ...outlineTask, project_id: outlineTask.project_id ?? projectId },
        skipInitialStateUpdate: true,
        restoreOutlineSelectionWaiter: true,
        primarySession: agentService.isPrimarySession({ task_key: projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY) }, projectId),
      });
      return;
    }

    const message = '上次目录生成未完成，请重新生成目录。';
    if (persistentTask) {
      try {
        agentService.updatePersistentTask(projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY), {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    if (templatePersistentTask) {
      try {
        agentService.updatePersistentTask(projectTaskKey(projectId, TEMPLATE_EXTRACTION_AGENT_TASK_KEY), {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    try { stores.technicalPlanStore.clearBidTemplate(); } catch {}
    const recoveredStats = { ...(outlineTask.stats || {}) };
    delete recoveredStats.outline_selection;
    if (recoveredStats.agent) {
      recoveredStats.agent = {
        ...recoveredStats.agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    if (recoveredStats.template_agent) {
      recoveredStats.template_agent = {
        ...recoveredStats.template_agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    const recoveredTask = {
      ...outlineTask,
      project_id: outlineTask.project_id ?? projectId,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(outlineTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(outlineTask.logs) ? outlineTask.logs : []), message],
      stats: recoveredStats,
      updated_at: now(),
    };
    const partial = { outlineGenerationTask: recoveredTask };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-generation'), partial, recoveredTask));
  }

  function recoverInterruptedOutlineAdjustmentTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'outline-adjustment'))) {
      return;
    }

    const adjustmentTask = technicalPlan.outlineAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      project_id: adjustmentTask.project_id ?? projectId,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { outlineAdjustmentTask: recoveredTask };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-adjustment'), partial, recoveredTask));
  }

  function recoverInterruptedGlobalFactsAdjustmentTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'global-facts-adjustment'))) {
      return;
    }

    const adjustmentTask = technicalPlan.globalFactsAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次全局事实 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      project_id: adjustmentTask.project_id ?? projectId,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { globalFactsAdjustmentTask: recoveredTask };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-adjustment'), partial, recoveredTask));
  }

  function recoverInterruptedBidAnalysisTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'bid-analysis'))) {
      return;
    }

    const bidAnalysisTask = technicalPlan.bidAnalysisTask;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) {
      return;
    }

    const message = '上次招标文件解析未完成，请重新解析';
    const interruptedBidAnalysisTasks = {};
    for (const [itemId, item] of Object.entries(technicalPlan.bidAnalysisTasks || {})) {
      if (item?.status === 'running') {
        interruptedBidAnalysisTasks[itemId] = {
          ...item,
          status: 'error',
          error: message,
        };
      }
    }

    const logs = Array.isArray(bidAnalysisTask.logs) ? bidAnalysisTask.logs : [];
    const recoveredTask = {
      ...bidAnalysisTask,
      project_id: bidAnalysisTask.project_id ?? projectId,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: logs.includes(message) ? logs : [...logs, message],
      updated_at: now(),
    };
    const partial = Object.keys(interruptedBidAnalysisTasks).length
      ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: interruptedBidAnalysisTasks }
      : { bidAnalysisTask: recoveredTask };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-analysis'), partial, recoveredTask));
  }

  function recoverInterruptedBidSectionExtractionTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'bid-section-extraction'))) {
      return;
    }

    const extractionTask = technicalPlan.bidSectionExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const message = '上次多标段识别未完成，请重新识别';
    const recoveredTask = {
      ...extractionTask,
      project_id: extractionTask.project_id ?? projectId,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(extractionTask.logs) ? extractionTask.logs : []), message],
      updated_at: now(),
    };
    const partial = {
      bidSectionExtractionTask: recoveredTask,
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-section-extraction'), partial, recoveredTask));
  }

  function recoverInterruptedGlobalFactsTask(projectId, technicalPlan, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'global-facts-generation'))) {
      return;
    }

    const globalFactsTask = technicalPlan.globalFactsTask;
    if (!isActiveTaskStatus(globalFactsTask?.status)) {
      return;
    }

    const message = '上次全局事实设定未完成，请重新解析';
    const recoveredTask = {
      ...globalFactsTask,
      project_id: globalFactsTask.project_id ?? projectId,
      status: 'error',
      progress: 100,
      error: message,
      logs: [...(Array.isArray(globalFactsTask.logs) ? globalFactsTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { globalFactsTask: recoveredTask };
    stores.technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-generation'), partial, recoveredTask));
  }

  function recoverInterruptedRejectionCheckTasks(projectId, state, stores) {
    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';
    const partial = {};

    if (!activeTasks.has(taskSlotKey(projectId, 'rejection-items-extraction')) && state.extractionTask?.status === 'running') {
      partial.invalidBidAndRejectionItems = state.invalidBidAndRejectionItems?.status === 'running'
        ? { ...state.invalidBidAndRejectionItems, status: 'error', error: staleExtractionMessage, updatedAt: now() }
        : state.invalidBidAndRejectionItems;
      partial.extractionTask = {
        ...state.extractionTask,
        status: 'error',
        progress: 100,
        error: staleExtractionMessage,
        logs: [staleExtractionMessage],
        updated_at: now(),
      };
    }

    if (!activeTasks.has(taskSlotKey(projectId, 'rejection-check-run')) && state.checkTask?.status === 'running') {
      const markResult = (result) => result?.status === 'running'
        ? { ...result, status: 'error', error: staleCheckMessage, progressMessage: staleCheckMessage, updatedAt: now() }
        : result;
      partial.rejectionCheckResult = markResult(state.rejectionCheckResult);
      partial.typoCheckResult = markResult(state.typoCheckResult);
      partial.logicCheckResult = markResult(state.logicCheckResult);
      partial.checkTask = {
        ...state.checkTask,
        status: 'error',
        progress: 100,
        error: staleCheckMessage,
        logs: [staleCheckMessage],
        updated_at: now(),
      };
    }

    if (Object.keys(partial).length) {
      stores.rejectionCheckStore.updateRejectionCheckWithoutReload(partial);
    }
  }

  function recoverInterruptedDuplicateCheckTask(projectId, state, stores) {
    if (activeTasks.has(taskSlotKey(projectId, 'duplicate-analysis'))) {
      return;
    }
    if (state.analysisTask?.status !== 'running') {
      return;
    }
    const message = '上次标书查重分析未完成，请重新分析';
    const markAnalysis = (analysis) => analysis?.status === 'running'
      ? { ...analysis, status: 'error', progress: 100, message, updated_at: now() }
      : analysis;
    const recoveredTask = {
      ...state.analysisTask,
      project_id: state.analysisTask.project_id ?? projectId,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const partial = {
      analysisTask: recoveredTask,
      metadataAnalysis: markAnalysis(state.metadataAnalysis),
      outlineAnalysis: markAnalysis(state.outlineAnalysis),
      contentAnalysis: markAnalysis(state.contentAnalysis),
      imageAnalysis: markAnalysis(state.imageAnalysis),
    };
    stores.duplicateCheckStore.updateDuplicateCheckWithoutReload(partial);
    emit(recoveredTask, { duplicateCheckPatch: partial });
  }

  function recoverInterruptedFeasibilityTasks(state) {
    if (!feasibilityReportStore) return;
    const markError = (task, message) => {
      if (!isActiveTaskStatus(task?.status)) return undefined;
      return {
        ...task,
        status: 'error',
        progress: 100,
        error: message,
        logs: [...(Array.isArray(task.logs) ? task.logs : []), message],
        updated_at: now(),
      };
    };
    const interruptMessage = '上次任务因应用关闭而中断，请重新开始。';
    const pausedMessage = '上次正文生成因应用关闭而暂停，可点击继续恢复。';
    const partial = {};
    const analysisTask = markError(state.analysisTask, interruptMessage);
    const outlineTask = markError(state.outlineTask, interruptMessage);
    const parametersTask = markError(state.parametersTask, interruptMessage);
    const humanWritingTask = markError(state.humanWritingTask, interruptMessage);
    if (analysisTask) partial.analysisTask = analysisTask;
    if (outlineTask) partial.outlineTask = outlineTask;
    if (parametersTask) partial.parametersTask = parametersTask;
    if (humanWritingTask) partial.humanWritingTask = humanWritingTask;
    if (isActiveTaskStatus(state.outlineAdjustmentTask?.status)) {
      const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
      partial.outlineAdjustmentTask = {
        ...state.outlineAdjustmentTask,
        status: 'error',
        progress: Math.max(0, Math.min(99, Number(state.outlineAdjustmentTask.progress || 0) || 0)),
        pause_requested: false,
        error: message,
        logs: [...(Array.isArray(state.outlineAdjustmentTask.logs) ? state.outlineAdjustmentTask.logs : []), message],
        updated_at: now(),
      };
    }
    if (isActiveTaskStatus(state.contentTask?.status)) {
      partial.contentTask = {
        ...state.contentTask,
        status: 'paused',
        pause_requested: false,
        logs: [...(Array.isArray(state.contentTask.logs) ? state.contentTask.logs : []), pausedMessage],
        updated_at: now(),
      };
    }
    if (!Object.keys(partial).length) return;
    feasibilityReportStore.updateFeasibilityReportWithoutReload(partial);
    const recovered = partial.contentTask || analysisTask || outlineTask || partial.outlineAdjustmentTask || parametersTask || humanWritingTask;
    if (recovered) emit(recovered, { feasibilityReportPatch: partial });
  }

  // 按项目恢复三域（technical-plan/rejection-check/duplicate-check）中断任务。
  // registry 未接线（T9 前）直接跳过——三域状态已随项目化落位，不再做全局恢复；接线后由 IPC/启动序列按项目调用。
  function recoverInterruptedTasksForProject(projectId) {
    if (!storeRegistry) return;
    const stores = storeRegistry.resolveStores(projectId);
    const technicalPlanRecoveryState = stores.technicalPlanStore.loadTechnicalPlan() || {};
    const rejectionCheckRecoveryState = stores.rejectionCheckStore.loadRejectionCheck() || {};
    const duplicateCheckRecoveryState = stores.duplicateCheckStore.loadDuplicateCheck() || {};
    recoverInterruptedBidSectionExtractionTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedBidAnalysisTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedOutlineGenerationTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedOutlineAdjustmentTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedContentGenerationTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedGlobalFactsTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedGlobalFactsAdjustmentTask(projectId, technicalPlanRecoveryState, stores);
    recoverInterruptedRejectionCheckTasks(projectId, rejectionCheckRecoveryState, stores);
    recoverInterruptedDuplicateCheckTask(projectId, duplicateCheckRecoveryState, stores);
  }

  // feasibility 为全局域，恢复保留在构造期原位。
  const feasibilityReportRecoveryState = feasibilityReportStore?.loadFeasibilityReport?.() || {};
  recoverInterruptedFeasibilityTasks(feasibilityReportRecoveryState);

  return {
    subscribe,
    subscribeCallback,
    startBidSectionExtraction(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('bid-section-extraction', { ...payload, projectId }, runBidSectionExtractionTask, {
        bidSectionMode: 'multiple',
        bidSections: [],
        bidSectionExtractionStatus: 'running',
        bidSectionExtractionError: undefined,
        bidAnalysisTask: undefined,
        bidAnalysisTasks: {},
        bidAnalysisProgress: 0,
        projectOverview: '',
        techRequirements: '',
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineGenerationTask: undefined,
        outlineAdjustmentTask: undefined,
        referenceKnowledgeDocumentIds: [],
        globalFactsTask: undefined,
        globalFactsAdjustmentTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationOptions: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      });
    },
    startBidAnalysis(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('bid-analysis', { ...payload, projectId }, runBidAnalysisTask);
    },
    startOutlineGeneration(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      const outlineMode = payload?.outline_mode === 'standalone-technical'
        ? 'standalone-technical'
        : payload?.outline_mode === 'standalone-business'
          ? 'standalone-business'
          : 'response-file';
      const taskPayload = { ...payload, outline_mode: outlineMode, projectId };
      return startManagedTask('outline-generation', taskPayload, runOutlineGenerationTaskV2, {
        outlineMode,
        outlineExpansionMode: payload?.outline_expansion_mode === 'original-only' ? 'original-only' : 'ai-complement',
        outlineWordControlOptions: payload?.word_control_options,
        referenceKnowledgeDocumentIds: Array.isArray(payload?.reference_knowledge_document_ids) ? payload.reference_knowledge_document_ids : [],
        bidTemplateExists: false,
        outlineData: null,
        outlineWordControlSnapshot: undefined,
        outlineAdjustmentTask: undefined,
        globalFactsTask: undefined,
        globalFactsAdjustmentTask: undefined,
        globalFacts: [],
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      }, {
        primarySession: true,
        beforeStart: () => {
          agentService.deletePersistentTask(projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY));
          agentService.deletePersistentTask(projectTaskKey(projectId, TEMPLATE_EXTRACTION_AGENT_TASK_KEY));
          agentService.deletePersistentTask(projectTaskKey(projectId, ORIGINAL_RESTORATION_AGENT_TASK_KEY));
          agentService.deletePersistentTask(projectTaskKey(projectId, CONTENT_GENERATION_AGENT_TASK_KEY));
          technicalPlanStore.clearBidTemplate();
        },
      });
    },
    startOutlineAdjustment(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('outline-adjustment', { ...payload, projectId }, runOutlineAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: projectTaskKey(projectId, OUTLINE_AGENT_TASK_KEY) }, projectId),
      });
    },
    startGlobalFactsGeneration(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('global-facts-generation', { ...payload, projectId }, runGlobalFactsTaskV2, {
        invalidateContentGeneration: true,
        globalFacts: [],
        globalFactsAdjustmentTask: undefined,
        contentGenerationTask: undefined,
        contentGenerationSections: {},
        contentGenerationPlans: {},
        contentGenerationRuntime: undefined,
      }, {
        primarySession: true,
        beforeStart: () => agentService.deletePersistentTask(projectTaskKey(projectId, GLOBAL_FACTS_AGENT_TASK_KEY)),
      });
    },
    startGlobalFactsAdjustment(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('global-facts-adjustment', { ...payload, projectId }, runGlobalFactsAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: projectTaskKey(projectId, GLOBAL_FACTS_AGENT_TASK_KEY) }, projectId),
      });
    },
    startContentGeneration(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      const technicalPlan = technicalPlanStore.loadTechnicalPlan();
      if (!technicalPlan.outlineWordControlSnapshot) {
        throw new Error('当前目录没有字数控制生效快照，请重新生成目录');
      }
      const taskPayload = payload?.developerRestart ? { ...payload, regenerate: true, projectId } : { ...payload, projectId };
      const sectionRegeneration = !taskPayload?.developerRestart && Boolean(taskPayload?.targetItemId
        || ((taskPayload?.resume || taskPayload?.retryFailedSections || taskPayload?.retry_failed_sections)
          && technicalPlan.contentGenerationRuntime?.target_item_id));
      if (sectionRegeneration && isActiveTaskStatus(activeTasks.get(taskSlotKey(taskPayload?.projectId || null, 'content-generation'))?.status)) {
        throw new Error('当前正文任务正在执行，请等待完成后再修改小节');
      }
      const continuing = taskPayload?.resume || [
        'retryContentCorrection', 'retry_content_correction', 'retryFailedSections', 'retry_failed_sections',
      ].some(field => taskPayload?.[field]);
      // 普通生成没有待办时直接返回已有结果，避免 beforeStart 删除产物会话。
      function hasPendingSections(items) {
        return items.some(item => item.children?.length ? hasPendingSections(item.children)
          : item.content_mode === 'ai-generate'
            && (technicalPlan.contentGenerationSections?.[item.id]?.status !== 'success'
              || !Object.hasOwn(technicalPlan.contentGenerationRuntime?.section_words || {}, item.id)));
      }
      if (!sectionRegeneration && !continuing && !taskPayload?.regenerate
        && !taskPayload?.targetItemIds?.length && !taskPayload?.postProcessOnly
        && technicalPlan.contentGenerationTask?.status === 'success'
        && !hasPendingSections(technicalPlan.outlineData?.outline || [])) {
        const task = technicalPlan.contentGenerationTask;
        emit(task, { technicalPlanPatch: technicalPlan });
        return task;
      }
      // 只读取用户已保存的测试状态，在落库和清理会话前提示，不重新请求生图测试。
      const imageOptions = technicalPlan.contentGenerationOptions;
      // 补跑轮只做后处理不生图，跳过生图模型可用性拦截。
      if (!taskPayload?.postProcessOnly && imageOptions?.imageQuantity > 0 && imageOptions?.useAiImages
        && aiService.getConfig().image_model?.status !== 'available') {
        throw new Error('已开启 AI 生图，但当前生图模型不可用。请去设置-生图模型中点击测试，并配置可用渠道。');
      }
      // 补跑轮（postProcessOnly）沿用原 runtime，不重建——completed_stages 保留以跳过原方案还原，sections 状态不动。
      const initialState = sectionRegeneration || continuing || taskPayload?.postProcessOnly
        ? { contentGenerationRuntime: { ...technicalPlan.contentGenerationRuntime, generation_started: true } }
        : prepareContentGenerationStart(technicalPlan, taskPayload);
      return startManagedTask('content-generation', taskPayload, sectionRegeneration ? runContentSectionRegenerationTask : runContentGenerationTask, initialState, {
        primarySession: true,
        beforeStart: () => {
          if (sectionRegeneration) return;
          // 只有明确全文重生才删除正文会话；局部新增与勾选轮继续使用原 Session。
          if (!continuing && taskPayload?.regenerate && !taskPayload?.targetItemIds?.length) agentService.deletePersistentTask(projectTaskKey(projectId, CONTENT_GENERATION_AGENT_TASK_KEY));
          if (technicalPlan.originalPlanFile?.markdownPath && !continuing && !taskPayload?.postProcessOnly) {
            agentService.deletePersistentTask(projectTaskKey(projectId, ORIGINAL_RESTORATION_AGENT_TASK_KEY));
          }
        },
      });
    },
    pauseContentGeneration() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      const slot = taskSlotKey(projectId, 'content-generation');
      const task = activeTasks.get(slot);
      const control = activeTaskControls.get(slot);
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && aiService?.pauseQueueScope) {
          aiService.pauseQueueScope(control.queueScopeId);
        }
        return control.requestPause();
      }

      const technicalPlan = technicalPlanStore.loadTechnicalPlan() || {};
      const contentTask = technicalPlan.contentGenerationTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }

      throw new Error('当前没有正在生成的正文任务。');
    },
    pauseFeasibilityContent() {
      // feasibility 恒全局域（project_id=null → '_global' 前缀）
      const slot = taskSlotKey(null, 'feasibility-content');
      const task = activeTasks.get(slot);
      const control = activeTaskControls.get(slot);
      if (task && isActiveTaskStatus(task.status) && control?.requestPause) {
        if (control.queueScopeId && aiService?.pauseQueueScope) {
          aiService.pauseQueueScope(control.queueScopeId);
        }
        return control.requestPause();
      }

      const report = feasibilityReportStore?.loadFeasibilityReport?.() || {};
      const contentTask = report.contentTask;
      if (contentTask?.status === 'paused' || contentTask?.status === 'pausing') {
        return contentTask;
      }

      throw new Error('当前没有正在生成的可研正文任务。');
    },
    startRejectionItemsExtraction(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('rejection-items-extraction', { ...payload, projectId }, runRejectionItemsExtractionTask, payload?.workspaceState || {});
    },
    startRejectionCheck(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return startManagedTask('rejection-check-run', { ...payload, projectId }, runRejectionCheckTask, payload?.workspaceState || {});
    },
    startDuplicateAnalysis(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      if (!duplicateCheckService?.runAnalysisTask) {
        throw new Error('标书查重任务服务尚未初始化');
      }
      return startManagedTask('duplicate-analysis', { ...payload, projectId }, duplicateCheckService.runAnalysisTask);
    },
    startFeasibilityAnalysis(payload) {
      return startManagedTask('feasibility-analysis', payload, runFeasibilityAnalysisTask, {
        outlineData: null,
        keyParametersMarkdown: '',
        outlineTask: null,
        outlineAdjustmentTask: null,
        parametersTask: null,
        contentTask: null,
        humanWritingTask: null,
      });
    },
    startFeasibilityOutline(payload) {
      return startManagedTask('feasibility-outline', payload, runFeasibilityOutlineTask, {
        outlineTemplate: payload?.outlineTemplate,
        targetWords: payload?.targetWords,
        referenceDocumentIds: payload?.referenceDocumentIds,
        outlineData: null,
        keyParametersMarkdown: '',
        outlineAdjustmentTask: null,
        parametersTask: null,
        contentTask: null,
        humanWritingTask: null,
      }, {
        primarySession: true,
        beforeStart: () => agentService.deletePersistentTask(FEASIBILITY_OUTLINE_AGENT_TASK_KEY),
      });
    },
    startFeasibilityOutlineAdjustment(payload) {
      return startManagedTask('feasibility-outline-adjustment', payload, runFeasibilityOutlineAdjustmentTask, {}, {
        primarySession: agentService.isPrimarySession({ task_key: FEASIBILITY_OUTLINE_AGENT_TASK_KEY }),
      });
    },
    startFeasibilityParameters(payload) {
      return startManagedTask('feasibility-parameters', payload, runFeasibilityParametersTask, {
        contentTask: null,
        humanWritingTask: null,
      });
    },
    startFeasibilityContent(payload) {
      const incremental = Boolean(payload?.onlyMissing || payload?.resume);
      if (incremental) {
        return startManagedTask('feasibility-content', payload, runFeasibilityContentTask, {});
      }
      const report = feasibilityReportStore?.loadFeasibilityReport?.() || {};
      const initialPartial = { humanWritingTask: null };
      if (report.outlineData?.outline?.length) {
        initialPartial.outlineData = {
          ...report.outlineData,
          outline: clearContent(report.outlineData.outline),
        };
      }
      return startManagedTask('feasibility-content', payload, runFeasibilityContentTask, initialPartial);
    },
    startFeasibilityHumanWriting(payload) {
      return startManagedTask('feasibility-human-writing', payload, runFeasibilityHumanWritingTask);
    },
    confirmOutlineSelection(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const control = activeTaskControls.get(taskSlotKey(projectId, 'outline-generation'));
      if (!control?.confirmOutlineSelection) throw new Error('当前没有等待确认的一级目录任务');
      return control.confirmOutlineSelection(payload);
    },
    suppressOutlineSelectionAutoConfirmation(payload) {
      const projectId = payload?.projectId || (storeRegistry ? storeRegistry.getCurrentProjectId() : null);
      const control = activeTaskControls.get(taskSlotKey(projectId, 'outline-generation'));
      if (!control?.suppressOutlineSelectionAutoConfirmation) return { success: true };
      return control.suppressOutlineSelectionAutoConfirmation(payload);
    },
    async resetTechnicalPlan() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      await cancelTechnicalPlanTasks('技术方案已重置，后台任务已取消', { projectId });
      // 空闲常驻的 openxml 助手不在任务取消范围内,重置前显式关掉,确保没有进程握着招标原件
      await openXmlHelperService.close?.();
      return technicalPlanStore.clearTechnicalPlan();
    },
    // 仅重置正文阶段，保留目录、全局事实和生成配置。
    async resetContentGeneration() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      await cancelTechnicalPlanTasks('正文生成阶段已重置，后台任务已取消', { projectId, taskTypes: ['content-generation'] });
      technicalPlanStore.updateTechnicalPlanWithoutReload({ invalidateContentGeneration: true });
      return technicalPlanStore.loadTechnicalPlan();
    },
    importTenderDocument(filePaths) {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return technicalPlanStore.importTenderDocument(filePaths, {
        beforeCommit: async () => {
          await cancelTechnicalPlanTasks('招标文件已更新，后台任务已取消', { projectId });
          await openXmlHelperService.close?.();
        },
      });
    },
    removeTenderDocument(sourceId) {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return technicalPlanStore.removeTenderDocument(sourceId, {
        beforeCommit: async () => {
          await cancelTechnicalPlanTasks('招标文件已更新，后台任务已取消', { projectId });
          await openXmlHelperService.close?.();
        },
      });
    },
    importOriginalPlanDocument(filePaths) {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return technicalPlanStore.importOriginalPlanDocument(filePaths);
    },
    removeOriginalPlanDocument() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return technicalPlanStore.removeOriginalPlanDocument();
    },
    async resetRejectionCheck() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      await cancelRejectionCheckTasks('废标项检查已重置，后台任务已取消', { projectId });
      return rejectionCheckStore.clearRejectionCheck();
    },
    importRejectionCheckDocument(role, filePaths) {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      const documentRole = role === 'bid' ? 'bid' : 'tender';
      return rejectionCheckStore.importDocument(role, filePaths, {
        beforeCommit: () => cancelRejectionCheckTasks(
          documentRole === 'bid' ? '投标文件已更新，后台任务已取消' : '招标文件已更新，后台任务已取消',
          documentRole === 'bid' ? { projectId, taskTypes: ['rejection-check-run'] } : { projectId },
        ),
      });
    },
    importRejectionCheckTenderFromTechnicalPlan() {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      return rejectionCheckStore.importTenderFromTechnicalPlan({
        beforeCommit: () => cancelRejectionCheckTasks('招标文件已更新，后台任务已取消', { projectId }),
      });
    },
    removeRejectionCheckDocument(role, documentId) {
      const projectId = storeRegistry ? storeRegistry.getCurrentProjectId() : null;
      const projectStores = storeRegistry
        ? storeRegistry.resolveStores(projectId)
        : { technicalPlanStore, rejectionCheckStore, duplicateCheckStore };
      const technicalPlanStore = projectStores.technicalPlanStore;
      const rejectionCheckStore = projectStores.rejectionCheckStore;
      const duplicateCheckStore = projectStores.duplicateCheckStore;
      const documentRole = role === 'bid' ? 'bid' : 'tender';
      return rejectionCheckStore.removeDocument(role, documentId, {
        beforeCommit: () => cancelRejectionCheckTasks(
          documentRole === 'bid' ? '投标文件已更新，后台任务已取消' : '招标文件已更新，后台任务已取消',
          documentRole === 'bid' ? { projectId, taskTypes: ['rejection-check-run'] } : { projectId },
        ),
      });
    },
    async resetFeasibilityReport() {
      await cancelFeasibilityReportTasks('可研报告已重置，后台任务已取消');
      return feasibilityReportStore.clearFeasibilityReport();
    },
    importFeasibilitySourceDocuments(filePaths) {
      return feasibilityReportStore.importSourceDocuments(filePaths, {
        beforeCommit: () => cancelFeasibilityReportTasks('可研资料已更新，后台任务已取消'),
      });
    },
    removeFeasibilitySourceDocument(sourceId) {
      return feasibilityReportStore.removeSourceDocument(sourceId, {
        beforeCommit: () => cancelFeasibilityReportTasks('可研资料已更新，后台任务已取消'),
      });
    },
    async saveFeasibilityProjectInfo(projectInfo) {
      await cancelFeasibilityReportTasks('项目信息已更新，后台任务已取消');
      return feasibilityReportStore.saveProjectInfo(projectInfo, { clearDownstream: true });
    },
    async saveFeasibilityAnalysis(markdown) {
      await cancelFeasibilityReportTasks('资料分析已更新，后台任务已取消');
      return feasibilityReportStore.saveAnalysis(markdown);
    },
    async saveFeasibilityOutline(payload) {
      await cancelFeasibilityReportTasks('报告目录已更新，后台任务已取消');
      return feasibilityReportStore.saveOutline(payload);
    },
    async saveFeasibilityKeyParameters(markdown) {
      await cancelFeasibilityReportTasks('关键参数已更新，后台任务已取消');
      return feasibilityReportStore.saveKeyParameters(markdown);
    },
    getActiveTasks() {
      return Array.from(activeTasks.values());
    },
    // 当前活跃项目（registry 未接线前恒 null）；IPC 层项目化路由用（如 preview-content-word）
    getCurrentProjectId: () => resolveProjectId(),
    // 按项目恢复三域中断任务（T9 接线：打开/切换项目时调用；outline 等待选择场景会自动重启任务）
    recoverInterruptedTasksForProject,
  };
}

module.exports = { createTaskService };
