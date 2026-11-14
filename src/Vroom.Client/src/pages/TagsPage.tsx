import { configurationDependencies, relatedChanges, type RelatedConfigChanges } from '../tagging/config-related';
import { OperationPreview } from '../components/OperationPreview';
import { AutomationDialog } from '../tagging/AutomationDialog';
import { t as appText, translate } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Checkbox, SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2';
import { Button, Input, Select, Space, Modal, Banner, Spin } from '../ui';
import { Page, PageHeading, JobNotice } from '../components';
import { IconPlus, IconTasks, IconUndo, IconRedo } from '../icons';
import { action, useApp, useJob, useTabState } from '../context';
import { call } from '../api';
import type { WorkspaceTab } from '../workspace';
import { localize, ui } from '../tagging/i18n';
import { IssueList } from '../tagging/IssueList';
import { ConfigExchange } from '../tagging/ConfigExchange';
import { TermManager } from '../tagging/TermManager';
import { DefinitionListItem } from '../tagging/DefinitionListItem';
import { DefinitionPreview } from '../tagging/DefinitionPreview';
import { InfoPopover } from '../components/InfoPopover';
import { valueTypes, type ValueType } from '../tagging/definition-designer';
import { unsharedListDraft } from '../tagging/option-list';
import { newConfigDrafts } from '../tagging/config-create';
import { SchemaIcon } from '../icon-catalog';
import { DefinitionDesigner } from '../tagging/DefinitionDesigner';
import { ConfigForm } from '../tagging/ConfigForm';
import { advancedConfigKinds, configKindLabels, configText, configFieldMetadata } from '../tagging/config-editor';
import type { Definition } from '../tagging/types';
import type { ConfigNavigationState } from '../tagging/config-tree';
import {
  breakConfigEditGroup,
  configDraftState,
  configHistory,
  hasRelatedDraftChanges,
  recordConfigEdit,
  sameConfiguration,
  travelConfigHistory,
  type ConfigDraftState,
  type ConfigHistory,
} from '../tagging/config-history';
const JsonEditor = lazy(() => import('../tagging/JsonEditor'));

