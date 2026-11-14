import type { RpcMethod } from '../rpc-methods';
import { SubtitleSettings } from '../OnlineSubtitles';
import hostCapabilities from '../../../../resources/tagging/playback-capabilities.json';
import { JobOutcome } from '../components/JobOutcome';
import { t as appText } from '../i18n';
import { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Pagination,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag as UiTag,
  Timeline,
  Toast,
} from '../ui';
import { IconPlus, IconRefresh, IconPlay, IconPause, IconStop, IconDelete, IconSave, IconFolder } from '../icons';
import { call, startJob } from '../api';
import { action, notifyError, useApp, useJob, useTabState, type Theme } from '../context';
import { EmptyState, JobNotice, Page, PageHeading } from '../components';
import { jobStateLabel, type Job, type JobPage, type JobState, type Library, type Settings } from '../types';
import { requestImport, type WorkspaceTab } from '../workspace';
import { PathListEditor } from '../components/PathListEditor';
import { FormField, FormLayout, FormSection } from '../components/FormLayout';
import { SchedulerControls, JobScheduleEditor, JobRuntimeInfo, ExportLog } from '../components/JobScheduling';
import { LanguageSettings } from '../components/LanguageSettings';
import { openConfiguration } from '../tagging/field-links';
import { NetworkSettings } from '../components/NetworkSettings';

export function LibrariesPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const [state, set] = useTabState(tab, { jobId: '' });
  const job = useJob(state.jobId, () => {
    void app.refresh();
  });
  return (
    <Page>
      <PageHeading title={appText('ManagementPages.manageLibraries')}>
        <Button theme="solid" icon={<IconPlus />} onClick={() => requestImport(app)}>
          {appText('ManagementPages.newLibrary')}
        </Button>
      </PageHeading>
      <JobNotice job={job} />
      <Card>
        {app.data.libraries.length === 0 ? (
          <EmptyState title={appText('ManagementPages.noLibrariesYet')} />
        ) : (
          app.data.libraries.map(library => (
            <div data-context-resource="" className="library-row" key={library.id}>
              <IconFolder size="large" />
              <div className="grow">
                <span className="item-title">{library.name}</span>
                <small>{library.roots.join(' · ')}</small>
                <Space>
                  <Button
                    size="small"
                    onClick={() =>
                      app.open({
                        id: 'library:' + library.id,
                        kind: 'library',
                        title: library.name,
                        params: { libraryId: library.id },
                      })
                    }
                  >
                    {appText('ManagementPages.browseFilms')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      app.open({
                        id: 'libraries:' + library.id,
                        kind: 'libraries',
                        title: library.name,
                        params: { libraryId: library.id },
                      })
                    }
                  >
                    {appText('ManagementPages.edit2')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() =>
                      action(async () => set({ jobId: await startJob('library.scan', { id: library.id }) }))
                    }
                  >
                    {appText('ManagementPages.scan')}
                  </Button>
                </Space>
              </div>
              <Button
                icon={<IconDelete />}
                theme="borderless"
                type="danger"
                aria-label={appText('ManagementPages.remove') + library.name}
                onClick={() =>
                  Modal.confirm({
                    title: appText('ManagementPages.removeThisLibrary'),
                    content: appText('ManagementPages.removeIndexedRecordsAndTheirAnnotationsSource'),
                    onOk: async () => {
                      const removed = await call<{ films: number; archive: string }>('library.remove', {
                        id: library.id,
                      });
                      Toast.success(
                        appText('ManagementPages.libraryRemoved', { count: removed.films, archive: removed.archive }),
                      );
                      await app.refresh();
                    },
                  })
                }
              />
            </div>
          ))
        )}
      </Card>
    </Page>
  );
}

