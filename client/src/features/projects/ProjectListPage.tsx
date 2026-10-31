import { useRef, useState, type DragEvent } from 'react';
import type { ProjectInfo } from '../../shared/types/ipc';
import { AppDialog, EmptyState, InlineSpinner, isLibreOfficeRequiredMessage, useDocumentParseNotice, useToast } from '../../shared/ui';

/** 删除确认里展示的中文任务名，与主进程 taskService 的 taskDefinitions.label 保持一致。 */
const taskTypeLabels: Record<string, string> = {
  'bid-section-extraction': '多标段识别',
  'bid-analysis': '招标文件解析',
  'outline-generation': '目录生成',
  'outline-adjustment': '目录AI调整',
  'global-facts-generation': '全局事实设定',
  'global-facts-adjustment': '全局事实AI调整',
  'content-generation': '正文生成',
  'rejection-items-extraction': '无效与废标项解析',
  'rejection-check-run': '废标项检查',
  'duplicate-analysis': '标书查重分析',
  'feasibility-analysis': '可研项目资料分析',
  'feasibility-outline': '可研报告目录生成',
  'feasibility-outline-adjustment': '可研报告目录AI调整',
  'feasibility-parameters': '可研关键参数生成',
  'feasibility-content': '可研报告正文生成',
  'feasibility-human-writing': '可研自然化审校',
};

const renameNameMaxLength = 60;

