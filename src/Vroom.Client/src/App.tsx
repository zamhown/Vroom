import { TabBoundary } from './TabBoundary';
import { ContextMenuHost } from './ContextMenu';
import { t as appText } from './i18n';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Tabs, TabPanel } from 'react-aria-components';
import { WorkspaceTabBar } from './WorkspaceTabBar';
import { ActivitySidebar } from './components/ActivitySidebar';
import { WorkspaceNavigation, type NavigationItem, type NavigationSection } from './WorkspaceNavigation';
import { WorkspaceNavigationIcon } from './workspace-icons';
import { Spin } from './ui';
import { IconBookmark, IconFolder, IconPlus, IconTag, IconVideo } from './icons';
import { AppProvider, useApp } from './context';
import { defaultQuery } from './types';
import { useTagNavigation } from './tagging/Navigation';
import { isWorkspaceManager, requestImport, type TabKind, type WorkspaceTab } from './workspace';
import { LibraryPage } from './pages/LibraryPage';
import { FilmPage } from './pages/FilmPage';
import { AgentPage } from './pages/AgentPage';
import {
  DuplicatesPage,
  JobsPage,
  LibrariesPage,
  LibraryEditorPage,
  SettingsPage,
  TagsPage,
  ViewsPage,
} from './pages/ManagementPages';
const PlayerPage = lazy(() => import('./pages/EnginePlayerPage').then(m => ({ default: m.EnginePlayerPage })));
const ExportPage = lazy(() => import('./pages/ExportPage').then(m => ({ default: m.ExportPage })));
function TabContent({ tab }: { tab: WorkspaceTab }) {
  switch (tab.kind) {
    case 'library':
      return <LibraryPage tab={tab} />;
    case 'film':
      return <FilmPage tab={tab} />;
    case 'player':
      return (
        <Suspense
          fallback={
            <div className="boot-loading">
              <Spin />
            </div>
          }
        >
          <PlayerPage tab={tab} />
        </Suspense>
      );
    case 'libraries':
      return isWorkspaceManager(tab) ? <LibrariesPage tab={tab} /> : <LibraryEditorPage tab={tab} />;
    case 'tags':
      return <TagsPage tab={tab} />;
    case 'duplicates':
      return <DuplicatesPage tab={tab} />;
    case 'views':
      return <ViewsPage tab={tab} />;
    case 'jobs':
      return <JobsPage tab={tab} />;
    case 'settings':
      return <SettingsPage tab={tab} />;
    case 'agent':
      return <AgentPage tab={tab} />;
    case 'export':
      return (
        <Suspense fallback={<Spin />}>
          <ExportPage tab={tab} />
        </Suspense>
      );
  }
}
function WorkspaceShell() {
  const app = useApp();
  const current = app.workspace.tabs.find(t => t.id === app.workspace.activeId)!;
  const tagNavigation = useTagNavigation();
  // Desktop tab shortcuts: Ctrl/Cmd+W closes, Ctrl+Tab / Ctrl+Shift+Tab cycles.
  const shortcuts = useRef({ app, current });
  shortcuts.current = { app, current };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const { app, current } = shortcuts.current;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey && event.key.toLowerCase() === 'w' && current.id !== 'home') {
        event.preventDefault();
        app.close(current.id);
      } else if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        const tabs = app.workspace.tabs;
        const index = tabs.findIndex(t => t.id === current.id);
        app.activate(tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  const visited = useRef(new Set<string>());
  visited.current.add(current.id);
  // Reordering the tab strip must not detach video elements or other live page DOM.
  const panelOrder = useRef<string[]>([]);
  const tabsById = new Map(app.workspace.tabs.map(tab => [tab.id, tab]));
  const previousIds = new Set(panelOrder.current);
  panelOrder.current = [
    ...panelOrder.current.filter(id => tabsById.has(id)),
    ...app.workspace.tabs.filter(tab => !previousIds.has(tab.id)).map(tab => tab.id),
  ];
  const open = (kind: TabKind, title: string) => app.open({ id: kind, kind, title });
  const nav = (
    id: string,
    label: string,
    kind: TabKind,
    onPress: () => void,
    selected = current.id === id,
    count?: number,
  ): NavigationItem => ({ id, label, icon: <WorkspaceNavigationIcon tab={{ id, kind }} />, onPress, selected, count });
  const sections: NavigationSection[] = [
    {
      id: 'browse',
      label: appText('App.browseFilms'),
      icon: <IconVideo />,
      items: [
        nav('home', appText('App.allFilms'), 'library', () => app.activate('home'), current.id === 'home'),
        ...(['continue-watching', 'recently-added'] as const).map(scope =>
          nav('scope:' + scope, appText('App.scope.' + scope), 'library', () =>
            app.open({
              id: 'scope:' + scope,
              kind: 'library',
              title: appText('App.scope.' + scope),
              params: { query: { ...defaultQuery(), scope } },
            }),
          ),
        ),
        ...tagNavigation,
      ],
    },
    {
      id: 'libraries',
      label: appText('App.libraries'),
      icon: <IconFolder />,
      items: app.data.libraries.map(l =>
        nav('library:' + l.id, l.name, 'library', () =>
          app.open({ id: 'library:' + l.id, kind: 'library', title: l.name, params: { libraryId: l.id } }),
        ),
      ),
      actions: [
        {
          id: 'add-library',
          label: appText('ManagementPages.newLibrary'),
          icon: <IconPlus />,
          onPress: () => requestImport(app),
        },
        nav('libraries', appText('App.manageLibraries'), 'libraries', () =>
          open('libraries', appText('App.manageLibraries')),
        ),
      ],
    },
    {
      id: 'views',
      label: appText('App.smartLists'),
      icon: <IconBookmark />,
      items: app.data.views.map(v =>
        nav('view:' + v.id, v.name, 'views', () =>
          app.open({ id: 'view:' + v.id, kind: 'library', title: v.name, params: { viewId: v.id, query: v.query } }),
        ),
      ),
      actions: [
        nav('views', appText('App.manageSmartLists'), 'views', () => open('views', appText('App.manageSmartLists'))),
      ],
    },
    {
      id: 'organize',
      label: appText('App.organize'),
      icon: <IconTag />,
      items: [
        nav(
          'duplicates',
          appText('App.duplicates'),
          'duplicates',
          () => open('duplicates', appText('App.duplicates')),
          current.kind === 'duplicates',
        ),
        // Host features are registered by the host; tag packages only contribute field navigation.
        nav(
          'tags',
          appText('App.feature.tags'),
          'tags',
          () => open('tags', appText('App.feature.tags')),
          current.kind === 'tags',
        ),
      ],
    },
  ];
  return (
    <div className="app-shell">
      <ContextMenuHost
        fallback={[
          { id: 'home', label: appText('App.allFilms'), run: () => app.activate('home') },
          {
            id: 'jobs',
            label: appText('App.backgroundTasks'),
            run: () => open('jobs', appText('App.backgroundTasks')),
          },
          { id: 'settings', label: appText('App.settings'), run: () => open('settings', appText('App.settings')) },
          {
            id: 'close',
            label: appText('WorkspaceTabBar.closeCurrentTab'),
            disabled: current.id === 'home',
            run: () => app.close(current.id),
          },
        ]}
      />
      <WorkspaceNavigation
        sections={sections}
        tools={[
          nav(
            'export',
            appText('App.feature.export'),
            'export',
            () => open('export', appText('App.feature.export')),
            current.kind === 'export',
          ),
          nav(
            'agent',
            appText('App.localAssistant'),
            'agent',
            () => open('agent', appText('App.localAssistant')),
            current.kind === 'agent',
          ),
          nav(
            'jobs',
            appText('App.backgroundTasks'),
            'jobs',
            () => open('jobs', appText('App.backgroundTasks')),
            current.kind === 'jobs',
            app.jobs.active || undefined,
          ),
          nav(
            'settings',
            appText('App.settings'),
            'settings',
            () => open('settings', appText('App.settings')),
            current.kind === 'settings',
          ),
        ]}
      />
      <main className="workspace-main">
        <Tabs selectedKey={current.id} onSelectionChange={id => app.activate(String(id))} className="workspace-tabs">
          <WorkspaceTabBar />
          <div className="workspace-body">
            <div className="workspace-panels">
              {panelOrder.current.map(id => {
                const tab = tabsById.get(id)!;
                return (
                  <TabPanel id={tab.id} key={tab.id} shouldForceMount className="workspace-panel">
                    {visited.current.has(tab.id) && (
                      <TabBoundary tabId={tab.id}>
                        <TabContent tab={tab} />
                      </TabBoundary>
                    )}
                  </TabPanel>
                );
              })}
            </div>
            <ActivitySidebar tab={current} />
          </div>
        </Tabs>
      </main>
    </div>
  );
}
export default function App() {
  return (
    <AppProvider>
      <WorkspaceShell />
    </AppProvider>
  );
}