export function LibraryEditorPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const current = app.data.libraries.find(l => l.id === tab.params?.libraryId);
  const [state, set] = useTabState(tab, {
    name: current?.name ?? '',
    roots: current?.roots.join('\n') ?? '',
    excludes: current?.excludes.join('\n') ?? '',
    autoEnrich: current?.autoEnrich ?? true,
    probeOnScan: current?.probeOnScan ?? true,
    jobId: '',
  });
  const job = useJob(state.jobId, () => {
    void app.refresh();
  });
  const save = () =>
    action(async () => {
      const library: Library = {
        id: current?.id ?? crypto.randomUUID(),
        name: state.name,
        roots: state.roots
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
        excludes: state.excludes
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean),
        autoEnrich: state.autoEnrich,
        probeOnScan: state.probeOnScan,
      };
      await call('library.save', library);
      app.update(tab.id, { title: library.name, dirty: false, params: { libraryId: library.id } });
      await app.refresh();
      // Only a new library or changed folders/exclusions need a scan; renaming never rescans storage.
      const scope = (l?: Library) => JSON.stringify([l?.roots ?? [], l?.excludes ?? []]);
      if (!current || scope(current) !== scope(library)) {
        set({ jobId: await startJob('library.scan', { id: library.id }) }, false);
        Toast.success(appText('ManagementPages.librarySavedScanQueuedInBackgroundTasks'));
      } else {
        set({}, false);
        Toast.success(appText('ManagementPages.librarySaved'));
      }
    });
  return (
    <Page>
      <PageHeading
        title={current ? appText('ManagementPages.editLibrary') + current.name : appText('ManagementPages.newLibrary')}
        description={appText('ManagementPages.chooseLocalOrNasFoldersToDiscover')}
      />
      <JobNotice job={job} />
      <FormLayout>
        <FormSection title={appText('ManagementPages.filesAndLocations')}>
          <FormField layout="row" label={appText('ManagementPages.name')}>
            <Input
              aria-label={appText('ManagementPages.name')}
              value={state.name}
              onChange={name => set({ name }, true)}
              placeholder={appText('ManagementPages.forExampleLocalCollection')}
            />
          </FormField>
          <FormField
            layout="row"
            label={appText('ManagementPages.videoFolders')}
            description={appText('ManagementPages.oneLocalOrNasPathPerLine')}
            actions={
              <Button
                size="S"
                theme="borderless"
                icon={<IconFolder />}
                onClick={() =>
                  action(async () => {
                    const folder = await call<string | null>('platform.pickFolder');
                    if (folder) set({ roots: [state.roots, folder].filter(Boolean).join('\n') }, true);
                    else Toast.info(appText('ManagementPages.enterFolderPathsDirectlyWhenUsingThe'));
                  })
                }
              >
                {appText('ManagementPages.chooseFolder')}
              </Button>
            }
          >
            <PathListEditor
              label={appText('ManagementPages.videoFolders')}
              value={state.roots.split('\n')}
              onChange={roots => set({ roots: roots.join('\n') }, true)}
              placeholder={appText('ManagementPages.rootsExample.' + app.data.platform).split('\n')[0]}
            />
          </FormField>
          <FormField
            layout="row"
            label={appText('ManagementPages.excludedKeywords')}
            description={appText('ManagementPages.oneKeywordPerLineMatchingPathsAre')}
          >
            <PathListEditor
              label={appText('ManagementPages.excludedPathKeywords')}
              value={state.excludes.split('\n')}
              onChange={excludes => set({ excludes: excludes.join('\n') }, true)}
              placeholder={appText('ManagementPages.forExampleRecycleBinTemporaryFiles')}
            />
          </FormField>
        </FormSection>
        <FormSection title={appText('ManagementPages.scanBehavior')}>
          <FormField
            layout="row"
            label={appText('ManagementPages.mediaInformation')}
            description={appText('ManagementPages.readDurationResolutionAndAverageFrameRate')}
          >
            <Switch checked={state.probeOnScan} onChange={probeOnScan => set({ probeOnScan }, true)}>
              {appText('ManagementPages.readDurationAndVideoQualityAutomatically')}
            </Switch>
          </FormField>
          <FormField
            layout="row"
            label={appText('ManagementPages.metadataSource')}
            description={appText('ManagementPages.accessToExternalSitesIsControlledIn')}
          >
            <Switch checked={state.autoEnrich} onChange={autoEnrich => set({ autoEnrich }, true)}>
              {appText('ManagementPages.enrichMetadataAutomatically')}
            </Switch>
          </FormField>
        </FormSection>
        <Space className="form-actions" wrap>
          <Button theme="solid" icon={<IconSave />} onClick={save}>
            {appText(current ? 'ManagementPages.saveLibrary' : 'ManagementPages.saveAndScan')}
          </Button>
        </Space>
      </FormLayout>
    </Page>
  );
}

