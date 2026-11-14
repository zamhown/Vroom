import { t as appText } from './i18n';
import type { Query } from './types';
export type TabKind =
  | 'library'
  | 'film'
  | 'player'
  | 'libraries'
  | 'tags'
  | 'duplicates'
  | 'views'
  | 'jobs'
  | 'settings'
  | 'agent'
  | 'export';
export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  dirty?: boolean;
  params?: {
    libraryId?: string;
    filmId?: string;
    partId?: string;
    viewId?: string;
    query?: Query;
    queue?: string[];
    sourceKey?: string;
    sourceTitle?: string;
    independent?: boolean;
    /** Changing value asks the film list to open the shared “add media” flow. */
    openImport?: number;
  };
  state: Record<string, unknown>;
}
export interface Workspace {
  version: 3;
  tabs: WorkspaceTab[];
  activeId: string;
}
export type WorkspaceGroupKind = 'film' | 'library' | 'view';
export interface WorkspaceGroup {
  key: string;
  title: string;
  tabs: WorkspaceTab[];
  grouped: boolean;
  source: WorkspaceTab;
}
export const workspaceGroupKind = (sourceKey: string): WorkspaceGroupKind | undefined =>
  /^(film|library|view):.+$/.exec(sourceKey)?.[1] as WorkspaceGroupKind | undefined;
export type DropEdge = 'before' | 'after';
export const isWorkspaceManager = (tab: WorkspaceTab) =>
  (tab.kind === 'libraries' && tab.id === 'libraries') || (tab.kind === 'views' && tab.id === 'views');
const normalizeManager = (tab: WorkspaceTab): WorkspaceTab =>
  isWorkspaceManager(tab)
    ? {
        ...tab,
        title: tab.kind === 'libraries' ? appText('workspace.manageLibraries') : appText('workspace.manageSmartLists'),
      }
    : tab;
export function workspaceTabTitle(tab: WorkspaceTab) {
  if (tab.id === 'home') return appText('workspace.allFilms');
  if (isWorkspaceManager(tab)) return normalizeManager(tab).title;
  if (tab.kind === 'libraries' && !tab.params?.libraryId) return appText('workspace.newLibrary');
  if (tab.id === tab.kind) return workspacePageLabel(tab);
  return tab.title;
}
export const workspacePageLabel = (tab: WorkspaceTab) =>
  ({
    film: appText('workspace.filmDetails'),
    player: tab.params?.queue?.length ? appText('workspace.playlist') : appText('workspace.playFilm'),
    library: appText('workspace.filmList'),
    libraries: tab.params?.libraryId ? appText('workspace.editLibrary') : appText('workspace.newLibrary'),
    views: tab.params?.viewId ? appText('workspace.editSmartList') : appText('workspace.newSmartList'),
    tags: appText('workspace.tagConfiguration'),
    configuration: appText('workspace.configurationManagement'),
    duplicates: appText('workspace.duplicates'),
    jobs: appText('workspace.backgroundTasks'),
    settings: appText('workspace.settings'),
    agent: appText('workspace.localAssistant'),
    export: appText('workspace.convertAndExport'),
  })[tab.kind];
