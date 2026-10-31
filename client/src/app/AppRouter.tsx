import type { SectionId } from '../shared/types/navigation';
import type { SettingsPageRequest } from '../features/settings/types';
import { getAppMenuItemById } from './menuConfig';
import BidOpportunityPage from '../features/bid-opportunity/pages/BidOpportunityPage';
import ContentExpansionReplaceTestPage from '../features/developer/pages/ContentExpansionReplaceTestPage';
import ContentLayoutBudgetTestPage from '../features/developer/pages/ContentLayoutBudgetTestPage';
import DeveloperDemoPage, { isDeveloperDemoSection } from '../features/developer/pages/DeveloperDemoPage';
import DeveloperMultimodalTestPage from '../features/developer/pages/DeveloperMultimodalTestPage';
import AgentTestPage from '../features/developer/pages/AgentTestPage';
import DeveloperTestPage from '../features/developer/pages/DeveloperTestPage';
import MyTemplatesPage from '../features/export-format/pages/MyTemplatesPage';
import DuplicateCheckPage from '../features/duplicate-check/pages/DuplicateCheckPage';
import CredentialLibraryPage from '../features/credential-library/pages/CredentialLibraryPage';
import KnowledgeBasePage from '../features/knowledge-base/pages/KnowledgeBasePage';
import { ProjectListPage, type ProjectListPageProps } from '../features/projects/ProjectListPage';
import RejectionCheckPage from '../features/rejection-check/pages/RejectionCheckPage';
import ResourcesPage from '../features/resources/pages/ResourcesPage';
import PluginsPage from '../features/plugins/pages/PluginsPage';
import SettingsPage from '../features/settings/pages/SettingsPage';
import TechnicalPlanHome from '../features/technical-plan/pages/TechnicalPlanHome';
import FeasibilityReportHome from '../features/feasibility-report/pages/FeasibilityReportHome';
import { EmptyState } from '../shared/ui';
import SecondaryMenuPage from '../shared/ui/SecondaryMenuPage';

interface AppRouterProps {
  activeSection: SectionId;
  /** 多项目支持（T11）：当前激活项目；null 时三域页面不挂载（改走列表页/空态分流）。 */
  activeProjectId: string | null;
  developerMode: boolean;
  onDeveloperModeChange: (developerMode: boolean) => void;
  onSectionChange: (section: SectionId) => void;
  registerLeaveGuard?: (guard: ((nextSection?: string) => Promise<boolean>) | null) => void;
  settingsRequest?: SettingsPageRequest | null;
  onSettingsRequestHandled?: () => void;
  /** 多项目支持（T12）：App 持有的项目域状态与操作，下传项目列表页使用。 */
  projectList: ProjectListPageProps;
}

function AppRouter({ activeSection, activeProjectId, developerMode, onDeveloperModeChange, onSectionChange, registerLeaveGuard, settingsRequest, onSettingsRequestHandled, projectList }: AppRouterProps) {
  const activeMenuItem = getAppMenuItemById(activeSection, developerMode);

  if (activeMenuItem?.children?.length) {
    return <SecondaryMenuPage menuItem={activeMenuItem} onNavigate={onSectionChange} />;
  }

  if (isDeveloperDemoSection(activeSection)) {
    return <DeveloperDemoPage sectionId={activeSection} />;
  }

  switch (activeSection) {
    case 'technical-plan':
      // 无激活项目时不挂载 TechnicalPlanHome（挂载即 loadState 会抛“尚未选择项目”），改走项目列表页。
      return activeProjectId !== null
        ? <TechnicalPlanHome registerLeaveGuard={registerLeaveGuard} />
        : <ProjectListPage {...projectList} />;
    case 'feasibility-report':
      return <FeasibilityReportHome registerLeaveGuard={registerLeaveGuard} />;
    case 'document-knowledge-base':
      return <KnowledgeBasePage />;
    case 'credential-library':
      return <CredentialLibraryPage developerMode={developerMode} />;
    case 'resources':
      return <ResourcesPage />;
    case 'plugin-manager':
      return <PluginsPage />;
    case 'duplicate-check':
      return activeProjectId !== null
        ? <DuplicateCheckPage />
        : (
          <div className="project-required-page">
            <EmptyState title="请先选择项目" hint="标书查重工作区属于具体项目，请先在顶部切换或新建项目。" />
          </div>
        );
    case 'rejection-check':
      return activeProjectId !== null
        ? <RejectionCheckPage />
        : (
          <div className="project-required-page">
            <EmptyState title="请先选择项目" hint="废标检查工作区属于具体项目，请先在顶部切换或新建项目。" />
          </div>
        );
    case 'template-settings':
      return <MyTemplatesPage />;
    case 'bid-opportunity':
      return <BidOpportunityPage />;
    case 'developer-test':
      return null;
    case 'developer-json-test':
      return <DeveloperTestPage />;
    case 'developer-multimodal-test':
      return <DeveloperMultimodalTestPage />;
    case 'developer-expansion-replace-test':
      return <ContentExpansionReplaceTestPage />;
    case 'developer-layout-budget-test':
      return <ContentLayoutBudgetTestPage />;
    case 'developer-agent-test':
      return <AgentTestPage />;
    case 'settings':
      return <SettingsPage onDeveloperModeChange={onDeveloperModeChange} request={settingsRequest} onRequestHandled={onSettingsRequestHandled} />;
    default:
      return null;
  }
}

export default AppRouter;
