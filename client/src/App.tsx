import { useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import LicenseStatusPrompt from './app/LicenseStatusPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import UpdateNotifier from './app/UpdateNotifier';
import { useTextModelSetupRedirect } from './app/useTextModelSetupRedirect';
import AppShell from './components/AppShell';
import ProjectSwitcher from './features/projects/ProjectSwitcher';
import { useProjects } from './features/projects/useProjects';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import { InlineSpinner } from './shared/ui';
import type { SectionId } from './shared/types/navigation';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function isManagedWorkbenchSection(section: SectionId) {
  return section === 'technical-plan' || section === 'feasibility-report';
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const [developerMode, setDeveloperMode] = useState(false);
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);
  const { projects, activeProjectId, switching, loaded, switchTo } = useProjects();
  // 首启自动选中只做一次：用户主动“管理项目”置空 active 后不能回选第一个项目。
  const projectAutoSelectRef = useRef(false);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
    if (isManagedWorkbenchSection(activeSection)) return;
    void window.yibiao?.ui?.setCurrentView({ section: activeSection });
  }, [activeSection]);

  useEffect(() => {
    if (!developerMode && isDeveloperSection(activeSection)) {
      setActiveSection('bid-generation');
    }
  }, [activeSection, developerMode]);

  // 首次加载完成后：无激活项目且列表非空 → 自动选中第一个项目；列表为空则留在项目列表页（T12）。
  useEffect(() => {
    if (!loaded || projectAutoSelectRef.current) {
      return;
    }
    projectAutoSelectRef.current = true;
    if (activeProjectId === null && projects.length > 0) {
      switchTo(projects[0].id).catch((error) => console.warn('自动选中项目失败', error));
    }
  }, [loaded, activeProjectId, projects, switchTo]);

  const requestSectionChange = async (section: SectionId) => {
    if (section === activeSection) {
      return true;
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      setActiveSection(section);
    }
    return allowed;
  };
  const { settingsRequest, clearSettingsRequest } = useTextModelSetupRedirect(requestSectionChange);

  // 切换项目=离开当前 section 的同类守卫语义（如大纲排序未保存时先确认）。
  const requestProjectSwitch = async (projectId: string | null) => {
    if (projectId === activeProjectId) {
      return;
    }
    const allowed = await (leaveGuardRef.current?.('project-switch') ?? Promise.resolve(true));
    if (!allowed) {
      return;
    }
    try {
      await switchTo(projectId);
    } catch (error) {
      console.warn('切换项目失败', error);
    }
  };

  return (
    <>
      <GpuHardwareAccelerationPrompt />
      <RequiredOnlineServicesPrompt />
      <UpdateNotifier noticeEnabled />
      <LicenseStatusPrompt />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        projectSwitcher={(
          <ProjectSwitcher
            projects={projects}
            activeProjectId={activeProjectId}
            switching={switching}
            onSwitch={(projectId) => { void requestProjectSwitch(projectId); }}
          />
        )}
        onSectionChange={(section) => { void requestSectionChange(section); }}
      >
        {/* key=激活项目：切换时整树重挂载，三域页面全部重新 hydrate。 */}
        <AppRouter
          key={activeProjectId ?? 'none'}
          activeSection={activeSection}
          activeProjectId={activeProjectId}
          developerMode={developerMode}
          onDeveloperModeChange={setDeveloperMode}
          onSectionChange={(section) => { void requestSectionChange(section); }}
          registerLeaveGuard={(guard) => {
            leaveGuardRef.current = guard;
          }}
          settingsRequest={settingsRequest}
          onSettingsRequestHandled={clearSettingsRequest}
        />
      </AppShell>
      {switching && (
        <div className="project-switching-overlay" role="status" aria-live="polite">
          <InlineSpinner />
          <span>正在切换项目…</span>
        </div>
      )}
    </>
  );
}

export default App;