// Identity belongs to the source, not the page title or the currently playing queue item.
export function workspaceSourceKey(tab: WorkspaceTab): string {
  // Manager forms can retain a selected entity without becoming that entity's editor tab.
  if (isWorkspaceManager(tab)) return 'tab:' + tab.id;
  if (tab.params?.filmId && (tab.kind === 'film' || (tab.kind === 'player' && !tab.params.queue?.length)))
    return 'film:' + tab.params.filmId;
  if (tab.params?.viewId && (tab.kind === 'library' || tab.kind === 'views')) return 'view:' + tab.params.viewId;
  if (tab.params?.libraryId && (tab.kind === 'library' || tab.kind === 'libraries'))
    return 'library:' + tab.params.libraryId;
  const sourceKey = tab.params?.sourceKey;
  // Only concrete entities own groups. Generic queries, copies and temporary queues remain standalone.
  return sourceKey && (tab.kind === 'library' || tab.kind === 'player') && workspaceGroupKind(sourceKey)
    ? sourceKey
    : 'tab:' + tab.id;
}
const tabOrder: Record<TabKind, number> = {
  library: 0,
  film: 0,
  libraries: 1,
  views: 1,
  player: 2,
  tags: 0,
  duplicates: 0,
  jobs: 0,
  settings: 0,
  agent: 0,
  export: 3,
};
export function workspaceGroups(tabs: WorkspaceTab[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceTab[]>();
  for (const tab of tabs) {
    const key = workspaceSourceKey(tab);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(tab);
  }
  return [...groups].map(([key, members]) => {
    // Stable sorting also preserves creation order for multiple copies of one page type.
    members.sort((a, b) => tabOrder[a.kind] - tabOrder[b.kind]);
    const source = members.find(tab => tab.kind === 'film' || tab.kind === 'library') ?? members[0];
    const grouped = Boolean(workspaceGroupKind(key));
    const title = grouped ? source.params?.sourceTitle || source.title : normalizeManager(source).title;
    return { key, title, tabs: members, grouped, source };
  });
}
const orderedTabs = (tabs: WorkspaceTab[]) => workspaceGroups(tabs).flatMap(group => group.tabs);
export const initialWorkspace = (): Workspace => ({
  version: 3,
  tabs: [{ id: 'home', kind: 'library', title: appText('workspace.allFilms'), state: {} }],
  activeId: 'home',
});
function canonicalExport(tab: WorkspaceTab): WorkspaceTab {
  const { filmId, partId, ...params } = tab.params ?? {};
  const sources = (tab.state.sources ?? []) as { filmId?: string }[];
  return {
    ...tab,
    id: 'export',
    params,
    state: {
      ...tab.state,
      pendingParts: {
        ...((tab.state.pendingParts as Record<string, string>) ?? {}),
        ...(filmId && partId ? { [filmId]: partId } : {}),
      },
      pendingFilmIds: [
        ...new Set([
          ...((tab.state.pendingFilmIds as string[]) ?? []),
          ...(filmId && !sources.some(s => s.filmId === filmId) ? [filmId] : []),
        ]),
      ],
    },
  };
}
export type WorkspaceAction =
  | { type: 'open'; tab: WorkspaceTab }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'patchState'; id: string; change(state: Record<string, unknown>): Record<string, unknown>; dirty?: boolean }
  | { type: 'update'; id: string; change: Partial<WorkspaceTab> }
  | { type: 'restore'; workspace: Workspace }
  | { type: 'moveGroup'; sourceKey: string; targetKey: string; edge: DropEdge };
