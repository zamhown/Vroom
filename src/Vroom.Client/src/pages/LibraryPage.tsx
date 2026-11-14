import { t as appText } from '../i18n';
import { FormField } from '../components/FormLayout';
import { defaultOrderBy, sortMode } from '../components/QueryBuilder';
import { QueryEditor, resolveQueryEditor, type QueryEditorState } from '../components/QueryEditor';
import { ImportDialog } from '../components/ImportDialog';
import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ActionButton,
  DialogTrigger,
  Popover,
  Slider,
  Text,
  ToggleButton,
  ToggleButtonGroup,
} from '@react-spectrum/s2';
import { Button, Input, Modal, Select, Table, Toast, Spin, Banner, Checkbox } from '../ui';
import { IconChevronDown, IconGridView, IconList, IconPlay, IconSort } from '../icons';
import { call, startJob } from '../api';
import { action, useApp, useJob, useTabState } from '../context';
import { EmptyState, FilmCard, JobNotice, Page, PageHeading } from '../components';
import { defaultQuery, terminal, type Film, type Query, type QueryResult } from '../types';
import { workspaceSourceKey, type WorkspaceTab } from '../workspace';
import { localize, formatValue } from '../tagging/i18n';
import { predicateCount } from '../query';
import { placements } from '../tagging/Surface';
import { TagValue } from '../tagging/Inputs';
import { LibraryActions } from '../tagging/LibraryActions';
import { createQueryRefresh } from '../query-refresh';
import type { RibbonState } from '../components/Ribbon';

// Keep dragging local; inline and popover controls adopt the same committed height.
function PosterSizeSlider({
  height,
  preview,
  commit,
}: {
  height: number;
  preview(height: number): void;
  commit(height: number): void;
}) {
  const [draft, setDraft] = useState({ committed: height, value: height });
  if (draft.committed !== height) setDraft({ committed: height, value: height });
  return (
    <Slider
      size="M"
      label={appText('LibraryPage.posterHeight')}
      minValue={160}
      maxValue={400}
      step={10}
      value={draft.value}
      onChange={value => {
        setDraft({ committed: height, value });
        preview(value);
      }}
      onChangeEnd={commit}
      UNSAFE_className="poster-size-slider"
    />
  );
}

