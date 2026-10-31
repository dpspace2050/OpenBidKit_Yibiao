import { useEffect, useMemo, useState } from 'react';
import type { ProjectInfo, TaskEventTask } from '../../shared/types/ipc';

interface ProjectRunningBadgeProps {
  projects: ProjectInfo[];
  activeProjectId: string | null;
  /** 守卫确认后切换项目（与顶栏切换器同一入口）。 */
  onSwitch: (projectId: string) => void;
}

// 运行中状态集合与 main 侧 taskService.isActiveTaskStatus 保持一致（running/pausing）。
function isRunningTaskStatus(status: unknown) {
  return status === 'running' || status === 'pausing';
}

function mergeRunningTask(prev: Record<string, string[]>, task: TaskEventTask | undefined) {
  const projectId = task?.project_id;
  const taskId = task?.task_id;
  if (!projectId || !taskId) return prev; // 全域任务（feasibility 等）不进项目角标
  const ids = new Set(prev[projectId] || []);
  const before = ids.size;
  if (isRunningTaskStatus(task?.status)) ids.add(taskId);
  else ids.delete(taskId);
  if (ids.size === before) return prev; // 进度类事件不改运行集合，避免无谓重渲染
  const next = { ...prev };
  if (ids.size) next[projectId] = [...ids];
  else delete next[projectId];
  return next;
}

/**
 * 后台项目运行角标（多项目支持 T13）：独立订阅任务事件，按 project_id 分组统计运行中任务。
 * 只提示“非当前项目”的运行状态；点击项目名即切换过去查看。
 */
export default function ProjectRunningBadge({ projects, activeProjectId, onSwitch }: ProjectRunningBadgeProps) {
  const [runningTasks, setRunningTasks] = useState<Record<string, string[]>>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!window.yibiao?.tasks) {
      return;
    }
    // 启动种子：恢复中的任务（上次中断补跑）不会立即发事件，先拉一次运行中列表。
    void window.yibiao.tasks.getActiveTasks()
      .then((tasks) => {
        setRunningTasks((Array.isArray(tasks) ? tasks : []).reduce(mergeRunningTask, {}));
      })
      .catch(() => undefined);
    const unsubscribe = window.yibiao.tasks.onTaskEvent((event) => {
      setRunningTasks((prev) => mergeRunningTask(prev, event.task as TaskEventTask | undefined));
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const backgroundRunningProjects = useMemo(
    () => projects.filter((project) => project.id !== activeProjectId && (runningTasks[project.id]?.length || 0) > 0),
    [activeProjectId, projects, runningTasks],
  );

  if (backgroundRunningProjects.length === 0) {
    return null;
  }

  return (
    <div className={`project-running-badge${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="project-running-badge-toggle"
        aria-expanded={open}
        title="其他项目仍有后台任务运行中，点击查看"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="project-running-badge-pulse" aria-hidden="true">⚡</span>
        {backgroundRunningProjects.length} 个项目运行中
      </button>
      <div className="project-running-badge-menu" role="menu" aria-label="运行中的后台项目">
        {backgroundRunningProjects.map((project) => (
          <button
            type="button"
            role="menuitem"
            key={project.id}
            onClick={() => {
              setOpen(false);
              onSwitch(project.id);
            }}
          >
            <span>{project.name}</span>
            <small>{runningTasks[project.id]?.length || 0} 个任务</small>
          </button>
        ))}
      </div>
    </div>
  );
}