export function workspaceReducer(workspace: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'patchState':
      return {
        ...workspace,
        tabs: workspace.tabs.map(tab =>
          tab.id === action.id
            ? {
                ...tab,
                state: action.change(tab.state),
                ...(action.dirty === undefined ? {} : { dirty: action.dirty }),
              }
            : tab,
        ),
      };
    case 'restore':
      return validateWorkspace(action.workspace);
    case 'open': {
      if (action.tab.kind === 'export') {
        const existing = workspace.tabs.find(t => t.kind === 'export');
        if (existing) {
          const incoming = canonicalExport(action.tab);
          if (incoming.state.replaceSources)
            return {
              ...workspace,
              activeId: 'export',
              tabs: workspace.tabs.map(t =>
                t === existing
                  ? {
                      ...t,
                      state: {
                        ...t.state,
                        sources: [],
                        pendingFilmIds: incoming.state.pendingFilmIds,
                        pendingParts: incoming.state.pendingParts,
                        replaceSources: false,
                      },
                    }
                  : t,
              ),
            };
          const loaded = new Set(((existing.state.sources ?? []) as { filmId?: string }[]).map(s => s.filmId));
          const pending = [
            ...new Set([
              ...((existing.state.pendingFilmIds as string[]) ?? []),
              ...(incoming.state.pendingFilmIds as string[]),
            ]),
          ].filter(id => !loaded.has(id));
          return {
            ...workspace,
            activeId: 'export',
            tabs: workspace.tabs.map(t =>
              t === existing
                ? {
                    ...t,
                    state: {
                      ...t.state,
                      pendingFilmIds: pending,
                      pendingParts: {
                        ...((t.state.pendingParts as Record<string, string>) ?? {}),
                        ...((incoming.state.pendingParts as Record<string, string>) ?? {}),
                      },
                    },
                  }
                : t,
            ),
          };
        }
        return {
          ...workspace,
          activeId: 'export',
          tabs: orderedTabs([...workspace.tabs, canonicalExport(action.tab)]),
        };
      }
      const tab = normalizeManager(action.tab);
      const existing =
        workspace.tabs.find(t => t.id === tab.id) ??
        workspace.tabs.find(
          t =>
            !isWorkspaceManager(tab) &&
            !isWorkspaceManager(t) &&
            ['libraries', 'views'].includes(tab.kind) &&
            t.kind === tab.kind &&
            Boolean(tab.params?.libraryId || tab.params?.viewId) &&
            workspaceSourceKey(t) === workspaceSourceKey(tab),
        );
      return {
        ...workspace,
        activeId: existing?.id ?? tab.id,
        tabs: existing ? workspace.tabs : orderedTabs([...workspace.tabs, tab]),
      };
    }
    case 'activate':
      return workspace.tabs.some(t => t.id === action.id) ? { ...workspace, activeId: action.id } : workspace;
    case 'update': {
      const previous = workspace.tabs.find(tab => tab.id === action.id);
      if (!previous) return workspace;
      const updated = normalizeManager({ ...previous, ...action.change, id: previous.id });
      const oldKey = workspaceSourceKey(previous),
        newKey = workspaceSourceKey(updated);
      const tabs = workspace.tabs.map(tab =>
        tab.id === action.id
          ? updated
          : oldKey !== newKey && tab.params?.sourceKey === oldKey
            ? { ...tab, params: { ...tab.params, sourceKey: newKey } }
            : tab,
      );
      return { ...workspace, tabs: action.change.params || action.change.kind ? orderedTabs(tabs) : tabs };
    }
    case 'moveGroup': {
      if (action.sourceKey === action.targetKey) return workspace;
      const groups = workspaceGroups(workspace.tabs);
      const source = groups.find(group => group.key === action.sourceKey);
      if (!source || !groups.some(group => group.key === action.targetKey)) return workspace;
      const remaining = groups.filter(group => group !== source);
      const targetIndex = remaining.findIndex(group => group.key === action.targetKey);
      remaining.splice(targetIndex + (action.edge === 'after' ? 1 : 0), 0, source);
      return { ...workspace, tabs: remaining.flatMap(group => group.tabs) };
    }
    case 'close': {
      if (action.id === 'home') return workspace;
      const index = workspace.tabs.findIndex(t => t.id === action.id);
      if (index < 0) return workspace;
      const tabs = workspace.tabs.filter(t => t.id !== action.id);
      const sibling = tabs.find(tab => workspaceSourceKey(tab) === workspaceSourceKey(workspace.tabs[index]));
      return {
        ...workspace,
        tabs,
        activeId:
          workspace.activeId === action.id
            ? (sibling?.id ?? tabs[Math.max(0, index - 1)]?.id ?? 'home')
            : workspace.activeId,
      };
    }
  }
}
export function validateWorkspace(value: Workspace): Workspace {
  const kinds = Object.keys(tabOrder) as TabKind[];
  if (!value || value.version !== 3 || !Array.isArray(value.tabs)) return initialWorkspace();
  const seen = new Set<string>();
  const tabs = value.tabs
    .filter(t => t && typeof t.id === 'string' && !seen.has(t.id) && seen.add(t.id) && kinds.includes(t.kind))
    .map(t => normalizeManager({ ...t, state: t.state && typeof t.state === 'object' ? t.state : {} }));
  if (!tabs.some(t => t.id === 'home')) tabs.unshift(initialWorkspace().tabs[0]);
  return {
    version: 3,
    tabs: orderedTabs(tabs),
    activeId: tabs.some(t => t.id === value.activeId) ? value.activeId : 'home',
  };
}

// Large or reproducible tab state is kept in memory only; the persisted workspace stays small.
const ephemeralState = new Set(['subtitleText', 'queryDraft', 'scroll']);
export function persistableWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    tabs: workspace.tabs.map(tab => ({
      ...tab,
      state: Object.fromEntries(Object.entries(tab.state).filter(([key]) => !ephemeralState.has(key))),
    })),
  };
}

/** Every "new library" entry opens the same add-media flow on the all-films tab. */
export function requestImport(app: {
  workspace: Workspace;
  update(id: string, change: Partial<WorkspaceTab>): void;
  activate(id: string): void;
}) {
  const home = app.workspace.tabs.find(tab => tab.id === 'home');
  app.update('home', { params: { ...home?.params, openImport: Date.now() } });
  app.activate('home');
}