export function LibraryPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const pack = app.data.tagging.package;
  const base = tab.params?.query ?? defaultQuery();
  const defaultOrder = defaultOrderBy(pack);
  const [state, set] = useTabState(tab, {
    search: base.search ?? '',
    where: base.where,
    showAdvanced: false,
    orderBy: tab.params?.query?.orderBy ?? defaultOrder,
    groupBy: base.groupBy ?? [],
    queryDraft: undefined as Query | undefined,
    queryEditor: { mode: 'form' } as QueryEditorState,
    page: 1,
    layout: 'grid',
    posterHeight: 240,
    jobId: '',
    scroll: 0,
    ribbon: {} as RibbonState,
  });
  // Dragging resizes posters directly; the tab keeps the height once the drag ends.
  const grid = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<QueryResult>({ films: [], total: 0, groups: {} });
  const [loading, setLoading] = useState(true);
  const [hasResult, setHasResult] = useState(false);
  const refreshQuery = useRef<ReturnType<typeof createQueryRefresh<QueryResult>>>(undefined);
  const [failure, setFailure] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (tab.params?.openImport) setImportOpen(true);
  }, [tab.params?.openImport]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [allResults, setAllResults] = useState(false);
  const selectionEpoch = useRef(0);
  const [selectBusy, setSelectBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const where = state.where;
  const invalid = '';
  const job = useJob(state.jobId);
  const query: Query = {
    where,
    search: state.search,
    libraryId: tab.params?.libraryId ?? base.libraryId,
    ignoreDefaultQuery: base.ignoreDefaultQuery,
    scope: base.scope,
    // Continuous scrolling: 'page' is the number of loaded pages of 60 films.
    offset: 0,
    limit: Math.min(10000, state.page * 60),
    orderBy: state.orderBy,
    groupBy: state.groupBy,
    locale: app.locale,
  };
  const draft = state.queryDraft ?? query;
  const resolved = resolveQueryEditor(draft, state.queryEditor, pack.definitions),
    draftInvalid = resolved.error;
  const sqlActive = state.showAdvanced && state.queryEditor?.mode === 'sql';
  const editQuery = (change: Partial<Query>) => set({ queryDraft: { ...draft, ...change } });
  const toggleFilters = () =>
    set({ showAdvanced: !state.showAdvanced, queryDraft: state.queryDraft ?? structuredClone(query) });
  const shown = state.showAdvanced ? resolved.query : query,
    primary = shown.orderBy?.[0];
  const quickOrder = (change: Partial<Query>) =>
    state.showAdvanced
      ? editQuery(change)
      : set({ ...change, page: 1, queryDraft: undefined, queryEditor: { mode: 'form' } });
  const applyDraft = () => {
    if (!draftInvalid) {
      const ready = resolved.query;
      set({
        where: ready.where ?? null,
        search: ready.search ?? '',
        orderBy: ready.orderBy ?? [],
        groupBy: ready.groupBy ?? [],
        page: 1,
        queryDraft: undefined,
        queryEditor: { mode: 'form' },
        showAdvanced: false,
      });
    }
  };
  useEffect(() => {
    if (invalid) return;
    // Only a new query changes the target scope. Data invalidations refresh the
    // existing snapshot in place, retaining its count, cards and enabled actions.
    setLoading(true);
    const refresh = createQueryRefresh(
      () => call<QueryResult>('films.query', query),
      result => {
        setResult(result);
        setHasResult(true);
        setFailure('');
        setLoading(false);
      },
      error => {
        setFailure(String(error));
        setLoading(false);
      },
    );
    refreshQuery.current = refresh;
    refresh.request();
    return () => {
      refresh.dispose();
      refreshQuery.current = undefined;
    };
  }, [JSON.stringify(query), invalid]);
  useEffect(() => {
    refreshQuery.current?.request();
  }, [app.revision]);
  useEffect(() => {
    selectionEpoch.current++;
    setSelected([]);
    setAllResults(false);
  }, [JSON.stringify({ where, search: state.search, library: query.libraryId })]);
  const selectAll = () =>
    action(async () => {
      const epoch = selectionEpoch.current;
      setSelectBusy(true);
      try {
        const all = await call<{ ids: string[] }>('films.ids', query);
        if (epoch === selectionEpoch.current) {
          setSelected(all.ids);
          setAllResults(true);
        }
      } finally {
        setSelectBusy(false);
      }
    });
  const currentView = app.data.views.find(v => v.id === tab.params?.viewId);
  const play = (film: Film, queue?: string[]) =>
    app.open({
      id: queue?.length ? 'playlist:' + crypto.randomUUID() : 'player:' + film.id,
      kind: 'player',
      title: queue?.length ? tab.title + appText('LibraryPage.playlist') : film.presentation.tabTitle,
      params: {
        filmId: film.id,
        queue,
        ...(queue?.length
          ? { sourceKey: workspaceSourceKey(tab), sourceTitle: tab.params?.sourceTitle || tab.title }
          : {}),
      },
    });
  const detail = (film: Film) =>
    app.open({ id: 'film:' + film.id, kind: 'film', title: film.presentation.tabTitle, params: { filmId: film.id } });
  const playAll = () =>
    action(async () => {
      const all = await call<{ ids: string[] }>('films.ids', query);
      if (all.ids.length) {
        const first = await call<{ film: Film }>('film.get', { id: all.ids[0] });
        play(first.film, all.ids);
      }
    });
  const label = (d: (typeof pack.definitions)[number]) => localize(d.label, app.locale, pack);
  const sortable = pack.definitions.filter(d => d.enabled && d.query?.sort);
  const columns = placements(pack, 'film.table.columns');
  const groupText = (tuple: string) =>
    (JSON.parse(tuple) as unknown[])
      .map((value, index) => {
        const field = state.groupBy[index],
          d = pack.definitions.find(d => d.key === field?.tag);
        const text =
          value === null
            ? appText('Query.empty')
            : d
              ? field.mode === 'facet'
                ? localize(
                    d.facets?.[field.facet ?? '']?.bands?.find((b: any) => b.id === value)?.label,
                    app.locale,
                    pack,
                  ) || String(value)
                : formatValue(d, value as any, app.locale, pack)
              : String(value);
        return d ? label(d) + ': ' + text : text;
      })
      .join(' · ');
  const commands = {
    'library.import': { run: () => setImportOpen(true) },
    'library.play': { run: playAll, disabled: !result.total || !!invalid },
    'library.query': {
      run: toggleFilters,
      selected: state.showAdvanced,
      badge: predicateCount(query.where) || undefined,
    },
    'library.save-view': {
      run: () => {
        setViewName(tab.title);
        setSaveOpen(true);
      },
      disabled: state.showAdvanced,
    },
    'library.select': {
      run: () => {
        setSelecting(!selecting);
        setSelected([]);
        setAllResults(false);
      },
      disabled: !result.total,
      selected: selecting,
    },
    'library.copy': {
      run: () =>
        app.open({
          ...tab,
          id: crypto.randomUUID(),
          title: tab.title + appText('LibraryPage.copy'),
          params: {
            ...tab.params,
            independent: true,
            sourceKey: workspaceSourceKey(tab),
            sourceTitle: tab.params?.sourceTitle || tab.title,
          },
          state: { ...tab.state },
        }),
    },
    'library.scan': {
      run: () =>
        action(async () => {
          const libs = query.libraryId ? app.data.libraries.filter(l => l.id === query.libraryId) : app.data.libraries;
          for (const library of libs) set({ jobId: await startJob('library.scan', { id: library.id }) });
          Toast.success(appText('LibraryPage.scanQueuedInBackgroundTasks'));
        }),
    },
    'library.export': {
      disabled: !selecting || !selected.length,
      run: () =>
        app.open({
          id: 'export',
          kind: 'export',
          title: appText('Journey.compress'),
          state: { pendingFilmIds: selected, replaceSources: true },
        }),
    },
    'library.remove': {
      disabled: !selecting || !selected.length,
      danger: true,
      run: () =>
        Modal.confirm({
          title: appText('LibraryPage.removeFilmsTitle', { count: selected.length }),
          content: appText('LibraryPage.removeFilmsConsequence'),
          okText: appText('LibraryPage.removeFilms'),
          onOk: async () => {
            const removed = await call<{ films: number; archive: string }>('films.remove', { ids: selected });
            setSelected([]);
            setAllResults(false);
            Toast.success(
              appText('ManagementPages.libraryRemoved', { count: removed.films, archive: removed.archive }),
            );
            await app.refresh();
          },
        }),
    },
  };
  const controls = {
    'library.search': (
      <Input
        size="M"
        showClear
        disabled={sqlActive}
        value={shown.search ?? ''}
        onChange={search =>
          state.showAdvanced
            ? editQuery({ search })
            : set({ search, page: 1, queryDraft: undefined, queryEditor: { mode: 'form' } })
        }
        placeholder={appText('LibraryPage.searchFilms')}
        aria-label={appText('LibraryPage.searchFilms')}
      />
    ),
    'library.sort': (
      <Select
        size="M"
        disabled={sqlActive}
        aria-label={appText('LibraryPage.sortBy')}
        value={primary?.tag ?? ''}
        onChange={v =>
          quickOrder({
            orderBy: [
              { ...primary, tag: String(v), mode: sortMode(pack.definitions.find(d => d.key === v)) },
              ...(shown.orderBy ?? []).slice(1),
            ],
          })
        }
        optionList={sortable.map(d => ({ label: label(d), value: d.key }))}
      />
    ),
    'library.direction': (
      <Button
        aria-label={appText('Query.directionState', {
          direction: appText(primary?.direction === 'asc' ? 'Journey.asc' : 'Journey.desc'),
        })}
        title={appText(primary?.direction === 'asc' ? 'Journey.asc' : 'Journey.desc')}
        icon={
          <span className={primary?.direction === 'asc' ? 'query-arrow-up' : ''}>
            <IconSort />
          </span>
        }
        disabled={!primary || sqlActive}
        onClick={() =>
          quickOrder({
            orderBy: [
              { ...primary!, direction: primary?.direction === 'asc' ? 'desc' : 'asc' },
              ...(shown.orderBy ?? []).slice(1),
            ],
          })
        }
      />
    ),
    'library.poster-size':
      state.layout === 'grid' ? (
        <DialogTrigger>
          <ActionButton size="M">
            <IconChevronDown />
            <Text>{appText('Ribbon.posterSize')}</Text>
          </ActionButton>
          <Popover aria-label={appText('Ribbon.posterSize')} UNSAFE_className="ribbon-size-popover">
            <PosterSizeSlider
              height={state.posterHeight}
              preview={height => grid.current?.style.setProperty('--poster-height', height + 'px')}
              commit={posterHeight => set({ posterHeight })}
            />
          </Popover>
        </DialogTrigger>
      ) : null,
    'library.view': (
      <ToggleButtonGroup
        size="M"
        density="compact"
        selectionMode="single"
        disallowEmptySelection
        aria-label={appText('LibraryPage.viewMode')}
        selectedKeys={[state.layout]}
        onSelectionChange={keys => {
          const key = [...keys][0];
          if (key != null) set({ layout: String(key) });
        }}
      >
        <ToggleButton id="grid" aria-label={appText('LibraryPage.posters')}>
          <IconGridView />
        </ToggleButton>
        <ToggleButton id="list" aria-label={appText('LibraryPage.list')}>
          <IconList />
        </ToggleButton>
      </ToggleButtonGroup>
    ),
    'library.selection': selecting ? (
      <div className="ribbon-selection">
        <Checkbox
          checked={allResults || (result.films.length > 0 && result.films.every(f => selected.includes(f.id)))}
          onChange={e => {
            setAllResults(false);
            setSelected(
              e.target.checked
                ? [...new Set([...selected, ...result.films.map(f => f.id)])]
                : selected.filter(id => !result.films.some(f => f.id === id)),
            );
          }}
        >
          {appText('Journey.thisPage')}
        </Checkbox>
        <span>{appText(allResults ? 'Journey.allSelected' : 'Journey.selected', { count: selected.length })}</span>
        {!allResults && result.total > selected.length && (
          <Button theme="borderless" disabled={selectBusy} onClick={selectAll}>
            {appText('Journey.selectAllResults', { count: result.total })}
          </Button>
        )}
      </div>
    ) : (
      <span className="ribbon-selection">{appText('Ribbon.selectionAll')}</span>
    ),
  };
  return (
    <Page
      className="library-page"
      ref={el => {
        if (el && !el.dataset.restored) {
          el.scrollTop = state.scroll;
          el.dataset.restored = 'true';
        }
      }}
      onScroll={e => set({ scroll: e.currentTarget.scrollTop })}
    >
      <LibraryActions
        query={query}
        subjectIds={selecting ? selected : undefined}
        disabled={loading || !!failure || !result.total || (selecting && !selected.length)}
        queued={jobId => set({ jobId })}
        commands={commands}
        controls={controls}
        ribbonState={state.ribbon}
        onRibbonChange={ribbon => set({ ribbon })}
        heading={
          <PageHeading
            title={tab.title}
            meta={hasResult ? appText('LibraryPage.other', { p0: result.total }) : undefined}
          />
        }
      />
      <JobNotice job={job} />
      {state.showAdvanced && (
        <section className="advanced-filter" aria-label={appText('Query.title')}>
          <header className="filter-panel-heading">
            <span>{appText('Query.title')}</span>
          </header>
          <QueryEditor
            modelKey={tab.id}
            showSearch={false}
            query={draft}
            editor={state.queryEditor}
            onChange={(queryDraft, queryEditor) => set({ queryDraft, queryEditor })}
          />
          <footer className="filter-panel-actions">
            <Button
              size="S"
              theme="borderless"
              onClick={() =>
                set({
                  queryDraft: { ...draft, where: null, search: '', groupBy: [], orderBy: defaultOrder },
                  queryEditor: { mode: 'form' },
                })
              }
            >
              {appText('Query.reset')}
            </Button>
            <span className="grow" />
            <Button onClick={() => set({ queryDraft: undefined, queryEditor: { mode: 'form' }, showAdvanced: false })}>
              {appText('ui.cancel')}
            </Button>
            <Button theme="solid" disabled={!!draftInvalid} onClick={applyDraft}>
              {appText('Query.apply')}
            </Button>
          </footer>
        </section>
      )}
      {(invalid || failure) && <Banner type="danger" description={invalid || failure} />}
      {Object.keys(result.groups).length > 0 && (
        <div className="group-summary">
          {Object.entries(result.groups).map(([tuple, count]) => (
            <span className="chip" key={tuple}>
              {groupText(tuple)} · {count}
            </span>
          ))}
        </div>
      )}
      {loading && !result.films.length ? (
        <div className="empty-state">
          <Spin />
        </div>
      ) : !result.films.length ? (
        state.showAdvanced ? null : (
          <EmptyState
            title={appText(
              job && !terminal(job.state)
                ? 'Journey.discovering'
                : where || state.search
                  ? 'Journey.noMatches'
                  : 'Journey.noFilms',
            )}
            description={
              // First run: say what importing does before anything reads the user's storage.
              !where && !state.search && !(job && !terminal(job.state))
                ? appText('Journey.firstRun', {
                    online: String(app.data.settings.onlineMetadata),
                    dataDirectory: app.data.dataDirectory,
                  })
                : undefined
            }
          >
            <Button
              onClick={() => (where || state.search ? set({ where: null, search: '', page: 1 }) : setImportOpen(true))}
            >
              {appText(where || state.search ? 'LibraryPage.clearFilters' : 'Journey.import')}
            </Button>
          </EmptyState>
        )
      ) : state.layout === 'grid' ? (
        <div className="film-grid" ref={grid} style={{ '--poster-height': state.posterHeight + 'px' } as CSSProperties}>
          {result.films.map((film, index) => (
            <Fragment key={film.id + ':' + (film.groupKey ?? '')}>
              {film.groupKey != null && film.groupKey !== result.films[index - 1]?.groupKey && (
                <h3 className="film-group-heading">
                  {groupText(film.groupKey)}
                  <span className="form-help"> · {result.groups[film.groupKey] ?? ''}</span>
                </h3>
              )}
              <div className="selectable-film">
                {selecting && (
                  <Checkbox
                    checked={allResults || selected.includes(film.id)}
                    onChange={e => {
                      setAllResults(false);
                      setSelected(
                        e.target.checked ? [...new Set([...selected, film.id])] : selected.filter(id => id !== film.id),
                      );
                    }}
                  >
                    {appText('Journey.selectFilm', { name: film.presentation.title })}
                  </Checkbox>
                )}
                <FilmCard film={film} onPlay={() => play(film)} onDetail={() => detail(film)} />
              </div>
            </Fragment>
          ))}
        </div>
      ) : (
        <Table
          dataSource={result.films}
          pagination={false}
          loading={loading}
          columns={[
            ...(selecting
              ? [
                  {
                    title: appText('Journey.select'),
                    render: (_: unknown, f: Film) => (
                      <Checkbox
                        checked={allResults || selected.includes(f.id)}
                        onChange={e => {
                          setAllResults(false);
                          setSelected(
                            e.target.checked ? [...new Set([...selected, f.id])] : selected.filter(id => id !== f.id),
                          );
                        }}
                      >
                        {f.presentation.tabTitle}
                      </Checkbox>
                    ),
                  },
                ]
              : []),
            {
              title: appText('LibraryPage.film'),
              render: (_, f) => (
                <Button theme="borderless" onClick={() => detail(f)}>
                  {f.presentation.title}
                </Button>
              ),
            },
            ...columns.map(({ definition: d, placement: p }) => ({
              title: label(d),
              render: (_: unknown, f: Film) => (
                <TagValue definition={d} value={f.values[d.key]?.value} spec={d.display?.[p.view.split('.')[1]]} />
              ),
            })),
            {
              title: appText('LibraryPage.play'),
              render: (_, f) => (
                <Button
                  icon={<IconPlay />}
                  aria-label={appText('LibraryPage.play2') + f.presentation.title}
                  onClick={() => play(f)}
                />
              ),
            },
          ]}
        />
      )}
      {result.films.length < result.total && (
        <div
          className="pagination"
          ref={element => {
            if (!element) return;
            const observer = new IntersectionObserver(entries => {
              if (entries.some(entry => entry.isIntersecting) && !loading) {
                observer.disconnect();
                set({ page: state.page + 1 });
              }
            });
            observer.observe(element);
            return () => observer.disconnect();
          }}
        >
          <Button disabled={loading} onClick={() => set({ page: state.page + 1 })}>
            {appText('LibraryPage.loadMore', { shown: result.films.length, total: result.total })}
          </Button>
        </div>
      )}
      <Modal
        mode="exclusive"
        title={appText('LibraryPage.saveAsSmartList')}
        visible={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() =>
          action(async () => {
            if (!viewName.trim()) throw new Error(appText('LibraryPage.enterAName'));
            await call('view.save', {
              id: currentView?.id ?? crypto.randomUUID(),
              name: viewName.trim(),
              query: { ...query, offset: 0 },
            });
            if (currentView)
              app.update(tab.id, { title: viewName.trim(), params: { ...tab.params, query: { ...query, offset: 0 } } });
            setSaveOpen(false);
            await app.refresh();
          })
        }
      >
        <FormField label={appText('LibraryPage.name')}>
          <Input aria-label={appText('LibraryPage.name')} value={viewName} onChange={setViewName} />
        </FormField>
      </Modal>
      {importOpen && (
        <ImportDialog
          defaultLibraryId={query.libraryId ?? ''}
          close={() => setImportOpen(false)}
          imported={({ jobId, libraryId }) => {
            set({ jobId, where: undefined, search: '', page: 1 });
            if (query.libraryId && query.libraryId !== libraryId) {
              const id = 'library:' + libraryId;
              app.open({
                id,
                kind: 'library',
                title: app.data.libraries.find(l => l.id === libraryId)?.name ?? appText('Journey.imported'),
                params: { libraryId },
                state: { jobId },
              });
              app.patchState(id, previous => ({ ...previous, jobId, where: undefined, search: '', page: 1 }));
            }
          }}
        />
      )}
    </Page>
  );
}
