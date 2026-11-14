import { ExportPartPicker } from '../ExportPartPicker';
import { t as appText, type MessageArgs } from '../i18n';
import { FormField, FormLayout, FormSection } from '../components/FormLayout';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Input, InputNumber, Select, Space, Switch, Banner, Spin, Toast, Modal } from '../ui';
import { InfoPopover } from '../components/InfoPopover';
import { Page, PageHeading, JobNotice } from '../components';
import { call } from '../api';
import { action, notifyError, useApp, useJob, useTabState } from '../context';
import { localize } from '../tagging/i18n';
import type { LocalizedText } from '../tagging/types';
import { sizeLabel, timecode, type FilmDetail, type QueryResult } from '../types';
import { type WorkspaceTab } from '../workspace';
import { IconPlus, IconClose, IconRefresh, IconTasks, IconVideo, IconFolder } from '../icons';
import {
  exportDestination,
  presetNames,
  presetSummary,
  matchingExportProfile,
  updateEncodingOption,
  type EngineCapabilities,
  type EncodingOption,
  type ExportPreview,
  type ExportSource,
} from '../media-export';
import defaultContract from '../../../../resources/tagging/media-export.json';

type Contract = typeof defaultContract;
interface Discovery {
  engine: EngineCapabilities;
  contract: Contract;
  presets: Record<string, Record<string, any>>;
}
export function ExportPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const [discovery, setDiscovery] = useState<Discovery>();
  const contract = discovery?.contract ?? defaultContract;
  const t = (key: string) =>
    localize((contract.copy as Record<string, LocalizedText>)[key], app.locale, app.data.tagging.package) || key;
  const l = (text?: LocalizedText) => localize(text, app.locale, app.data.tagging.package);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, set] = useTabState(tab, {
    advanced: false,
    queuedJobs: [] as string[],
    sampleJob: '',
    initialized: false,
    sources: [] as ExportSource[],
    sourcePath: '',
    presetName: '',
    userPreset: '',
    options: { ...defaultContract.profiles.find(p => p.id === defaultContract.defaults.profile)!.options } as Record<
      string,
      string | null
    >,
    directory: '',
    suffix: '-export',
    outputPaths: {} as Record<string, string>,
    priority: 0,
    notBefore: '',
    scanJobId: '',
    presetSaveName: '',
    pendingFilmIds: [] as string[],
    activeGroup: 'Video',
  });
  const [previews, setPreview] = useState<ExportPreview[]>();
  const preview = previews?.[0];
  const [samplePreview, setSamplePreview] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<QueryResult>();
  const [catalogPage, setCatalogPage] = useState(0);
  const [optionSearch, setOptionSearch] = useState('');
  const [adding, setAdding] = useState<'library' | 'path' | ''>('');
  const [retrySources, setRetrySources] = useState(0);
  const [scan, setScan] = useState<any>();
  const draftRevision = useRef(0);
  const [presetData, setPresetData] = useState<Record<string, any>>();
  const [resolved, setResolved] = useState<{ key: string; document: Record<string, any> }>();
  const [presetError, setPresetError] = useState('');
  const [encoderOptions, setEncoderOptions] = useState<Record<string, string[]>>({});
  const importFile = useRef<HTMLInputElement>(null);
  const scanJob = useJob(state.scanJobId, result => setScan(result));
  const change = (patch: Partial<typeof state>) => {
    draftRevision.current++;
    set(patch, true);
    setPreview(undefined);
    setSubmitted(false);
    setConflicts([]);
    setError('');
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = (force = false) =>
    run(async () => {
      const result = await call<Discovery>('export.capabilities', { refresh: force });
      setDiscovery(result);
      if (!state.presetName)
        set({
          presetName:
            result.engine.presets.find(p => p.name === contract.defaults.preset)?.name ??
            result.engine.presets[0]?.name ??
            '',
        });
    });
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!state.pendingFilmIds.length) return;
    let cancelled = false;
    const ids = [...state.pendingFilmIds],
      parts = tab.state.pendingParts as Record<string, string> | undefined;
    void (async () => {
      const results: PromiseSettledResult<FilmDetail>[] = [];
      for (let i = 0; i < ids.length && !cancelled; i += 16)
        results.push(
          ...(await Promise.allSettled(
            ids.slice(i, i + 16).map(id => call<FilmDetail>('film.get', { id, partId: parts?.[id] })),
          )),
        );
      return results;
    })().then(results => {
      if (cancelled) return;
      const loaded: ExportSource[] = [],
        completed: string[] = [],
        failures: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const film = result.value.film;
          loaded.push({
            key: film.id,
            filmId: film.id,
            partId: film.partId,
            name: film.presentation.title,
            path: film.path,
          });
          completed.push(ids[index]);
        } else failures.push(String(result.reason));
      });
      if (loaded.length) {
        setSubmitted(false);
        draftRevision.current++;
        setPreview(undefined);
        app.patchState(
          tab.id,
          current => ({
            ...current,
            initialized: true,
            sources: [
              ...((current.sources as ExportSource[]) ?? []),
              ...loaded.filter(
                s => !((current.sources as ExportSource[]) ?? []).some(existing => existing.key === s.key),
              ),
            ],
            pendingFilmIds: ((current.pendingFilmIds as string[]) ?? []).filter(id => !completed.includes(id)),
          }),
          true,
        );
      }
      if (failures.length) setError(failures.join('\n'));
    });
    return () => {
      cancelled = true;
    };
  }, [state.pendingFilmIds.join('|'), JSON.stringify(tab.state.pendingParts), retrySources]);
  useEffect(() => {
    if (adding !== 'library') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      call<QueryResult>('films.query', { search, offset: catalogPage * 20, limit: 20 })
        .then(result => {
          if (!cancelled) setCatalog(result);
        })
        .catch(notifyError);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [adding, search, catalogPage]);
  const addSource = (source: ExportSource) => {
    if (!state.sources.some(s => s.path === source.path)) change({ sources: [...state.sources, source] });
  };
  const setOption = (key: string, value: string | null | undefined) =>
    change({ options: updateEncodingOption(state.options, key, value) });
  const activePreset = state.userPreset ? discovery?.presets[state.userPreset] : undefined;
  const presetKey = JSON.stringify([state.presetName, activePreset, state.options, discovery?.engine.fingerprint]);
  const effective = resolved?.key === presetKey ? resolved.document : undefined;
  useEffect(() => {
    if (!discovery || !state.presetName) return;
    let cancelled = false;
    setPresetError('');
    const timer = setTimeout(() => {
      call<Record<string, any>>('export.preset.resolve', {
        presetName: state.presetName,
        ...(activePreset ? { preset: activePreset } : {}),
        options: state.options,
      })
        .then(document => {
          if (!cancelled) setResolved({ key: presetKey, document });
        })
        .catch(e => {
          if (!cancelled) setPresetError(String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [presetKey, retrySources]);
  useEffect(() => {
    if (!discovery || !state.presetName) return;
    let cancelled = false;
    setPresetData(undefined);
    call<Record<string, any>>('export.preset.resolve', {
      presetName: state.presetName,
      ...(activePreset ? { preset: activePreset } : {}),
    })
      .then(result => {
        if (!cancelled) setPresetData(result.PresetList?.[0]);
      })
      .catch(error => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [state.presetName, state.userPreset, JSON.stringify(activePreset), discovery?.engine.fingerprint]);
  const encoder = state.options.encoder ?? presetData?.VideoEncoder;
  useEffect(() => {
    if (!encoder) return;
    let cancelled = false;
    setEncoderOptions({});
    call<Record<string, string[]>>('export.encoder', { encoder })
      .then(result => {
        if (!cancelled) setEncoderOptions(result);
      })
      .catch(error => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [encoder]);
  const format =
    state.options.format ??
    effective?.PresetList?.[0]?.FileFormat ??
    presetData?.FileFormat ??
    contract.defaults.format;
  const output = (source: ExportSource) =>
    state.outputPaths[source.key] ?? exportDestination(state.directory, source.path, state.suffix, format);
  const makePreview = (sample = false) =>
    run(async () => {
      const revision = draftRevision.current;
      if (state.notBefore && Number.isNaN(new Date(state.notBefore).valueOf())) throw new Error(t('scheduled'));
      const sources = sample ? state.sources.slice(0, 1) : state.sources;
      const destinations = sources.map(s =>
        sample ? exportDestination(state.directory, s.path, state.suffix + '-sample', format) : output(s),
      );
      const normalized = destinations.map(path =>
        path.includes('\\') || /^[a-z]:/i.test(path) ? path.replaceAll('/', '\\').toLowerCase() : path,
      );
      if (new Set(normalized).size !== normalized.length) throw new Error(appText('ExportFlow.duplicateOutput'));
      const previews: ExportPreview[] = [];
      for (let offset = 0; offset < sources.length; offset += 500) {
        const result = await call<ExportPreview>('export.preview', {
          targets: sources.slice(offset, offset + 500).map(s => ({
            ...(s.filmId ? { filmId: s.filmId, partId: s.partId } : { sourcePath: s.sourcePath }),
            outputPath: sample
              ? exportDestination(state.directory, s.path, state.suffix + '-sample', format)
              : output(s),
          })),
          presetName: state.presetName,
          ...(activePreset ? { preset: activePreset } : {}),
          options: {
            ...state.options,
            format,
            ...(sample ? { 'start-at': 'duration:0', 'stop-at': 'duration:10' } : {}),
          },
          schedule: {
            priority: state.priority,
            notBefore: !sample && state.notBefore ? new Date(state.notBefore).toISOString() : null,
          },
        });
        previews.push(result);
      }
      if (revision !== draftRevision.current) return;
      setPreview(previews);
      setSamplePreview(sample);
      setSubmitted(false);
      setConflicts([]);
    });
  const commitPreview = () =>
    run(async () => {
      if (!previews) return;
      const jobIds: string[] = [],
        failures: string[] = [];
      for (const preview of previews) {
        const result = await call<{ jobIds: string[]; conflicts: { error: string; errorArgs?: MessageArgs }[] }>(
          'export.commit',
          { previewToken: preview.previewToken },
        );
        jobIds.push(...result.jobIds);
        failures.push(...result.conflicts.map(c => appText(c.error, c.errorArgs)));
        set(
          {
            queuedJobs: [...new Set([...state.queuedJobs, ...jobIds])],
            sampleJob: samplePreview ? (jobIds[0] ?? '') : state.sampleJob,
          },
          false,
        );
      }
      setConflicts(failures);
      setSubmitted(!samplePreview && !failures.length);
      if (!failures.length) setPreview(undefined);
    });
  const selectedProfile = matchingExportProfile(contract.profiles, state.presetName, state.userPreset, state.options);
  const settingsSummary = (document: Record<string, any>) => (
    <dl className="export-summary">
      {presetSummary(document.PresetList?.[0] ?? {}, contract.summary, l, appText('ExportFlow.emptySetting')).map(
        row => (
          <div key={row.id}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ),
      )}
    </dl>
  );
  const blocked = state.pendingFilmIds.length
    ? appText('ExportFlow.pendingSources')
    : !state.sources.length
      ? appText('ExportFlow.needSources')
      : !discovery
        ? appText('ExportFlow.needEngine')
        : presetError ||
          (!effective
            ? appText('ExportFlow.loadingPreset')
            : !state.directory.trim() && state.sources.some(s => !state.outputPaths[s.key])
              ? appText('ExportFlow.needDirectory')
              : state.sources.some(s => !output(s))
                ? appText('ExportFlow.invalidOutput')
                : '');
  const chooseFiles = () =>
    action(async () => {
      const paths = await call<string[]>('platform.pickFiles');
      if (!paths.length) {
        setAdding('path');
        return;
      }
      change({
        sources: [
          ...state.sources,
          ...paths
            .filter(path => !state.sources.some(s => s.path === path))
            .map(path => ({ key: path, path, sourcePath: path, name: path.split(/[\\/]/).pop() || path })),
        ],
      });
    });
  const optionField = (option: EncodingOption) => {
    const enabled = Object.hasOwn(state.options, option.key);
    const value = state.options[option.key] ?? '';
    const label = l(option.label);
    const choices = encoderOptions[option.key] ?? option.choices;
    const inherited = presetData?.[(contract.presetBindings as Record<string, string>)[option.key]];
    return (
      <div className="encoding-field" key={option.key} role="group" aria-label={label}>
        <div className="switch-row">
          <div className="encoding-field-label">
            <span>{label}</span>
            <InfoPopover label={label + ' · ' + t('help')}>
              <strong>{label}</strong>
              <pre>{l(option.help)}</pre>
              <code>--{option.key}</code>
            </InfoPopover>
          </div>
          <Switch
            checked={enabled}
            aria-label={t('enabled') + ' · ' + label}
            onChange={enabled =>
              setOption(
                option.key,
                enabled ? (option.arity === 'none' ? null : String(inherited ?? choices[0] ?? '')) : undefined,
              )
            }
          />
        </div>
        {option.arity !== 'none' &&
          (choices.length ? (
            <Select
              allowCreate
              aria-label={label}
              disabled={!enabled}
              value={enabled ? value : String(inherited ?? '')}
              optionList={choices.map(value => ({ value, label: value }))}
              onChange={value => setOption(option.key, String(value))}
              placeholder={t('inherit')}
            />
          ) : option.valueType === 'number' && option.arity === 'required' ? (
            <InputNumber
              aria-label={label}
              disabled={!enabled}
              value={Number(enabled ? value : inherited) || 0}
              onChange={value => setOption(option.key, String(value))}
            />
          ) : (
            <Input
              aria-label={label}
              disabled={!enabled}
              value={enabled ? value : String(inherited ?? '')}
              onChange={value => setOption(option.key, value)}
              placeholder={t('inherit')}
            />
          ))}
      </div>
    );
  };
  const panels: Record<string, () => ReactNode> = {
    'source-add@1': () =>
      adding === 'library' ? (
        <div className="form-stack">
          <Input
            showClear
            aria-label={t('search')}
            placeholder={t('search')}
            value={search}
            onChange={value => {
              setSearch(value);
              setCatalogPage(0);
            }}
          />
          <div className="export-catalog-list">
            {catalog && !catalog.films.length && <p className="form-help">{appText('ExportFlow.noLibraryResults')}</p>}
            {catalog?.films.map(film => (
              <div className="export-catalog-row" key={film.id}>
                <div>
                  <span>{film.presentation.title}</span>
                  <small className="file-path">{film.path}</small>
                </div>
                <Button
                  disabled={state.sources.some(s => s.path === film.path)}
                  onClick={() =>
                    addSource({
                      key: film.id,
                      filmId: film.id,
                      partId: film.partId,
                      name: film.presentation.title,
                      path: film.path,
                    })
                  }
                >
                  {state.sources.some(s => s.path === film.path) ? appText('ExportFlow.selected') : t('addSource')}
                </Button>
              </div>
            ))}
          </div>
          <Space>
            <Button disabled={!catalogPage} aria-label={t('previous')} onClick={() => setCatalogPage(catalogPage - 1)}>
              ←
            </Button>
            <span>
              {catalogPage + 1} / {Math.max(1, Math.ceil((catalog?.total ?? 0) / 20))}
            </span>
            <Button
              disabled={(catalogPage + 1) * 20 >= (catalog?.total ?? 0)}
              aria-label={t('next')}
              onClick={() => setCatalogPage(catalogPage + 1)}
            >
              →
            </Button>
          </Space>
        </div>
      ) : (
        <FormLayout>
          <FormField label={t('sourcePath')} description={t('pathFallback')}>
            <Input aria-label={t('sourcePath')} value={state.sourcePath} onChange={sourcePath => set({ sourcePath })} />
          </FormField>
          <Space wrap>
            <Button
              disabled={!state.sourcePath.trim()}
              onClick={() => {
                const path = state.sourcePath.trim();
                addSource({ key: path, path, sourcePath: path, name: path.split(/[\\/]/).pop() || path });
                set({ sourcePath: '' });
                setAdding('');
              }}
            >
              {t('addSource')}
            </Button>
            <Button
              onClick={() =>
                action(async () => {
                  const path = await call<string | null>('platform.pickFolder');
                  if (path) {
                    addSource({ key: path, path, sourcePath: path, name: path.split(/[\\/]/).pop() || path });
                    setAdding('');
                  } else Toast.info(t('pathFallback'));
                })
              }
            >
              {t('pickDisc')}
            </Button>
          </Space>
        </FormLayout>
      ),
    'source-list@1': () => (
      <div className="form-stack">
        <Space wrap>
          <Button theme={state.sources.length ? undefined : 'solid'} icon={<IconPlus />} onClick={chooseFiles}>
            {appText('ExportFlow.files')}
          </Button>
          <Button onClick={() => setAdding('library')}>{appText('ExportFlow.library')}</Button>
          <Button onClick={() => setAdding('path')}>{appText('ExportFlow.path')}</Button>
        </Space>
        <p className="form-help">
          {state.sources.length
            ? appText('ExportFlow.sourceCount', { count: state.sources.length })
            : appText('ExportFlow.sourceHelp')}
        </p>
        <div className="export-source-list">
          {state.sources.map(source => (
            <div data-context-resource="" className="export-source-item" key={source.key}>
              <IconVideo />
              <div className="grow">
                <b>{source.name}</b>
                <small title={source.path}>{source.path}</small>
                {source.filmId && (
                  <ExportPartPicker
                    source={source}
                    disabled={busy}
                    change={part =>
                      change({
                        sources: state.sources.map(s =>
                          s.key === source.key
                            ? { ...s, partId: part.id, path: part.path, key: s.filmId + ':' + part.id }
                            : s,
                        ),
                      })
                    }
                  />
                )}
                <Button
                  size="S"
                  theme="borderless"
                  disabled={busy || !discovery}
                  onClick={() =>
                    void run(async () => {
                      setScan(undefined);
                      const result = await call<{ jobId: string }>(
                        'export.scan',
                        source.filmId
                          ? { filmId: source.filmId, partId: source.partId }
                          : { sourcePath: source.sourcePath },
                      );
                      set({ scanJobId: result.jobId });
                    })
                  }
                >
                  {t('scan')}
                </Button>
              </div>
              <Button
                theme="borderless"
                size="S"
                aria-label={t('remove') + ' ' + source.name}
                icon={<IconClose />}
                onClick={() => change({ sources: state.sources.filter(s => s.key !== source.key) })}
              />
            </div>
          ))}
          <JobNotice job={scanJob} />
          {scan?.TitleList?.map((title: any) => (
            <details className="disclosure-section" key={title.Index}>
              <summary>
                {title.Index} · {title.Name} · {title.Geometry?.Width} × {title.Geometry?.Height} ·{' '}
                {timecode(title.Duration?.Ticks / 90000)}
              </summary>
              <div className="form-stack">
                <Button onClick={() => setOption('title', String(title.Index))}>{t('useTitle')}</Button>
                {[
                  ['audio', title.AudioList],
                  ['subtitles', title.SubtitleList],
                  ['chapters', title.ChapterList],
                ].map(([key, tracks]: any) => (
                  <div key={key}>
                    <b>{t(key)}</b>
                    {tracks?.map((track: any, index: number) => (
                      <div className="muted" key={index}>
                        {index + 1} · {track.Description || track.Name || track.Language || ''} {track.CodecName || ''}{' '}
                        {track.ChannelLayoutName || ''}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    ),
    'preset-picker@1': () => (
      <FormLayout>
        <FormField layout="row" label={t('preset')}>
          <Select
            filter
            aria-label={t('preset')}
            value={JSON.stringify([state.userPreset, state.presetName])}
            optionList={[
              ...(discovery?.engine.presets ?? []).map(p => ({
                value: JSON.stringify(['', p.name]),
                label: p.category + ' / ' + p.name,
              })),
              ...Object.entries(discovery?.presets ?? {}).flatMap(([name, preset]) =>
                presetNames(preset).map(p => ({ value: JSON.stringify([name, p]), label: name + ' / ' + p })),
              ),
            ]}
            onChange={value => {
              const [userPreset, presetName] = JSON.parse(String(value));
              change({ userPreset, presetName, options: {}, outputPaths: {} });
            }}
          />
        </FormField>
        <Space wrap>
          <Button onClick={() => importFile.current?.click()}>{t('importPreset')}</Button>
          {state.userPreset && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call('export.preset.delete', { name: state.userPreset });
                  change({ userPreset: '', presetName: contract.defaults.preset, options: {}, outputPaths: {} });
                  await refresh();
                })
              }
            >
              {t('deletePreset')}
            </Button>
          )}
        </Space>
        <input
          hidden
          ref={importFile}
          aria-label={t('importPreset')}
          type="file"
          accept=".json,application/json"
          onChange={event => {
            const file = event.target.files?.[0];
            if (file)
              void run(async () => {
                if (file.size > 2_000_000) throw new Error(t('presetTooLarge'));
                const preset = JSON.parse(await file.text());
                const name = file.name.replace(/\.json$/i, '');
                await call('export.preset.save', { name, preset });
                setDiscovery(await call<Discovery>('export.capabilities'));
                change({ userPreset: name, presetName: presetNames(preset)[0] ?? '', options: {}, outputPaths: {} });
              });
            event.target.value = '';
          }}
        />
      </FormLayout>
    ),
    'export-plan@1': () => (
      <div className="form-stack">
        <p className="form-help">{appText('ExportFlow.presetHelp')}</p>
        <div className="export-profile-list">
          {contract.profiles.map(profile => (
            <article
              className={'export-profile ' + (selectedProfile === profile.id ? 'is-selected' : '')}
              key={profile.id}
            >
              <h3>{l(profile.label)}</h3>
              <p>{l(profile.description)}</p>
              <dl>
                {Object.entries(profile.options).map(([key, value]) => (
                  <div key={key}>
                    <dt>{l((contract.fields as Record<string, LocalizedText>)[key]) || key}</dt>
                    <dd>
                      {l(
                        (contract.optionValueLabels as Record<string, Record<string, LocalizedText>>)[key]?.[
                          String(value)
                        ],
                      ) || value}
                    </dd>
                  </div>
                ))}
              </dl>
              <Button
                aria-label={appText('ExportFlow.choosePlan') + ' · ' + l(profile.label)}
                aria-pressed={selectedProfile === profile.id}
                onClick={() =>
                  change({
                    presetName: profile.preset,
                    options: { ...profile.options },
                    userPreset: '',
                    outputPaths: {},
                  })
                }
              >
                {selectedProfile === profile.id ? appText('ExportFlow.selected') : appText('ExportFlow.choosePlan')}
              </Button>
            </article>
          ))}
        </div>
        <details className="form-disclosure">
          <summary>{appText('ExportFlow.otherPresets')}</summary>
          {panel('preset')}
        </details>
        <section className="export-effective" aria-label={appText('ExportFlow.currentSettings')}>
          <header>
            <h3>
              {appText('ExportFlow.selectedPlan', {
                name: l(contract.profiles.find(p => p.id === selectedProfile)?.label) || appText('ExportFlow.custom'),
              })}
            </h3>
            <span>
              {appText('ExportFlow.basePreset')} · {state.userPreset ? state.userPreset + ' / ' : ''}
              {state.presetName}
            </span>
          </header>
          {effective ? (
            settingsSummary(effective)
          ) : presetError ? (
            <Banner type="danger" description={presetError} />
          ) : (
            <p className="form-help" role="status">
              {appText('ExportFlow.loadingPreset')}
            </p>
          )}
          <p className="form-help">{appText('ExportFlow.changeableSize')}</p>
        </section>
        <details
          className="form-disclosure"
          open={state.advanced}
          onToggle={e => set({ advanced: e.currentTarget.open })}
        >
          <summary>{appText('ExportFlow.configure')}</summary>
          {panel('options')}
        </details>
        {effective && (
          <details className="form-disclosure">
            <summary>{appText('ExportFlow.fullPreset')}</summary>
            <pre>{JSON.stringify({ preset: effective, options: state.options }, null, 2)}</pre>
          </details>
        )}
        {effective && (
          <details className="form-disclosure">
            <summary>{appText('ExportFlow.savePlan')}</summary>
            <FormLayout>
              <FormField layout="row" label={t('presetName')}>
                <Input
                  aria-label={t('presetName')}
                  value={state.presetSaveName}
                  onChange={presetSaveName => set({ presetSaveName })}
                />
              </FormField>
              <Space wrap>
                <Button
                  disabled={!state.presetSaveName.trim() || busy}
                  onClick={() =>
                    void run(async () => {
                      await call('export.preset.save', {
                        name: state.presetSaveName.trim(),
                        preset: {
                          ...effective,
                          PresetList: [{ ...effective.PresetList[0], PresetName: state.presetSaveName.trim() }],
                        },
                      });
                      setDiscovery(await call<Discovery>('export.capabilities'));
                      Toast.success(appText('ExportFlow.presetSaved'));
                    })
                  }
                >
                  {t('savePreset')}
                </Button>
                <Button
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(effective, null, 2)], { type: 'application/json' }),
                    );
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'video-preset.json';
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  {t('exportPreset')}
                </Button>
              </Space>
            </FormLayout>
          </details>
        )}
      </div>
    ),
    'handbrake-options@1': () => {
      const groups = [...new Set(discovery?.engine.options.map(o => o.group))];
      const selected = groups.includes(state.activeGroup) ? state.activeGroup : groups[0];
      const visible =
        discovery?.engine.options.filter(
          o =>
            (optionSearch || o.group === selected) &&
            `${o.key} ${l(o.label)} ${l(o.help)}`.toLowerCase().includes(optionSearch.toLowerCase()),
        ) ?? [];
      return (
        <div className="export-encoding">
          <div className="export-encoding-heading">
            <h3>{t('options')}</h3>
            <Input
              showClear
              aria-label={t('searchOptions')}
              placeholder={t('searchOptions')}
              value={optionSearch}
              onChange={setOptionSearch}
            />
          </div>
          <nav className="encoding-nav" aria-label={t('options')}>
            {groups.map(group => (
              <Button
                key={group}
                theme="borderless"
                className={!optionSearch && group === selected ? 'is-current' : ''}
                aria-pressed={!optionSearch && group === selected}
                onClick={() => {
                  set({ activeGroup: group });
                  setOptionSearch('');
                }}
              >
                {l((contract.groups as Record<string, LocalizedText>)[group]) || group}
              </Button>
            ))}
          </nav>
          <div className="encoding-options-scroll">
            <div className="encoding-grid">{visible.map(optionField)}</div>
            {!visible.length && <p className="muted">{t('noOptions')}</p>}
          </div>
          <div className="encoding-inheritance">{t('presetHelp')}</div>
        </div>
      );
    },
    'export-destination@1': () => (
      <div className="form-stack">
        <FormLayout>
          <FormField layout="row" label={t('outputDirectory')} description={appText('ExportFlow.outputHelp')}>
            <Input
              aria-label={t('outputDirectory')}
              value={state.directory}
              onChange={directory => change({ directory, outputPaths: {} })}
            />
            <Button
              icon={<IconFolder />}
              onClick={() =>
                action(async () => {
                  const path = await call<string | null>('platform.pickFolder');
                  if (path) change({ directory: path, outputPaths: {} });
                  else Toast.info(t('folderFallback'));
                })
              }
            >
              {appText('ExportFlow.browse')}
            </Button>
          </FormField>
          <FormField layout="row" label={t('format')}>
            <Select
              aria-label={t('format')}
              value={format}
              optionList={(
                discovery?.engine.options.find(o => o.key === 'format')?.choices ?? [contract.defaults.format]
              ).map(value => ({ value, label: value.replace('av_', '').toUpperCase() }))}
              onChange={value =>
                change({ options: updateEncodingOption(state.options, 'format', String(value)), outputPaths: {} })
              }
            />
          </FormField>
          <FormField layout="row" label={t('suffix')}>
            <Input
              aria-label={t('suffix')}
              value={state.suffix}
              onChange={suffix => change({ suffix, outputPaths: {} })}
            />
          </FormField>
        </FormLayout>
        {!!state.sources.length && (
          <div className="export-output-preview" aria-label={appText('ExportFlow.outputExample')}>
            {state.sources.slice(0, 3).map(source => (
              <div key={source.key}>
                <span>{source.name}</span>
                <span className="file-path">→ {output(source) || appText('ExportFlow.needDirectory')}</span>
              </div>
            ))}
            {state.sources.length > 3 && (
              <p className="form-help">{appText('ExportFlow.sourceCount', { count: state.sources.length })}</p>
            )}
          </div>
        )}
        <details className="form-disclosure">
          <summary>{t('outputSettings')}</summary>
          <FormLayout>
            <FormSection title={t('scheduler')}>
              <FormField layout="row" label={t('priority')}>
                <InputNumber
                  aria-label={t('priority')}
                  value={state.priority}
                  min={-10}
                  max={10}
                  onChange={priority => change({ priority })}
                />
              </FormField>
              <FormField layout="row" label={t('scheduled')}>
                <input
                  className="datetime-field"
                  type="datetime-local"
                  aria-label={t('scheduled')}
                  value={state.notBefore}
                  onChange={event => change({ notBefore: event.target.value })}
                />
              </FormField>
            </FormSection>
            {!!state.sources.length && (
              <FormSection title={t('outputPath')}>
                {state.sources.map(source => (
                  <FormField key={source.key} label={source.name}>
                    <Input
                      aria-label={t('outputPath') + ' · ' + source.name}
                      value={output(source)}
                      onChange={path => change({ outputPaths: { ...state.outputPaths, [source.key]: path } })}
                    />
                  </FormField>
                ))}
              </FormSection>
            )}
          </FormLayout>
        </details>
      </div>
    ),
    'export-review@1': () =>
      preview && (
        <div className="form-stack">
          <p>{appText('ExportFlow.reviewCount', { count: previews!.reduce((n, p) => n + p.targets.length, 0) })}</p>
          {samplePreview && <p className="form-help">{appText('ExportFlow.sampleHelp')}</p>}
          {settingsSummary(preview.preset)}
          <p className="form-help">
            {preview.schedule?.notBefore
              ? appText('ExportFlow.scheduleAt', {
                  time: new Date(preview.schedule.notBefore).toLocaleString(app.locale),
                })
              : appText('ExportFlow.scheduleNow')}
          </p>
          <div className="export-review-files">
            {previews!
              .flatMap(p => p.targets)
              .map(target => (
                <div key={target.jobId} className="export-review-row">
                  <b>{target.name}</b>
                  <small className="muted">
                    {target.source.path} · {sizeLabel(target.source.bytes)}
                  </small>
                  <div className="file-path">→ {target.outputPath}</div>
                </div>
              ))}
          </div>
          <p className="form-help">{t('safety')}</p>
          <details className="form-disclosure">
            <summary>{appText('ExportFlow.fullPreset')}</summary>
            <pre>{JSON.stringify({ preset: preview.preset, options: preview.options }, null, 2)}</pre>
          </details>
          {error && <Banner type="danger" description={error} />}
          {conflicts.length > 0 && <Banner type="warning" description={conflicts.join('\n')} />}
        </div>
      ),
  };
  const panel = (id: string) => {
    const node = contract.layout.find(n => n.id === id);
    return node ? panels[node.component]?.() : null;
  };
  return (
    <Page className="media-export-page">
      <PageHeading title={t('title')}>
        <Button
          theme="borderless"
          icon={<IconRefresh />}
          title={t('refresh')}
          aria-label={t('refresh')}
          disabled={busy}
          onClick={() => {
            void refresh(true);
            setRetrySources(n => n + 1);
          }}
        />
        <Button icon={<IconTasks />} onClick={() => app.open({ id: 'jobs', kind: 'jobs', title: t('jobs') })}>
          {t('jobs')}
        </Button>
      </PageHeading>
      {!discovery && busy && <Spin />}
      {!discovery && !busy && <Banner type="warning" description={t('unavailable')} />}
      <div className="export-workspace">
        {contract.steps.map((step, index) => (
          <section key={step.panel} className="export-step" aria-labelledby={'export-step-' + index}>
            <header>
              <span className="export-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <h2 id={'export-step-' + index}>{appText(step.titleMessage)}</h2>
            </header>
            {panel(step.panel)}
          </section>
        ))}
      </div>
      <div className="export-action-bar">
        {error && !preview && <Banner type="danger" description={error} />}
        <p className="form-help" role="status">
          {error ? '' : submitted ? appText('ExportFlow.queued') : blocked || appText('ExportFlow.ready')}
        </p>
        <Space wrap>
          <Button
            disabled={
              busy || !!blocked || !state.directory.trim() || !discovery?.engine.options.some(o => o.key === 'stop-at')
            }
            onClick={() => void makePreview(true)}
          >
            {appText('ExportFlow.sample')}
          </Button>
          <Button theme="solid" disabled={submitted || busy || !!blocked} onClick={() => void makePreview()}>
            {busy ? t('busy') : appText('ExportFlow.review')}
          </Button>
        </Space>
      </div>
      {!!state.queuedJobs.length && (
        <div className="form-stack">
          <Space>
            <b>{appText('Journey.batchQueued', { count: state.queuedJobs.length })}</b>
            <Button onClick={() => app.open({ id: 'jobs', kind: 'jobs', title: t('jobs') })}>
              {appText('Journey.openResults')}
            </Button>
          </Space>
          {state.queuedJobs.slice(0, 6).map(id => (
            <ExportJobNotice key={id} id={id} />
          ))}
        </div>
      )}
      {conflicts.length > 0 && <Banner type="warning" description={conflicts.join('\n')} />}
      <Modal
        mode="exclusive"
        title={appText(adding === 'library' ? 'ExportFlow.library' : 'ExportFlow.path')}
        visible={!!adding}
        onCancel={() => setAdding('')}
        footer={<Button onClick={() => setAdding('')}>{t('done')}</Button>}
      >
        <div className="media-export-page">{panels['source-add@1']()}</div>
      </Modal>
      <Modal
        mode="exclusive"
        width={760}
        title={appText(samplePreview ? 'ExportFlow.sampleReviewTitle' : 'ExportFlow.reviewTitle')}
        visible={!!preview}
        onCancel={() => {
          if (!busy) setPreview(undefined);
        }}
        footer={
          <Space wrap>
            <Button disabled={busy} onClick={() => setPreview(undefined)}>
              {t('backToSettings')}
            </Button>
            <Button theme="solid" disabled={busy} onClick={() => void commitPreview()}>
              {busy
                ? t('busy')
                : conflicts.length
                  ? appText('ExportFlow.retry')
                  : samplePreview
                    ? appText('ExportFlow.queueSample')
                    : appText('ExportFlow.queue', { count: previews?.reduce((n, p) => n + p.targets.length, 0) ?? 0 })}
            </Button>
          </Space>
        }
      >
        <div className="media-export-page">{panel('review')}</div>
      </Modal>
    </Page>
  );
}

function ExportJobNotice({ id }: { id: string }) {
  const job = useJob(id);
  return <JobNotice job={job} />;
}
