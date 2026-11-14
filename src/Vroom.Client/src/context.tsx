import { reportError } from './diagnostics';
import capabilities from '../../../resources/tagging/host-capabilities.json';
import { t as appText } from './i18n';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  getLocale,
  languageVersion,
  subscribeLanguage,
  setLanguage,
  setInstalledPacks,
  installedLanguages,
  defaultLocale,
  type LanguagePack,
} from './i18n';
import { initialLanguage } from './i18n/locale';
import { Provider, ToastQueue } from '@react-spectrum/s2';
import { ui } from './tagging/i18n';
import { Button, Modal, Toast } from './ui';
import { call, sendOnExit, setApiContext } from './api';
import type { Bootstrap, Job, JobPage, Settings } from './types';
import { terminal } from './types';
import {
  initialWorkspace,
  persistableWorkspace,
  workspaceReducer,
  type DropEdge,
  type Workspace,
  type WorkspaceTab,
} from './workspace';
import { annotationSessions, flushAnnotationEditors } from './tagging/AnnotationEditor';

export type Theme = 'system' | 'light' | 'dark';
interface AppContextType {
  data: Bootstrap;
  workspace: Workspace;
  jobs: JobPage;
  revision: number;
  /** Changes only when events touch this film, so detail pages do not reload for unrelated edits. */
  filmRevision(id: string): number;
  connected: boolean;
  theme: Theme;
  setTheme(theme: Theme): void;
  locale: string;
  setLocale(locale: string): void;
  refresh(): Promise<void>;
  open(tab: Omit<WorkspaceTab, 'state'> & { state?: Record<string, unknown> }): void;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  activate(id: string): void;
  close(id: string): void;
  update(id: string, change: Partial<WorkspaceTab>): void;
  patchState(id: string, change: (state: Record<string, unknown>) => Record<string, unknown>, dirty?: boolean): void;
  moveGroup(sourceKey: string, targetKey: string, edge: DropEdge): void;
}
// Events that change film lists or film detail; other events do not refresh pages.
const listEvents = new Set([
  'annotation.changed',
  'annotation.cleared',
  'candidate.accepted',
  'source.result-ready',
  'film.discovered',
  'media.probed',
]);
const AppContext = createContext<AppContextType | null>(null);
export const useApp = () => useContext(AppContext)!;
export const notifyError = (error: unknown) => {
  reportError(error);
  Toast.error(appText(error instanceof Error ? error.message : String(error)));
};
export const action = (fn: () => Promise<unknown>, success?: string) => {
  void Promise.resolve()
    .then(fn)
    .then(() => {
      if (success) Toast.success(success);
    })
    .catch(notifyError);
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Bootstrap>();
  useSyncExternalStore(subscribeLanguage, languageVersion);
  const locale = getLocale();
  const setLocale = (value: string) => {
    setLanguage(value);
    localStorage.setItem('vroom.locale', getLocale());
  };
  const eventCursor = useRef(0);
  const warned = useRef(-1);
  const [failure, setFailure] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspace, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspace);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [connected, setConnected] = useState(true);
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('vroom.theme') as Theme) || 'system');
  const prefersDark = useSyncExternalStore(
    listener => {
      const query = matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const colorScheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.style.colorScheme = colorScheme;
    document.documentElement.dataset.colorScheme = colorScheme;
  }, [colorScheme]);
  const setTheme = (value: Theme) => {
    localStorage.setItem('vroom.theme', value);
    setThemeState(value);
  };
  const filmRevisions = useRef(new Map<string, number>());
  const [jobs, setJobs] = useState<JobPage>({ items: [], total: 0, active: 0, paused: 0, failed: 0 });
  const settingsRevision = useRef(0),
    settingsWrites = useRef<Promise<unknown>>(Promise.resolve());
  const refresh = useCallback(async () => {
    const started = settingsRevision.current,
      result = await call<Bootstrap>('bootstrap');
    setData(current => ({
      ...result,
      settings: started === settingsRevision.current ? result.settings : (current?.settings ?? result.settings),
    }));
    setRevision(r => r + 1);
  }, []);
  const saveSettings = useCallback((patch: Partial<Settings>) => {
    const saved = settingsWrites.current
      .catch(() => {})
      .then(async () => {
        const settings = await call<Settings>('settings.patch', patch);
        settingsRevision.current++;
        setData(current => (current ? { ...current, settings } : current));
        return settings;
      });
    settingsWrites.current = saved;
    return saved;
  }, []);
  useEffect(() => {
    if (data && data.tagging.issueCount > 0 && warned.current !== data.tagging.generation) {
      warned.current = data.tagging.generation;
      ToastQueue.negative(`${ui('warnings', locale)} (${data.tagging.issueCount})`);
    }
  }, [data?.tagging.generation, data?.tagging.issueCount, locale]);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let jobsVersion = -1;
    // One long poll replaces per-second polling: the host answers when events or tasks change.
    (async () => {
      while (!stopped) {
        try {
          const batch = await call<{
            events: { sequence: number; data: { type: string; payload?: { subject?: { id?: string } } } }[];
            cursor: number;
            jobs: JobPage | null;
            jobsVersion: number;
          }>('changes.wait', { cursor: eventCursor.current, jobsVersion, timeoutSeconds: 25 });
          if (stopped) return;
          setConnected(true);
          jobsVersion = batch.jobsVersion;
          if (batch.jobs) setJobs(batch.jobs);
          eventCursor.current = batch.cursor;
          const events = batch.events;
          if (!events.length) continue;
          if (events.some(e => ['definition.activated', 'exchange.committed', 'term.changed'].includes(e.data.type)))
            await refresh();
          else if (events.some(e => listEvents.has(e.data.type))) {
            for (const e of events) {
              const id = e.data.payload?.subject?.id;
              if (id) filmRevisions.current.set(id, (filmRevisions.current.get(id) ?? 0) + 1);
            }
            setRevision(r => r + 1);
          }
        } catch {
          if (stopped) return;
          setConnected(false);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [ready, refresh]);
  useEffect(() => {
    setFailure('');
    let stopped = false;
    (async () => {
      const bootstrap = await call<Bootstrap>('bootstrap');
      if (bootstrap.apiVersion !== capabilities.clientApiVersion) throw new Error(appText('Journey.versionMismatch'));
      const [saved, languages] = await Promise.all([
        call<Workspace>('workspace.get'),
        call<{ installed: LanguagePack[]; systemLanguages: string[] }>('language.state'),
      ]);
      return [bootstrap, saved, languages] as const;
    })()
      .then(([bootstrap, saved, languages]) => {
        if (stopped) return;
        setInstalledPacks(languages.installed);
        setLocale(
          initialLanguage(
            localStorage.getItem('vroom.locale'),
            languages.systemLanguages.length ? languages.systemLanguages : navigator.languages,
            installedLanguages().map(pack => pack.locale),
            defaultLocale,
          ),
        );
        setData(bootstrap);
        eventCursor.current = bootstrap.tagging.cursor;
        setJobs(bootstrap.jobs);
        if (saved) dispatch({ type: 'restore', workspace: saved });
        setReady(true);
      })
      .catch(e => {
        if (!stopped) setFailure(String(e));
      });
    return () => {
      stopped = true;
    };
  }, [bootAttempt]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void call('workspace.save', persistableWorkspace(workspace)).catch(notifyError);
    }, 600);
    return () => clearTimeout(timer);
  }, [workspace, ready]);
  useEffect(() => {
    const flush = () => {
      if (ready) sendOnExit('workspace.save', persistableWorkspace(workspace));
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [workspace, ready]);
  useEffect(() => {
    const active = workspace.tabs.find(t => t.id === workspace.activeId);
    setApiContext(active ? { tabId: active.id, title: active.title.slice(0, 200) } : undefined);
  }, [workspace.activeId, workspace.tabs]);
  const close = (id: string) => {
    void (async () => {
      const tab = workspace.tabs.find(t => t.id === id);
      await flushAnnotationEditors(id);
      const hasAutoEditor = [...annotationSessions.keys()].some(key => key.startsWith(id + '/'));
      const finish = () => {
        for (const key of annotationSessions.keys()) if (key.startsWith(id + '/')) annotationSessions.delete(key);
        dispatch({ type: 'close', id });
      };
      if (
        tab?.dirty &&
        (!hasAutoEditor ||
          Object.keys((tab.state.fieldDrafts as object) ?? {}).length ||
          Object.keys((tab.state.drafts as object) ?? {}).length ||
          Object.keys((tab.state.termProfileDrafts as object) ?? {}).length)
      )
        Modal.confirm({
          title: appText('context.closeThisTabWithUnsavedChanges'),
          content: appText('context.unsavedChangesInThisTabWillBe'),
          okText: appText('context.closeTab'),
          cancelText: appText('context.keepEditing'),
          onOk: finish,
        });
      else finish();
    })().catch(notifyError);
  };
  if (failure)
    return (
      <div className="boot-error">
        <h1>{appText('context.unableToOpenTheCatalog')}</h1>
        <p>{failure}</p>
        <Button onClick={() => setBootAttempt(v => v + 1)}>{appText('Journey.retry')}</Button>
        <Button onClick={() => location.reload()}>{appText('Journey.reload')}</Button>
      </div>
    );
  if (!data || !ready)
    return (
      <div className="boot-loading">
        <span className="brand-mark">G</span>
        <h2>{appText('context.openingTheCatalog')}</h2>
        <p>{appText('context.restoringYourWorkspace')}</p>
      </div>
    );
  return (
    <Provider locale={locale} colorScheme={colorScheme} UNSAFE_className="schema-app-provider">
      <AppContext.Provider
        value={{
          data,
          workspace,
          jobs,
          revision,
          filmRevision: id => filmRevisions.current.get(id) ?? 0,
          connected,
          theme,
          setTheme,
          refresh,
          saveSettings,
          close,
          locale,
          setLocale,
          open: tab => dispatch({ type: 'open', tab: { ...tab, state: tab.state ?? {} } }),
          moveGroup: (sourceKey, targetKey, edge) => dispatch({ type: 'moveGroup', sourceKey, targetKey, edge }),
          activate: id => dispatch({ type: 'activate', id }),
          update: (id, change) => dispatch({ type: 'update', id, change }),
          patchState: (id, change, dirty) => dispatch({ type: 'patchState', id, change, dirty }),
        }}
      >
        {!connected && (
          <div className="connection-banner" role="status">
            {appText('context.disconnected')}
          </div>
        )}
        {children}
      </AppContext.Provider>
    </Provider>
  );
}
export function useTabState<T extends object>(
  tab: WorkspaceTab,
  initial: T,
): [T, (change: Partial<T>, dirty?: boolean) => void] {
  const app = useApp();
  const state = { ...initial, ...tab.state } as T;
  return [
    state,
    (change, dirty) => {
      app.patchState(tab.id, current => ({ ...current, ...change }), dirty);
    },
  ];
}
export function useJob<T>(id?: string, completed?: (result: T) => void) {
  const attempt = useApp().jobs.items.find(j => j.id === id)?.attempt;
  const [job, setJob] = useState<Job>();
  const handled = useRef('');
  const callback = useRef(completed);
  callback.current = completed;
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await call<Job>('job.get', { id });
        if (stopped) return;
        setJob(next);
        if (terminal(next.state)) {
          if (next.state === 'completed' && next.resultJson && handled.current !== id + ':' + next.attempt) {
            handled.current = id + ':' + next.attempt;
            callback.current?.(JSON.parse(next.resultJson));
          }
        } else timer = setTimeout(poll, 700);
      } catch (e) {
        if (!stopped) notifyError(e);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, attempt]);
  return job;
}
