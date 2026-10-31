import type { ProjectInfo } from '../../shared/types/ipc';

const MANAGE_VALUE = '__manage__';
const CREATE_VALUE = '__create__';

interface ProjectSwitcherProps {
  projects: ProjectInfo[];
  activeProjectId: string | null;
  switching: boolean;
  /** 守卫确认后切换项目；null 表示回到项目列表页（管理/新建入口）。 */
  onSwitch: (projectId: string | null) => void;
}

/** 顶栏项目切换器：原生 select，含“管理项目/新建项目”入口（多项目支持 T11）。 */
export default function ProjectSwitcher({ projects, activeProjectId, switching, onSwitch }: ProjectSwitcherProps) {
  // 激活项目已不在列表中（例如刚被删除）时回退到占位项，避免受控 select 值失配。
  const currentValue = activeProjectId !== null && projects.some((project) => project.id === activeProjectId)
    ? activeProjectId
    : '';

  const handleChange = (value: string) => {
    if (value === MANAGE_VALUE || value === CREATE_VALUE) {
      onSwitch(null);
      return;
    }
    if (value) {
      onSwitch(value);
    }
  };

  return (
    <div className="project-switcher">
      <label className="project-switcher-label" htmlFor="project-switcher-select">当前项目</label>
      <select
        id="project-switcher-select"
        className="project-switcher-select"
        value={currentValue}
        disabled={switching}
        onChange={(event) => handleChange(event.target.value)}
      >
        {currentValue === '' && <option value="">未选择项目</option>}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
        <option value={MANAGE_VALUE}>管理项目…</option>
        <option value={CREATE_VALUE}>＋ 新建项目</option>
      </select>
    </div>
  );
}