export { TagsPage } from './TagsPage';
export { ViewsPage } from './ViewsPage';

export function JobsPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const [state, set] = useTabState(tab, { filter: '', page: 1, detailJobId: '' });
  const [result, setResult] = useState<JobPage>({ items: [], total: 0, active: 0, paused: 0, failed: 0 });
  const [detail, setDetail] = useState<Job>();
  const [events, setEvents] = useState<{ time: string; state: JobState; detail: string }[]>([]);
  const liveDetail = result.items.find(job => job.id === detail?.id) ?? detail;
  const closeDetail = () => {
    setDetail(undefined);
    set({ detailJobId: '' });
  };
  useEffect(() => {
    if (!state.detailJobId) return;
    let stopped = false;
    void Promise.all([
      call<Job>('job.get', { id: state.detailJobId }),
      call<typeof events>('job.events', { id: state.detailJobId }),
    ])
      .then(([job, events]) => {
        if (!stopped) {
          setDetail(job);
          setEvents(events);
        }
      })
      .catch(error => {
        if (!stopped) notifyError(error);
      });
    return () => {
      stopped = true;
    };
  }, [state.detailJobId]);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await call<JobPage>('job.list', {
          filter: state.filter,
          offset: (state.page - 1) * 30,
          limit: 30,
        });
        if (!stopped) setResult(data);
      } catch (e) {
        if (!stopped) notifyError(e);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(load, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state.filter, state.page]);
  const control = (method: RpcMethod, job: Job) =>
    action(async () => {
      await call(method, { id: job.id });
      const data = await call<JobPage>('job.list', { filter: state.filter, offset: (state.page - 1) * 30, limit: 30 });
      setResult(data);
    });
  const rowActions = (job: Job) => (
    <Space wrap>
      {job.canPause && (['queued', 'running'] as string[]).includes(job.state) && (
        <Button size="small" icon={<IconPause />} onClick={() => control('job.pause', job)}>
          {appText('ManagementPages.pause')}
        </Button>
      )}
      {(['pausing', 'paused'] as string[]).includes(job.state) && (
        <Button size="small" icon={<IconPlay />} onClick={() => control('job.resume', job)}>
          {appText('ManagementPages.resume')}
        </Button>
      )}
      {job.canRetry && (['cancelled', 'failed', 'interrupted'] as string[]).includes(job.state) && (
        <Button size="small" icon={<IconRefresh />} onClick={() => control('job.resume', job)}>
          {appText('ManagementPages.retry')}
        </Button>
      )}
      {job.canStop && (['queued', 'running', 'pausing', 'paused'] as string[]).includes(job.state) && (
        <Button size="small" type="danger" icon={<IconStop />} onClick={() => control('job.stop', job)}>
          {appText('ManagementPages.stop')}
        </Button>
      )}
      <Button
        size="small"
        theme="borderless"
        onClick={() =>
          action(async () => {
            setDetail(job);
            setEvents(await call('job.events', { id: job.id }));
          })
        }
      >
        {appText('ManagementPages.details')}
      </Button>
    </Space>
  );
  return (
    <Page>
      <PageHeading
        title={appText('ManagementPages.backgroundTasks')}
        description={appText('ManagementPages.trackProgressPauseOrResumeTasksTask')}
      />
      <details className="form-disclosure">
        <summary>{appText('Journey.scheduling')}</summary>
        <SchedulerControls />
      </details>
      <div className="job-metrics">
        <Card>
          <span>{appText('ManagementPages.running')}</span>
          <span className="metric-value">{app.jobs.active}</span>
        </Card>
        <Card>
          <span>{appText('ManagementPages.paused')}</span>
          <span className="metric-value">{app.jobs.paused}</span>
        </Card>
        <Card>
          <span>{appText('ManagementPages.needsAttention')}</span>
          <span className="metric-value">{app.jobs.failed}</span>
        </Card>
        <Card>
          <span>{appText('ManagementPages.allRecords')}</span>
          <span className="metric-value">{result.total}</span>
        </Card>
      </div>
      <div className="view-toolbar">
        <Space>
          {[
            { value: '', name: appText('ManagementPages.allRecords') },
            { value: 'active', name: appText('ManagementPages.running') },
            { value: 'done', name: appText('ManagementPages.finished') },
            { value: 'failed', name: appText('ManagementPages.needsAttention') },
          ].map(f => (
            <Button
              key={f.value}
              theme={state.filter === f.value ? 'solid' : 'light'}
              onClick={() => set({ filter: f.value, page: 1 })}
            >
              {f.name}
            </Button>
          ))}
        </Space>
      </div>
      <Table
        rowKey="id"
        pagination={false}
        dataSource={result.items}
        columns={[
          {
            title: appText('ManagementPages.task'),
            width: 230,
            render: (_, item) => {
              const j = item as Job;
              return (
                <div>
                  <span className="item-title">{appText(j.name, j.nameArgs)}</span>
                  <small className="muted block">
                    {new Date(j.started).toLocaleString(app.locale)} {appText('jobs.attempt', { count: j.attempt })}
                  </small>
                </div>
              );
            },
          },
          {
            title: appText('ManagementPages.status'),
            width: 105,
            dataIndex: 'state',
            render: value => (
              <UiTag
                color={
                  value === 'completed'
                    ? 'green'
                    : (['failed', 'interrupted'] as string[]).includes(String(value))
                      ? 'red'
                      : 'blue'
                }
              >
                {jobStateLabel(value as JobState)}
              </UiTag>
            ),
          },
          {
            title: appText('ManagementPages.progress'),
            render: (_, item) => {
              const j = item as Job;
              return (
                <div className="job-progress">
                  {j.total != null && j.total > 0 ? (
                    <Progress
                      percent={j.state === 'completed' ? 100 : Math.min(100, (j.completed / j.total) * 100)}
                      showInfo
                    />
                  ) : (
                    <Space>
                      {(['queued', 'running', 'cancelling', 'pausing'] as string[]).includes(j.state) && (
                        <Spin size="small" />
                      )}
                      <span>{appText('jobs.processed', { count: j.completed })}</span>
                    </Space>
                  )}
                  <small className={j.error ? 'error-text' : 'muted'}>
                    {j.error ? appText(j.error, j.errorArgs) : appText(j.detail, j.detailArgs)}
                  </small>
                  <JobOutcome job={j} compact />
                  <JobRuntimeInfo job={j} />
                </div>
              );
            },
          },
          {
            title: appText('ManagementPages.actions'),
            width: 245,
            render: (_, item) => (
              <div>
                {rowActions(item as Job)}
                <details className="form-disclosure">
                  <summary>{appText('Journey.scheduling')}</summary>
                  <JobScheduleEditor job={item as Job} />
                </details>
              </div>
            ),
          },
        ]}
        empty={<EmptyState title={appText('ManagementPages.noMatchingTasks')} />}
      />
      <div className="pagination">
        <Pagination
          total={result.total}
          currentPage={state.page}
          pageSize={30}
          showTotal
          onPageChange={page => set({ page })}
        />
      </div>
      <Modal
        mode="modeless"
        title={liveDetail && appText(liveDetail.name, liveDetail.nameArgs)}
        visible={Boolean(detail)}
        onCancel={closeDetail}
        footer={<Button onClick={closeDetail}>{appText('ManagementPages.close')}</Button>}
        width={780}
      >
        <div className="job-detail">
          {liveDetail && <p className="job-detail-state">{jobStateLabel(liveDetail.state)}</p>}
          {liveDetail?.error && (
            <p className="error-text" role="alert">
              {appText(liveDetail.error, liveDetail.errorArgs)}
            </p>
          )}
          {liveDetail && <JobOutcome job={liveDetail} />}
          {/* Follow-up work stays reachable from the task that started it, and the other way round. */}
          {liveDetail?.parentId && (
            <p>
              {appText('ManagementPages.startedBy')}{' '}
              <Button
                theme="borderless"
                onClick={() => {
                  const parent = app.jobs.items.find(j => j.id === liveDetail.parentId);
                  if (parent) setDetail(parent);
                }}
              >
                {(() => {
                  const parent = app.jobs.items.find(j => j.id === liveDetail.parentId);
                  return parent ? appText(parent.name, parent.nameArgs) : liveDetail.parentId;
                })()}
              </Button>
            </p>
          )}
          {liveDetail && app.jobs.items.some(j => j.parentId === liveDetail.id) && (
            <div>
              <p className="form-help">{appText('ManagementPages.followUpTasks')}</p>
              {app.jobs.items
                .filter(j => j.parentId === liveDetail.id)
                .map(child => (
                  <Button key={child.id} theme="borderless" onClick={() => setDetail(child)}>
                    {appText(child.name, child.nameArgs)} · {jobStateLabel(child.state)}
                  </Button>
                ))}
            </div>
          )}
          {liveDetail?.kind === 'media.export' && <ExportLog job={liveDetail} />}
          <details className="form-disclosure">
            <summary>{appText('jobs.history')}</summary>
            <Timeline>
              {events.map((e, i) => (
                <Timeline.Item key={i} time={new Date(e.time).toLocaleString(app.locale)}>
                  {jobStateLabel(e.state)} · {appText(e.detail)}
                </Timeline.Item>
              ))}
            </Timeline>
          </details>
          {/* Raw arguments and results are diagnostics, kept out of the main task view. */}
          <details className="form-disclosure">
            <summary>{appText('Journey.diagnostics')}</summary>
            <p className="muted">
              {detail?.id} · {detail?.kind}
            </p>
            <pre>{detail?.payload}</pre>
            {liveDetail?.resultJson && <pre>{liveDetail.resultJson}</pre>}
          </details>
        </div>
      </Modal>
    </Page>
  );
}