/** One workspace for fields, their value collections and the remaining configuration. */
export function TagsPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp(),
    pack = app.data.tagging.package;
  const word = (key: string) => ui(key, app.locale),
    label = (v: any) => localize(v, app.locale, pack),
    tr = (key: string) => translate(key, app.locale);
  const developer = localStorage.getItem('vroom.developer') === 'true';
  const [saved, set] = useTabState(tab, {
    catalogMode: 'definitions',
    termVocabulary: '',
    termSelected: '',
    selected: '',
    kind: 'definition',
    search: '',
    mode: 'form',
    drafts: {} as Record<string, string>,
    draftHistories: {} as Record<string, ConfigHistory>,
    historyError: '',
    termProfileDrafts: {} as Record<string, unknown>,
    baseGenerations: {} as Record<string, number>,
    jobId: '',
    publishingId: '',
    publishingJson: '',
    publishingChanges: {} as Record<string, string>,
    configNavigation: {} as Record<string, ConfigNavigationState>,
  });
  // Fields edit definitions; Configuration edits every other kind (protocol-level kinds in developer mode).
  const tagsOnly = saved.catalogMode !== 'configuration';
  const kinds = tagsOnly
    ? ['definition']
    : Object.keys(configKindLabels).filter(
        kind => kind !== 'definition' && (developer || !advancedConfigKinds.has(kind)),
      );
  const state = kinds.includes(saved.kind) ? saved : { ...saved, kind: kinds[0], selected: '' };
  const listRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState('');
  const [baseline, setBaseline] = useState<any>(),
    [preview, setPreview] = useState<any>(),
    [issues, setIssues] = useState<any[]>();
  const [recalculate, setRecalculate] = useState(false);
  const [exchange, setExchange] = useState(false);
  const [creating, setCreating] = useState(false),
    [newName, setNewName] = useState(''),
    [newKind, setNewKind] = useState('definition'),
    [newType, setNewType] = useState<ValueType>('text');
  const id = state.kind + '/' + state.selected;
  const history = configHistory(configDraftState(state), id);
  const json =
    state.drafts[id] ??
    (baseline && Object.hasOwn(baseline, 'effective') ? JSON.stringify(baseline.effective, null, 2) : '');
  let parsed: any;
  let parseError = '';
  try {
    if (json || state.drafts[id] !== undefined) parsed = JSON.parse(json);
  } catch {
    parseError = tr('TagsPage.completeTheJsonInCodeModeBefore');
  }
  const draft = state.kind === 'definition' ? (parsed as Definition | undefined) : undefined;
  const job = useJob(state.jobId, () => {
    void app.refresh();
    setPreview(undefined);
    app.patchState(tab.id, current => {
      const drafts = { ...((current.drafts as Record<string, string>) ?? {}) },
        baseGenerations = { ...((current.baseGenerations as Record<string, number>) ?? {}) },
        draftHistories = { ...((current.draftHistories as Record<string, ConfigHistory>) ?? {}) };
      // Only accepted, unchanged snapshots end a draft history. Newer edits remain retained.
      for (const [key, value] of Object.entries((current.publishingChanges as Record<string, string>) ?? {}))
        if (drafts[key] === value) {
          delete drafts[key];
          delete baseGenerations[key];
          delete draftHistories[key];
        }
      return {
        ...current,
        drafts,
        baseGenerations,
        draftHistories,
        historyError: '',
        publishingId: '',
        publishingJson: '',
        publishingChanges: {},
      };
    });
  });
  const configured =
    state.kind === 'definition'
      ? pack.definitions.map(d => {
          let current = d;
          try {
            const text = state.drafts['definition/' + d.key];
            if (text) current = JSON.parse(text);
          } catch {
            /* Keep the published label while JSON is incomplete. */
          }
          return {
            key: d.key,
            label: label(current.label) || label(d.label),
            enabled: current.enabled !== false,
            component: current.input?.component ?? d.input.component,
          };
        })
      : state.kind === 'catalogPolicy'
        ? [{ key: 'default', label: tr('TagsPage.defaultRules'), enabled: true, component: '' }]
        : Object.keys(
            state.kind === 'message'
              ? pack.i18n.messages
              : state.kind.startsWith('ui.')
                ? (pack.ui[state.kind.slice(3)] ?? {})
                : (pack[state.kind] ?? {}),
          ).map(key => ({ key, label: label(pack[state.kind]?.[key]?.label) || key, enabled: true, component: '' }));
  const entries = [...configured];
  for (const [key, text] of Object.entries(state.drafts))
    if (key.startsWith(state.kind + '/') && !entries.some(e => e.key === key.slice(state.kind.length + 1))) {
      try {
        const d = JSON.parse(text);
        entries.push({
          key: key.slice(state.kind.length + 1),
          label: label(d.label) || key.slice(state.kind.length + 1),
          enabled: d.enabled !== false,
          component: d.input?.component ?? '',
        });
      } catch {
        /* Keep malformed drafts in the editor. */
      }
    }
  entries.sort((a, b) => a.label.localeCompare(b.label, app.locale));
  const filtered = entries.filter(d => `${d.key} ${d.label}`.toLowerCase().includes(state.search.toLowerCase()));
  const entryDefinition = (key: string) => {
    if (state.kind !== 'definition') return undefined;
    const text = state.drafts['definition/' + key];
    if (text !== undefined)
      try {
        return JSON.parse(text);
      } catch {
        /* Use the published scope while JSON is incomplete. */
      }
    return pack.definitions.find(d => d.key === key);
  };
  useEffect(() => {
    if (saved.kind !== state.kind || (!state.selected && entries.length))
      set({ kind: state.kind, selected: entries[0]?.key ?? '' });
  }, [saved.kind, state.kind, state.selected, pack]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const active = list.querySelector('[aria-pressed=true]');
      if (!active) return;
      const item = active.getBoundingClientRect(),
        box = list.getBoundingClientRect();
      if (item.top < box.top) list.scrollTop -= box.top - item.top;
      else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [id]);
  useEffect(() => {
    if (!state.selected) return;
    let disposed = false;
    setBaseline(undefined);
    setLoadError('');
    if (!configured.some(e => e.key === state.selected)) return;
    void call('config.get', { kind: state.kind, key: state.selected })
      .then((r: any) => {
        if (!disposed) setBaseline({ ...r, editorId: id });
      })
      .catch(e => {
        if (!disposed) setLoadError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [id, app.data.tagging.generation]);
  useEffect(() => {
    set({}, Object.keys(state.drafts).length > 0 || Object.keys(state.termProfileDrafts).length > 0);
  }, [Object.keys(state.drafts).join('|'), Object.keys(state.termProfileDrafts).join('|')]);
  const edit = (value: string, collectionChanges?: RelatedConfigChanges, mode = state.mode) => {
    if (!collectionChanges && sameConfiguration(json, value)) return;
    const at = Date.now(),
      published =
        baseline?.editorId === id && baseline.effective !== undefined
          ? JSON.stringify(baseline.effective, null, 2)
          : undefined;
    app.patchState(tab.id, current => {
      const before = configDraftState(current as Partial<ConfigDraftState>),
        drafts = { ...before.drafts, [id]: value },
        baseGenerations = {
          ...before.baseGenerations,
          [id]: before.baseGenerations[id] ?? baseline?.generation ?? app.data.tagging.generation,
        };
      // Capture cleanup and related resources in the same undo transaction.
      const previous = unsharedListDraft(id, { ...before.drafts, [id]: before.drafts[id] ?? json }, pack);
      if (previous)
        try {
          if (
            JSON.parse(value).value?.vocabulary !== previous.slice(13) &&
            JSON.parse(drafts[previous]).items.length === 0
          ) {
            delete drafts[previous];
            delete baseGenerations[previous];
          }
        } catch {
          /* Retain incomplete JSON and nonempty lists. */
        }
      for (const collection of relatedChanges(collectionChanges)) {
        const relatedId = collection.kind + '/' + collection.key,
          text = JSON.stringify(collection.value, null, 2),
          effective = collection.kind.startsWith('ui.')
            ? pack.ui[collection.kind.slice(3)]?.[collection.key]
            : pack[collection.kind]?.[collection.key];
        drafts[relatedId] = text;
        baseGenerations[relatedId] = baseGenerations[relatedId] ?? baseGenerations[id];
        if (effective !== undefined && sameConfiguration(text, JSON.stringify(effective))) {
          delete drafts[relatedId];
          delete baseGenerations[relatedId];
        }
      }
      const next = { ...before, drafts, baseGenerations };
      const relatedIds = relatedChanges(collectionChanges).map(c => c.kind + '/' + c.key);
      const hasRelated =
        hasRelatedDraftChanges(before, id, next) ||
        relatedIds.some(relatedId => drafts[relatedId] !== undefined && drafts[relatedId] !== before.drafts[relatedId]);
      if (published !== undefined && sameConfiguration(value, published) && !hasRelated) {
        delete drafts[id];
        delete baseGenerations[id];
      }
      const recorded = recordConfigEdit(before, id, next, { mode, at, baseline: published });
      return { ...current, ...recorded, historyError: '' };
    });
    setPreview(undefined);
  };
  const travel = (direction: 'undo' | 'redo') => {
    app.patchState(tab.id, current => {
      const result = travelConfigHistory(configDraftState(current as Partial<ConfigDraftState>), id, direction);
      return {
        ...current,
        ...result.state,
        historyError: result.conflict
          ? tr('TagsPage.aRelatedConfigurationDraftChangedResolveIts') + ' (' + result.conflict + ')'
          : '',
      };
    });
    setPreview(undefined);
  };
  const navigate = (change: Partial<typeof state>) => {
    app.patchState(tab.id, current => ({
      ...current,
      ...breakConfigEditGroup(configDraftState(current as Partial<ConfigDraftState>), id),
      ...change,
      historyError: '',
    }));
    setPreview(undefined);
  };
  const onHistoryKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.nativeEvent.isComposing) return;
    const target = event.target as Element;
    if (target.nodeType === 1) {
      if (target.closest('[role="dialog"], .definition-preview-rail, .designer-preview-dock, .find-widget')) return;
      // Staged text inputs keep their native local undo until their own action commits.
      if (target.matches('input, textarea, [contenteditable="true"]') && !target.closest('.monaco-editor')) return;
    }
    const key = event.key.toLowerCase(),
      direction =
        key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && !event.shiftKey ? 'redo' : undefined;
    if (direction) {
      event.preventDefault();
      event.stopPropagation();
      travel(direction);
    }
  };
  const draftVocabularies = { ...pack.vocabularies };
  for (const [key, value] of Object.entries(state.drafts))
    if (key.startsWith('vocabularies/'))
      try {
        draftVocabularies[key.slice(13)] = JSON.parse(value);
      } catch {
        /* Keep malformed JSON visible in the advanced editor. */
      }
  const draftSources = { ...pack.sources };
  for (const [key, value] of Object.entries(state.drafts))
    if (key.startsWith('sources/'))
      try {
        draftSources[key.slice(8)] = JSON.parse(value);
      } catch {
        /* Invalid source drafts are checked before publication. */
      }
  const draftPlacementOrder: Record<string, string[]> = { ...pack.ui.placementOrder };
  for (const [key, value] of Object.entries(state.drafts))
    if (key.startsWith('ui.placementOrder/'))
      try {
        draftPlacementOrder[key.slice(18)] = JSON.parse(value);
      } catch {
        /* Incomplete JSON stays in the editor. */
      }
  const draftRules = { ...pack.rules };
  for (const [key, value] of Object.entries(state.drafts))
    if (key.startsWith('rules/'))
      try {
        draftRules[key.slice(6)] = JSON.parse(value);
      } catch {
        /* Incomplete JSON stays in the editor. */
      }
  const applyPreview = async (preview: any) => {
    const result = await call<{ jobId: string }>('config.apply', {
      previewToken: preview.previewToken,
      expectedGeneration: preview.generation,
    });
    set({
      jobId: result.jobId,
      publishingId: preview.editorId,
      publishingJson: preview.editorJson,
      publishingChanges: preview.publishingChanges,
    });
    setPreview(undefined);
  };
  const ruleChanges = () => [
    { kind: 'definition', key: state.selected, value: JSON.parse(json) },
    ...Object.entries(state.drafts)
      .filter(([key]) => key === 'vocabularies/' + draft?.value?.vocabulary)
      .map(([key, text]) => ({ kind: 'vocabularies', key: key.slice(13), value: JSON.parse(text) })),
  ];
  const savePreview = (restore = false) =>
    action(async () => {
      const changes: any[] = [
          { kind: state.kind, key: state.selected, value: restore ? undefined : JSON.parse(json), restore },
        ],
        publishingChanges: Record<string, string> = { [id]: json };
      const dependencies = configurationDependencies(state.kind, parsed, draftSources);
      if (!restore)
        for (const dependency of new Set(dependencies)) {
          const text = state.drafts[dependency];
          if (text) {
            if (
              state.baseGenerations[dependency] !== undefined &&
              state.baseGenerations[dependency] !==
                (state.baseGenerations[id] ?? baseline?.generation ?? app.data.tagging.generation)
            )
              throw new Error(tr('TagsPage.aRelatedDraftUsesADifferentGeneration'));
            const [kind, ...key] = dependency.split('/');
            changes.unshift({ kind, key: key.join('/'), value: JSON.parse(text) });
            publishingChanges[dependency] = text;
          }
        }
      const result = await call<any>('config.preview', {
        layer: 'user',
        expectedGeneration: state.baseGenerations[id] ?? baseline?.generation ?? app.data.tagging.generation,
        changes,
      });
      const preview = { ...result, editorId: id, editorJson: json, publishingChanges };
      if (result.impact?.requiresReview) setPreview(preview);
      else await applyPreview(preview);
    });
  const create = () => {
    const {
      key,
      id: createdId,
      drafts,
      baseGenerations,
    } = newConfigDrafts(newKind, newName, newType, pack, app.data.tagging.generation);
    const at = Date.now();
    setBaseline(undefined);
    app.patchState(tab.id, current => {
      const before = configDraftState(current as Partial<ConfigDraftState>),
        next = {
          ...before,
          drafts: { ...before.drafts, ...drafts },
          baseGenerations: { ...before.baseGenerations, ...baseGenerations },
        };
      return {
        ...current,
        ...recordConfigEdit(before, createdId, next, { mode: 'create', at }),
        // Stay in the section the new object belongs to.
        catalogMode: newKind === 'definition' ? 'definitions' : 'configuration',
        selected: key,
        kind: newKind,
        mode: 'form',
        search: '',
        historyError: '',
      };
    });
    setCreating(false);
    setNewName('');
  };
  const discard = () =>
    Modal.confirm({
      title: tr('TagsPage.discardThisDraft'),
      content: tr('TagsPage.thePublishedConfigurationWillRemainUnchanged'),
      okText: tr('TagsPage.discardDraft'),
      onOk: () => {
        app.patchState(tab.id, current => {
          const drafts = { ...((current.drafts as Record<string, string>) ?? {}) },
            baseGenerations = { ...((current.baseGenerations as Record<string, number>) ?? {}) },
            draftHistories = { ...((current.draftHistories as Record<string, ConfigHistory>) ?? {}) };
          const related = unsharedListDraft(id, drafts, pack);
          if (related) {
            delete drafts[related];
            delete baseGenerations[related];
            delete draftHistories[related];
          }
          delete drafts[id];
          delete baseGenerations[id];
          delete draftHistories[id];
          return {
            ...current,
            drafts,
            baseGenerations,
            draftHistories,
            historyError: '',
            ...(!configured.some(d => d.key === state.selected) ? { selected: '' } : {}),
          };
        });
        setPreview(undefined);
      },
    });
  let undoneLabel = '';
  for (const transaction of history.redo)
    for (const change of transaction.changes)
      if (change.id === id && change.after.text)
        try {
          undoneLabel = label(JSON.parse(change.after.text).label);
        } catch {
          /* Incomplete JSON remains available for redo. */
        }
  const undoneNewDraft = !json && !configured.some(e => e.key === state.selected) && history.redo.length > 0;
  const selectedLabel =
    label(parsed?.label) || entries.find(e => e.key === state.selected)?.label || undoneLabel || state.selected;
  return (
    <Page variant="workspace" className="tag-manager-page">
      <PageHeading
        title={tr('TagsPage.tagManager')}
        navigation={
          <SegmentedControl
            aria-label={tr('TagsPage.tagManagerContent')}
            selectedKey={state.catalogMode}
            onSelectionChange={key => {
              set({ catalogMode: String(key), selected: '', search: '' });
              setBaseline(undefined);
            }}
          >
            <SegmentedControlItem id="definitions">{tr('TagsPage.definitions')}</SegmentedControlItem>
            <SegmentedControlItem id="values">{tr('TagsPage.values')}</SegmentedControlItem>
            <SegmentedControlItem id="configuration">{tr('TagsPage.configurationSection')}</SegmentedControlItem>
          </SegmentedControl>
        }
      >
        {!!tab.state.originTab && app.workspace.tabs.some(t => t.id === tab.state.originTab) && (
          <Button theme="borderless" onClick={() => app.activate(String(tab.state.originTab))}>
            {appText('Journey.backToFilm')}
          </Button>
        )}
        <Button onClick={() => setExchange(true)}>{tr('TagsPage.importExport')}</Button>
        {state.catalogMode !== 'values' && (
          <Button
            icon={<IconPlus />}
            theme="solid"
            onClick={() => {
              setNewKind(tagsOnly ? 'definition' : state.kind === 'vocabularies' ? 'vocabularies' : 'groups');
              setNewType('text');
              setCreating(true);
            }}
          >
            {tr(tagsOnly ? 'TagsPage.newSchema' : 'TagsPage.newConfiguration')}
          </Button>
        )}
      </PageHeading>
      {app.data.tagging.warning && (
        <Banner
          type="warning"
          title={appText('Tagging.systemUpdateConflictTitle')}
          description={appText('Tagging.systemUpdateConflict', {
            cause: appText('error.' + app.data.tagging.warning.cause),
            path: app.data.tagging.warning.path || '/',
          })}
        />
      )}
      {app.data.tagging.issueCount > 0 && (
        <Banner
          type="warning"
          description={
            <Space>
              {word('warnings')}
              <Button onClick={() => action(async () => setIssues(await call<any[]>('issues.list')))}>
                {app.data.tagging.issueCount}
              </Button>
            </Space>
          }
        />
      )}
      {state.catalogMode === 'values' ? (
        <TermManager tab={tab} />
      ) : (
        <div className="schema-management">
          <aside className="schema-definition-list">
            <div className="definition-list-tools">
              {!tagsOnly && (
                <FormField label={tr('TagsPage.configurationKind')}>
                  <Select
                    aria-label={tr('TagsPage.configurationKind')}
                    value={state.kind}
                    onChange={v => {
                      navigate({ kind: String(v), selected: '', search: '' });
                      setBaseline(undefined);
                    }}
                    optionList={kinds.map(value => ({ value, label: configText(configKindLabels[value], app.locale) }))}
                  />
                </FormField>
              )}
              <Input
                showClear
                aria-label={word('search')}
                placeholder={word('search')}
                value={state.search}
                onChange={search => set({ search })}
              />
            </div>
            <div ref={listRef} className="definition-list-items" aria-label={word(tagsOnly ? 'definition' : 'config')}>
              {filtered.map(d => (
                <DefinitionListItem
                  key={d.key}
                  label={d.label}
                  component={d.component}
                  enabled={d.enabled}
                  definition={entryDefinition(d.key)}
                  isDefinition={state.kind === 'definition'}
                  dirty={state.drafts[state.kind + '/' + d.key] !== undefined}
                  selected={state.selected === d.key}
                  locale={app.locale}
                  onSelect={() => {
                    if (d.key === state.selected) return;
                    navigate({ selected: d.key });
                    setBaseline(undefined);
                  }}
                />
              ))}
              {!filtered.length && <p className="muted">{tr('TagsPage.noMatchingConfiguration')}</p>}
            </div>
            <div className="definition-list-count">
              {tagsOnly ? (
                appText('TagsPage.schemaCount', { count: filtered.length })
              ) : (
                <>
                  {filtered.length} {tr('TagsPage.configurations')}
                </>
              )}
            </div>
          </aside>
          <section className="schema-definition-editor" onKeyDownCapture={onHistoryKeyDown}>
            {state.selected ? (
              <>
                <header className="definition-editor-heading">
                  <div>
                    <h2>{selectedLabel}</h2>
                    <span className="muted">
                      {baseline?.user
                        ? tr('TagsPage.userConfiguration')
                        : baseline?.system
                          ? tr('TagsPage.builtInConfiguration')
                          : tr('TagsPage.unpublishedDraft')}
                    </span>
                  </div>
                  <div className="definition-heading-controls">
                    {draft && (
                      <div className="definition-status">
                        <span>{tr('TagsPage.definitionStatus')}</span>
                        <InfoPopover label={tr('TagsPage.definitionStatusHelp')}>
                          <p>{label(configFieldMetadata(['enabled'])?.description)}</p>
                        </InfoPopover>
                        <Checkbox
                          aria-label={tr('TagsPage.enableThisDefinition')}
                          isSelected={draft.enabled !== false}
                          onChange={enabled => edit(JSON.stringify({ ...draft, enabled }, null, 2))}
                        >
                          {draft.enabled !== false ? appText('TagsPage.enabled') : appText('TagsPage.disabled')}
                        </Checkbox>
                      </div>
                    )}
                    <Space className="definition-history-actions">
                      <Button
                        size="S"
                        icon={<IconUndo />}
                        disabled={!history.undo.length}
                        title={tr('TagsPage.undoThisConfigurationDraftEdit')}
                        onClick={() => travel('undo')}
                      >
                        {tr('TagsPage.undo')}
                      </Button>
                      <Button
                        size="S"
                        icon={<IconRedo />}
                        disabled={!history.redo.length}
                        title={tr('TagsPage.redoThisConfigurationDraftEdit')}
                        onClick={() => travel('redo')}
                      >
                        {tr('TagsPage.redo')}
                      </Button>
                    </Space>
                    {/* Form is the everyday editor; structure and JSON views are developer tools. */}
                    {(developer || state.mode !== 'form' || !!parseError) && (
                      <SegmentedControl
                        aria-label={tr('TagsPage.editorMode')}
                        selectedKey={parseError ? 'json' : state.mode}
                        onSelectionChange={key => navigate({ mode: String(key) })}
                      >
                        <SegmentedControlItem id="form" isDisabled={!!parseError}>
                          {tr('TagsPage.form')}
                        </SegmentedControlItem>
                        <SegmentedControlItem id="structure" isDisabled={!!parseError}>
                          {tr('TagsPage.structure')}
                        </SegmentedControlItem>
                        <SegmentedControlItem id="json">JSON</SegmentedControlItem>
                      </SegmentedControl>
                    )}
                  </div>
                </header>
                <div
                  className={
                    'definition-editor-workspace' +
                    (state.mode !== 'form' && draft?.input && draft.value?.schema ? ' has-preview' : '')
                  }
                >
                  <div
                    className={
                      'definition-editor-content' +
                      (state.mode === 'form' && draft && !parseError && !undoneNewDraft ? ' has-form-designer' : '')
                    }
                  >
                    {loadError && <Banner type="danger" description={loadError} />}{' '}
                    {state.historyError && <Banner type="warning" description={state.historyError} />}{' '}
                    {parseError && <Banner type="warning" description={parseError} />}{' '}
                    {undoneNewDraft ? (
                      <p className="muted">{tr('TagsPage.theNewDraftWasUndoneRedoTo')}</p>
                    ) : state.mode === 'json' || parseError ? (
                      <>
                        <div className="definition-code-key">
                          <code>{state.selected}</code>
                          <span>{tr('TagsPage.1DenotesComponentProtocolVersion1')}</span>
                        </div>
                        <Suspense fallback={<Spin />}>
                          <JsonEditor
                            key={id}
                            modelKey={id}
                            value={json}
                            schema={state.kind}
                            onChange={value => edit(value, undefined, 'json')}
                          />
                        </Suspense>
                      </>
                    ) : parsed ? (
                      draft && state.mode === 'form' ? (
                        <DefinitionDesigner
                          key={id}
                          value={draft}
                          vocabularies={draftVocabularies}
                          placementOrder={draftPlacementOrder}
                          sources={draftSources}
                          rules={draftRules}
                          changes={ruleChanges}
                          onChange={(value, collection) => edit(JSON.stringify(value, null, 2), collection)}
                        />
                      ) : (
                        <ConfigForm
                          key={id}
                          kind={state.kind}
                          value={parsed}
                          lockedKey
                          navigation={state.configNavigation?.[id]}
                          onNavigationChange={navigation =>
                            set({ configNavigation: { ...state.configNavigation, [id]: navigation } })
                          }
                          onChange={value => edit(JSON.stringify(value, null, 2))}
                        />
                      )
                    ) : (
                      <Spin />
                    )}
                  </div>
                  {state.mode !== 'form' && draft?.input && draft.value?.schema && draft.label && (
                    <aside className="definition-preview-rail">
                      <DefinitionPreview
                        key={'preview:' + id}
                        definition={draft}
                        catalog={{
                          ...pack,
                          vocabularies: draftVocabularies,
                          definitions: [...pack.definitions.filter(d => d.key !== draft.key), draft],
                        }}
                      />
                      {draft?.value?.vocabulary && pack.vocabularies?.[draft.value.vocabulary] && (
                        <Button
                          theme="borderless"
                          onClick={() =>
                            set({ catalogMode: 'values', termVocabulary: draft.value.vocabulary, termSelected: '' })
                          }
                        >
                          {tr('TagsPage.editOptionProfilesAndRelationships')}
                        </Button>
                      )}
                    </aside>
                  )}
                </div>
                <footer className="definition-editor-footer">
                  <Space>
                    <span className="muted">
                      {state.drafts[id] !== undefined
                        ? tr('TagsPage.draftRetainedPublishToApply')
                        : undoneNewDraft
                          ? tr('TagsPage.draftUndone')
                          : tr('TagsPage.publishedConfiguration')}
                    </span>
                    {state.jobId && (
                      <Button
                        theme="borderless"
                        size="S"
                        aria-label={tr('TagsPage.viewPublishingTask')}
                        title={tr('TagsPage.viewPublishingTask')}
                        icon={<IconTasks />}
                        onClick={() => app.open({ id: 'jobs', kind: 'jobs', title: tr('TagsPage.backgroundTasks') })}
                      />
                    )}
                  </Space>
                  <Space>
                    {draft &&
                      [...(draft.initialization ?? []), ...(draft.automation ?? [])].some(
                        r => r.executor === 'value.match@1',
                      ) &&
                      state.drafts[id] === undefined && (
                        <Button disabled={!!state.publishingId} onClick={() => setRecalculate(true)}>
                          {appText('Journey.applyExisting')}
                        </Button>
                      )}
                    {state.drafts[id] !== undefined && (
                      <Button theme="borderless" onClick={discard}>
                        {tr('TagsPage.discardDraft')}
                      </Button>
                    )}
                    {baseline?.user && (
                      <Button theme="borderless" onClick={() => savePreview(true)}>
                        {baseline?.system ? word('reset') : tr('TagsPage.removeUserConfiguration')}
                      </Button>
                    )}
                    <Button disabled={!parsed || !!parseError} theme="solid" onClick={() => savePreview()}>
                      {appText('Journey.apply')}
                    </Button>
                  </Space>
                </footer>
              </>
            ) : (
              <div className="empty-state">{tr('TagsPage.selectAConfigurationToEdit')}</div>
            )}
          </section>
        </div>
      )}
      {job && job.state !== 'completed' && <JobNotice job={job} />}
      <Modal
        mode="exclusive"
        title={tr(tagsOnly ? 'TagsPage.newSchema' : 'TagsPage.newConfiguration')}
        visible={creating}
        onCancel={() => setCreating(false)}
        footer={
          <Space>
            <Button onClick={() => setCreating(false)}>{word('cancel')}</Button>
            <Button theme="solid" disabled={!newName.trim()} onClick={create}>
              {tr('TagsPage.create')}
            </Button>
          </Space>
        }
      >
        <FormLayout>
          {!tagsOnly && (
            <FormField layout="row" label={tr('TagsPage.kind')}>
              <Select
                aria-label={tr('TagsPage.configurationKind')}
                value={newKind}
                optionList={['groups', 'vocabularies'].map(value => ({
                  value,
                  label: configText(configKindLabels[value], app.locale),
                }))}
                onChange={v => setNewKind(String(v))}
              />
            </FormField>
          )}
          {newKind === 'definition' && (
            <FormField layout="row" label={tr('TagsPage.valueType')}>
              <Select
                aria-label={tr('TagsPage.newTagValueType')}
                value={newType}
                optionList={Object.entries(valueTypes).map(([value, p]) => ({
                  value,
                  label: label(p.label),
                  icon: <SchemaIcon slot="icon" name={p.icon} />,
                }))}
                onChange={v => setNewType(String(v) as ValueType)}
              />
            </FormField>
          )}
          <FormField layout="row" label={tr('TagsPage.name')}>
            <Input
              aria-label={tr(tagsOnly ? 'TagsPage.tagName' : 'TagsPage.name')}
              value={newName}
              onChange={setNewName}
            />
          </FormField>
        </FormLayout>
      </Modal>
      {exchange && <ConfigExchange close={() => setExchange(false)} />}
      <Modal
        mode="exclusive"
        title={word('preview')}
        visible={!!preview}
        onCancel={() => setPreview(undefined)}
        onOk={() =>
          action(async () => {
            const result = await call<{ jobId: string }>('config.apply', {
              previewToken: preview.previewToken,
              expectedGeneration: preview.generation,
            });
            set({
              jobId: result.jobId,
              publishingId: preview.editorId,
              publishingJson: preview.editorJson,
              publishingChanges: preview.publishingChanges,
            });
            setPreview(undefined);
          })
        }
        okText={word('apply')}
      >
        <p>
          {appText('Journey.configImpact', {
            count: preview?.impact?.changedValues ?? 0,
            invalid: preview?.impact?.newInvalid ?? 0,
          })}
        </p>
        <OperationPreview value={preview?.valueChanges} />
        {preview?.impact?.automaticChanged && <p>{appText('Journey.rulesNewImports')}</p>}
        <details className="form-disclosure">
          <summary>{tr('TagsPage.validationDetails')}</summary>
          <IssueList issues={preview?.issues} />
        </details>
      </Modal>
      <Modal
        mode="modeless"
        title={tr('TagsPage.incompatibleAnnotations')}
        visible={!!issues}
        onCancel={() => setIssues(undefined)}
        footer={<Button onClick={() => setIssues(undefined)}>{word('close')}</Button>}
      >
        <IssueList issues={issues} />
      </Modal>
      {recalculate && draft && (
        <AutomationDialog definition={draft} close={() => setRecalculate(false)} queued={jobId => set({ jobId })} />
      )}
    </Page>
  );
}
