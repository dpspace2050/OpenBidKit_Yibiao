import { useCallback, useEffect, useState } from 'react';
import type { ProjectInfo } from '../../shared/types/ipc';

/** 多项目支持（T11）：项目列表 + 激活项目，跟随 onActiveChanged 自动刷新。 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  /** 首次 list 是否已返回，用于区分“还没加载”和“确实没有激活项目”。 */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.yibiao?.projects.list();
    if (result) {
      setProjects(result.projects);
      setActiveProjectId(result.activeProjectId);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    return window.yibiao?.projects.onActiveChanged(() => { void refresh(); });
  }, [refresh]);

  const switchTo = useCallback(async (projectId: string | null) => {
    setSwitching(true);
    try {
      await window.yibiao?.projects.setActive(projectId);
      await refresh();
    } finally {
      setSwitching(false);
    }
  }, [refresh]);

  return { projects, activeProjectId, switching, loaded, refresh, switchTo };
}