export function SettingsPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const [state, set] = useTabState(tab, { settings: {} as Partial<Settings> });
  const drafts = tab.dirty ? state.settings : {},
    settings = { ...app.data.settings, ...drafts };
  const hasChanges = Object.entries(drafts).some(([key, value]) => value !== app.data.settings[key as keyof Settings]);
  type SaveState = { pending: boolean; error?: string; value: Settings[keyof Settings] };
  const [saves, setSaves] = useState<Partial<Record<keyof Settings, SaveState>>>({});
  useEffect(() => {
    if (Boolean(tab.dirty) !== hasChanges) set({}, hasChanges);
  }, [tab.dirty, hasChanges]);
  const change = (patch: Partial<Settings>) => set({ settings: { ...drafts, ...patch } }, true);
  const apply = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    action(async () => {
      if (value === app.data.settings[key] && !saves[key]?.error) return;
      setSaves(current => ({ ...current, [key]: { pending: true, value } }));
      try {
        await app.saveSettings({ [key]: value });
        app.patchState(tab.id, current => {
          const remaining = { ...(current.settings as Partial<Settings>) };
          if (remaining[key] === value) delete remaining[key];
          return { ...current, settings: remaining };
        });
        setSaves(current => ({ ...current, [key]: { pending: false, value } }));
      } catch (error) {
        setSaves(current => ({
          ...current,
          [key]: { pending: false, value, error: error instanceof Error ? error.message : String(error) },
        }));
        throw error;
      }
    });
  const feedback = (key: keyof Settings) =>
    saves[key] && (
      <p className={saves[key]?.error ? 'error-text' : 'form-help'} role={saves[key]?.error ? 'alert' : 'status'}>
        {saves[key]?.error ? (
          <>
            {saves[key]?.error}{' '}
            <Button size="S" onClick={() => apply(key, saves[key]!.value)}>
              {appText('Journey.retry')}
            </Button>
          </>
        ) : (
          appText(saves[key]?.pending ? 'Settings.applying' : 'Settings.applied')
        )}
      </p>
    );
  type ToolKey = 'ffmpeg' | 'ffprobe' | 'handBrake' | 'mpv' | 'model';
  const toolOf: Partial<Record<keyof Settings, ToolKey>> = {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    handBrakePath: 'handBrake',
    mpvPath: 'mpv',
    modelPath: 'model',
  };
  const [developer, setDeveloper] = useState(() => localStorage.getItem('vroom.developer') === 'true');
  const [runtime, setRuntime] = useState<Record<ToolKey, { path: string; source: string }>>();
  useEffect(() => {
    void call<Record<ToolKey, { path: string; source: string }>>('runtime.status').then(setRuntime).catch(notifyError);
  }, [app.data.settings]);
  const pathInput = (
    key: 'sourceBrowserPath' | 'mpvPath' | 'ffmpegPath' | 'ffprobePath' | 'handBrakePath' | 'modelPath',
    label: string,
  ) => (
    <>
      <Input
        aria-label={label}
        placeholder={toolOf[key] ? appText('Settings.toolAutomatic') : undefined}
        value={settings[key]}
        disabled={saves[key]?.pending}
        onChange={value => change({ [key]: value })}
        onBlur={event => apply(key, event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
        }}
      />
      {toolOf[key] && runtime?.[toolOf[key]!] && (
        <p className="form-help">
          {appText('Settings.toolResolved', {
            source: runtime[toolOf[key]!].source,
            path: runtime[toolOf[key]!].path || '—',
          })}
        </p>
      )}
      {feedback(key)}
    </>
  );
  return (
    <Page>
      <PageHeading title={appText('ManagementPages.settings')} description={appText('Settings.immediateHelp')} />
      <div className="settings-grid">
        <LanguageSettings />
        <Card title={appText('Settings.appearance')}>
          <FormLayout>
            <FormField layout="row" label={appText('Settings.theme')}>
              <Select
                aria-label={appText('Settings.theme')}
                value={app.theme}
                onChange={value => app.setTheme(value as Theme)}
                optionList={(['system', 'light', 'dark'] as const).map(value => ({
                  value,
                  label: appText('Settings.theme.' + value),
                }))}
              />
            </FormField>
            <FormField
              layout="row"
              label={appText('Settings.developerTools')}
              description={appText('Settings.developerToolsHelp')}
            >
              <Switch
                checked={developer}
                onChange={value => {
                  localStorage.setItem('vroom.developer', String(value));
                  setDeveloper(value);
                }}
              >
                {appText('Settings.developerToolsSwitch')}
              </Switch>
            </FormField>
          </FormLayout>
        </Card>
        <SubtitleSettings />
        <Card title={appText('Journey.diagnostics')}>
          <Button onClick={() => action(() => call('diagnostics.reveal'))}>{appText('Stability.openLogs')}</Button>
        </Card>
        <Card title={appText('ExternalPlayers.paths')}>
          <FormLayout>
            {hostCapabilities.externalPlayers.profiles.map(profile => (
              <FormField
                layout="row"
                key={profile.id}
                label={profile.name}
                description={appText('ExternalPlayers.pathHelp')}
              >
                <Input
                  aria-label={profile.name}
                  value={settings.externalPlayerPaths[profile.id] ?? ''}
                  onChange={value =>
                    change({ externalPlayerPaths: { ...settings.externalPlayerPaths, [profile.id]: value } })
                  }
                  onBlur={e =>
                    apply('externalPlayerPaths', {
                      ...settings.externalPlayerPaths,
                      [profile.id]: e.currentTarget.value.trim(),
                    })
                  }
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
                  }}
                />
              </FormField>
            ))}
            {feedback('externalPlayerPaths')}
          </FormLayout>
        </Card>
        <NetworkSettings
          value={settings.network}
          change={network => change({ network })}
          apply={network => apply('network', network)}
          feedback={feedback('network')}
        />
        <Card title={appText('ManagementPages.discoveryAndEnrichment')}>
          <FormLayout>
            <FormField
              layout="row"
              label={appText('ManagementPages.scanInterval')}
              description={appText('Settings.scanIntervalHelp')}
            >
              <Select
                aria-label={appText('ManagementPages.automaticScanIntervalMinutes')}
                value={app.data.settings.scanIntervalMinutes}
                disabled={saves.scanIntervalMinutes?.pending}
                onChange={v => apply('scanIntervalMinutes', Number(v))}
                optionList={[0, 60, 360, 1440, 10080].map(value => ({
                  value,
                  label: appText('Settings.scanEvery', { minutes: value }),
                }))}
              />
              {feedback('scanIntervalMinutes')}
              <Switch
                checked={app.data.settings.scanOnStartup}
                disabled={saves.scanOnStartup?.pending}
                onChange={value => apply('scanOnStartup', value)}
              >
                {appText('Settings.scanOnStartup')}
              </Switch>
              {feedback('scanOnStartup')}
            </FormField>
            <FormField
              layout="row"
              label={appText('ManagementPages.onlineEnrichment')}
              actions={
                <Button size="S" theme="borderless" onClick={() => openConfiguration(app, 'sources')}>
                  {appText('ManagementPages.configureDataSources')}
                </Button>
              }
            >
              <Switch
                checked={app.data.settings.onlineMetadata}
                disabled={saves.onlineMetadata?.pending}
                onChange={value => apply('onlineMetadata', value)}
              >
                {appText('ManagementPages.allowEnrichmentFromExternalWebsites')}
              </Switch>
              {feedback('onlineMetadata')}
            </FormField>
            <FormField
              layout="row"
              label={appText('Settings.sourceBrowserPath')}
              description={appText('Settings.sourceBrowserHelp')}
            >
              {pathInput('sourceBrowserPath', appText('Settings.sourceBrowserPath'))}
            </FormField>
          </FormLayout>
        </Card>
        <details className="form-disclosure settings-diagnostics">
          <summary>{appText('Journey.diagnostics')}</summary>{' '}
          <Card title={appText('ManagementPages.mediaRuntime')}>
            <FormLayout>
              {app.data.platform !== 'windows' && (
                <Banner type="info" description={appText('Settings.playbackModeNotice')} />
              )}
              <FormField layout="row" label="mpv" description={appText('Mpv.runtimeHelp')}>
                {pathInput('mpvPath', 'mpv')}
              </FormField>
              <FormField layout="row" label="FFmpeg">
                {pathInput('ffmpegPath', 'FFmpeg')}
              </FormField>
              <FormField layout="row" label="FFprobe">
                {pathInput('ffprobePath', 'FFprobe')}
              </FormField>
              <FormField layout="row" label="HandBrakeCLI">
                {pathInput('handBrakePath', 'HandBrakeCLI')}
              </FormField>
              <FormField
                layout="row"
                label={appText('ManagementPages.transcodingQuality')}
                description={appText('ManagementPages.maximumResolutionAllowedWhenReEncoding')}
              >
                <Select
                  aria-label={appText('ManagementPages.maximumReEncodingQuality')}
                  value={app.data.settings.transcodeHeight}
                  disabled={saves.transcodeHeight?.pending}
                  onChange={v => apply('transcodeHeight', Number(v))}
                  optionList={[720, 1080, 1440, 2160].map(value => ({ value, label: value + 'p' }))}
                />
                {feedback('transcodeHeight')}
              </FormField>
            </FormLayout>
          </Card>
          <Card title={appText('ManagementPages.localIntelligence')}>
            <FormLayout>
              <FormField
                layout="row"
                label={appText('ManagementPages.ggufModel')}
                description={appText('Settings.modelPathHelp')}
              >
                {pathInput('modelPath', appText('ManagementPages.ggufModelPath'))}
              </FormField>
            </FormLayout>
          </Card>
          <Card title={appText('ManagementPages.aboutVroom')}>
            <Descriptions
              data={[
                { key: appText('Settings.version'), value: app.data.version },
                { key: appText('Settings.dataDirectory'), value: <code>{app.data.dataDirectory}</code> },
              ]}
            />
          </Card>
        </details>
      </div>
    </Page>
  );
}

export { DuplicatesPage } from './DuplicatesPage';