/** last_active_at 是毫秒时间戳（projectRegistry 用 Date.now() 写入）。 */
function formatRelativeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '—';
  }
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) {
    return '刚刚';
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} 天前`;
  }
  return new Date(timestamp).toLocaleDateString();
}

export interface ProjectListPageProps {
  projects: ProjectInfo[];
  activeProjectId: string | null;
  switching: boolean;
  /** 点击卡片进入项目（列表页无工作台挂载，无需走 App 的离开守卫）。 */
  switchTo: (projectId: string | null) => Promise<void>;
  /** rename/remove 不发事件，操作完成后手动刷新列表与顶栏（T11 移交）。 */
  refresh: () => Promise<void>;
}

interface ProjectCardProps {
  project: ProjectInfo;
  active: boolean;
  busy: boolean;
  onOpen: (project: ProjectInfo) => void;
  onRename: (project: ProjectInfo) => void;
  onDelete: (project: ProjectInfo) => void;
}

function ProjectCard({ project, active, busy, onOpen, onRename, onDelete }: ProjectCardProps) {
  const hasError = Boolean(project.openError);
  const summary = project.gen_summary || project.current_step || '未开始';
  const canOpen = !hasError && !busy;
  return (
    <article className={`project-card${active ? ' is-active' : ''}${hasError ? ' is-error' : ''}`}>
      <button
        type="button"
        className="project-card-open"
        onClick={() => onOpen(project)}
        disabled={!canOpen}
        aria-label={hasError ? `项目 ${project.name} 打开失败` : `进入项目 ${project.name}`}
      >
        <span className="project-card-top">
          <strong className="project-card-name" title={project.name}>{project.name}</strong>
          {active ? <span className="project-card-badge">当前项目</span> : null}
        </span>
        {hasError ? (
          <span className="project-card-summary is-error" title={project.openError || ''}>打开失败：{project.openError}</span>
        ) : (
          <span className="project-card-summary">{summary}</span>
        )}
        <span className="project-card-meta">最近活跃 {formatRelativeTime(project.last_active_at)}</span>
      </button>
      <div className="project-card-actions">
        <button type="button" className="project-card-action" onClick={() => onRename(project)}>重命名</button>
        <button type="button" className="project-card-action is-danger" onClick={() => onDelete(project)}>删除</button>
      </div>
    </article>
  );
}

interface CreateProjectCardProps {
  busy: boolean;
  onClick: () => void;
  onDropFiles: (files: FileList) => void;
}

/** 新建入口卡片：点击走主进程原生文件选择，也支持把招标文件直接拖进来。 */
function CreateProjectCard({ busy, onClick, onDropFiles }: CreateProjectCardProps) {
  const [dragOver, setDragOver] = useState(false);
  // 计数进入/离开次数，避免拖过子元素时高亮闪烁（与 UploadRow 同款逻辑）
  const dragDepthRef = useRef(0);
  const droppable = !busy;

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!droppable || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!droppable || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!droppable) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragOver(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!droppable) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      onDropFiles(event.dataTransfer.files);
    }
  };

  return (
    <button
      type="button"
      className={`project-create-card${dragOver ? ' is-drag-over' : ''}`}
      onClick={onClick}
      disabled={busy}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {busy ? <><InlineSpinner /> 正在解析招标文件…</> : '＋ 新建项目（点击选择或拖入招标文件）'}
    </button>
  );
}

/** 项目列表页（多项目支持 T12）：卡片浏览 / 上传招标文件即新建 / 重命名 / 删除二次确认。 */
export function ProjectListPage({ projects, activeProjectId, switching, switchTo, refresh }: ProjectListPageProps) {
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const [creating, setCreating] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ProjectInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [deleteChecking, setDeleteChecking] = useState(false);
  const [deleteTaskLabels, setDeleteTaskLabels] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const busy = creating || switching;

  const notifyCreateFailure = (rawMessage?: string) => {
    const message = rawMessage || '招标文件导入失败';
    if (isLibreOfficeRequiredMessage(message)) {
      showDocumentParseNotice();
      return;
    }
    showToast(message, 'error');
  };

  /** 拿到招标文件绝对路径后建项目：主进程建项目（文件名即名）→ setCurrent → 同步导入解析。 */
  const createFromFiles = async (filePaths: string[]) => {
    if (!filePaths.length || creating) {
      return;
    }
    setCreating(true);
    try {
      const result = await window.yibiao?.projects.createFromTenderFile({ filePaths });
      if (!result) {
        return;
      }
      if (!result.importResult.success) {
        // 软失败（格式不支持/解析为空等）主进程不会回滚：清掉刚建的空项目，留在列表页。
        notifyCreateFailure(result.importResult.message);
        try {
          await window.yibiao?.projects.remove({ projectId: result.projectId });
        } catch (cleanupError) {
          console.warn('清理导入失败的项目出错', cleanupError);
        }
        await refresh();
        return;
      }
      showToast(`已创建项目「${result.name}」`, 'success');
      // createFromTenderFile 已 setCurrent；switchTo 幂等刷新即可进入新项目工作台。
      await switchTo(result.projectId);
    } catch (error) {
      // 异常路径主进程已回滚并置空 active。
      notifyCreateFailure(error instanceof Error ? error.message : '创建项目失败');
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const handleCreateClick = async () => {
    if (creating) {
      return;
    }
    const selector = window.yibiao?.file?.selectDuplicateCheckFiles;
    if (typeof selector !== 'function') {
      showToast('文件选择接口尚未加载，请重启应用后重试', 'error');
      return;
    }
    // 沿用主进程原生文件选择范式（Electron 41 渲染层 <input type="file"> 拿不到绝对路径）。
    const selection = await selector({ multiple: false });
    if (!selection.success) {
      if (selection.message !== '已取消选择') {
        showToast(selection.message, 'info');
      }
      return;
    }
    const filePaths = (selection.files || []).map((file) => file.file_path).filter(Boolean);
    await createFromFiles(filePaths);
  };

  const handleDropFiles = (files: FileList) => {
    // 拖拽导入用 preload 暴露的 getPathForFile 换绝对路径（与 DocumentAnalysisPage 同款范式）。
    const filePaths = Array.from(files)
      .map((file) => window.yibiao?.file?.getPathForFile(file) || '')
      .filter(Boolean);
    if (filePaths.length) {
      void createFromFiles(filePaths);
    }
  };

  const handleOpenProject = (project: ProjectInfo) => {
    if (busy || project.openError) {
      return;
    }
    switchTo(project.id).catch((error) => {
      showToast(error instanceof Error ? error.message : '进入项目失败', 'error');
    });
  };

  const openRenameDialog = (project: ProjectInfo) => {
    setRenameTarget(project);
    setRenameValue(project.name);
    setRenameError('');
  };

  const closeRenameDialog = () => {
    if (renaming) {
      return;
    }
    setRenameTarget(null);
  };

  const submitRename = async () => {
    if (!renameTarget || renaming) {
      return;
    }
    const name = renameValue.trim();
    if (!name) {
      setRenameError('项目名称不能为空');
      return;
    }
    if (name.length > renameNameMaxLength) {
      setRenameError(`项目名称不能超过 ${renameNameMaxLength} 个字符`);
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      await window.yibiao?.projects.rename({ projectId: renameTarget.id, name });
      showToast('项目名称已更新', 'success');
      setRenameTarget(null);
      // rename 不发事件：手动刷新，让列表卡片与顶栏 select 同步（T11 移交）。
      await refresh();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : '重命名失败');
    } finally {
      setRenaming(false);
    }
  };

  const openDeleteConfirm = (project: ProjectInfo) => {
    setDeleteTarget(project);
    setDeleteTaskLabels([]);
    setDeleteChecking(true);
    void (async () => {
      try {
        const activeTasks = await window.yibiao?.tasks.getActiveTasks() || [];
        setDeleteTaskLabels(activeTasks
          .filter((task) => task.project_id === project.id)
          .map((task) => taskTypeLabels[task.type] || task.type));
      } catch (error) {
        console.warn('读取运行中任务失败', error);
      } finally {
        setDeleteChecking(false);
      }
    })();
  };

  const closeDeleteConfirm = () => {
    if (deleting) {
      return;
    }
    setDeleteTarget(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting || deleteChecking) {
      return;
    }
    setDeleting(true);
    try {
      await window.yibiao?.projects.remove({ projectId: deleteTarget.id });
      showToast(`已删除项目「${deleteTarget.name}」`, 'success');
      setDeleteTarget(null);
      // 删除的是当前活跃项目时主进程已置空 active（onActiveChanged 自动刷新）；其余情况手动刷列表。
      await refresh();
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除项目失败', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const createButtonContent = creating
    ? <><InlineSpinner /> 正在创建…</>
    : '＋ 新建项目';

  return (
    <div className="project-list-page">
      <div className="project-list-head">
        <div>
          <span className="section-kicker">项目管理</span>
          <h2>项目列表</h2>
          <p>点击项目卡片进入工作台；选择或拖入招标文件即可新建项目。</p>
        </div>
        <button
          type="button"
          className="primary-action"
          onClick={() => { void handleCreateClick(); }}
          disabled={busy}
        >
          {createButtonContent}
        </button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          className="project-list-empty"
          title="还没有投标项目"
          hint="上传招标文件，开始第一个投标项目"
        >
          <button
            type="button"
            className="primary-action"
            onClick={() => { void handleCreateClick(); }}
            disabled={busy}
          >
            {createButtonContent}
          </button>
        </EmptyState>
      ) : (
        <div className="project-card-grid">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              active={project.id === activeProjectId}
              busy={busy}
              onOpen={handleOpenProject}
              onRename={openRenameDialog}
              onDelete={openDeleteConfirm}
            />
          ))}
          <CreateProjectCard busy={busy} onClick={() => { void handleCreateClick(); }} onDropFiles={handleDropFiles} />
        </div>
      )}

      <AppDialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => { if (!open) closeRenameDialog(); }}
        kicker="项目管理"
        title="重命名项目"
        cardClassName="project-rename-card"
        preventClose={renaming}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={closeRenameDialog} disabled={renaming}>取消</button>
            <button type="submit" form="project-rename-form" className="primary-action" disabled={renaming}>
              {renaming && <InlineSpinner />}{renaming ? '正在保存…' : '保存'}
            </button>
          </>
        )}
      >
        <form
          id="project-rename-form"
          className="project-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <label htmlFor="project-rename-input">项目名称</label>
          <input
            id="project-rename-input"
            value={renameValue}
            disabled={renaming}
            autoComplete="off"
            spellCheck={false}
            maxLength={renameNameMaxLength}
            aria-invalid={Boolean(renameError)}
            aria-describedby={renameError ? 'project-rename-error' : undefined}
            onChange={(event) => {
              setRenameValue(event.target.value);
              setRenameError('');
            }}
          />
          {renameError ? <p id="project-rename-error" role="alert">{renameError}</p> : null}
        </form>
      </AppDialog>

      <AppDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) closeDeleteConfirm(); }}
        kicker="项目管理"
        title={`确定删除项目「${deleteTarget?.name ?? ''}」吗？`}
        description="该项目全部数据将被删除，不可恢复。"
        cardClassName="project-delete-card"
        preventClose={deleting}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={closeDeleteConfirm} disabled={deleting}>取消</button>
            <button
              type="button"
              className="danger-action"
              onClick={() => { void confirmDelete(); }}
              disabled={deleting || deleteChecking}
            >
              {deleting ? '正在删除…' : '确认删除'}
            </button>
          </>
        )}
      >
        {deleteChecking ? (
          <p className="project-delete-tasks is-loading"><InlineSpinner /> 正在检查该项目运行中的任务…</p>
        ) : deleteTaskLabels.length > 0 ? (
          <div className="project-delete-tasks" role="alert">
            <strong>以下任务将被终止：</strong>
            <ul>
              {deleteTaskLabels.map((label, index) => (
                <li key={`${label}-${index}`}>{label}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </AppDialog>
    </div>
  );
}

export default ProjectListPage;
