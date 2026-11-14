import { CandidateList } from './CandidateList';
import { ExternalPlayerDialog } from '../ExternalPlayerDialog';
import { MediaResources } from '../MediaResources';
import { t as appText } from '../i18n';
import { FormField } from '../components/FormLayout';
import { supportsTarget } from './annotation-targets';
import { useEffect, useRef, useState } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2';
import { Button, Input, InputNumber, Select, Space, TextArea, Banner, Modal, Toast } from '../ui';
import { action, useApp, useJob, useTabState } from '../context';
import { JobNotice } from '../components';
import { FieldInfo } from './FieldInfo';
import { useAnnotationEditor } from './useAnnotationEditor';
import { call, startJob } from '../api';
import { terminal, type Film, type FilmDetail } from '../types';
import type { WorkspaceTab } from '../workspace';
import { localize, ui } from './i18n';
import { TagInput, TagValue, SchemaIcon } from './Inputs';
import { evaluate } from './expression';
import {
  whole,
  scopeKey,
  type AnnotationRecord,
  type Definition,
  type Json,
  type LayoutNode,
  type Scope,
  type Placement,
} from './types';

export { placements } from './LayoutFrame';
import { LayoutFrame, placements } from './LayoutFrame';
import { hasSlotContent } from './slot-content';
import { RibbonLayout } from './RibbonLayout';
import type { RibbonState } from '../components/Ribbon';
const displaySpec = (d: Definition, p: Placement) => d.display?.[p.view.split('.')[1]] ?? d.display?.default;
export function Slot({
  film,
  region,
  onChanged,
  className,
  actionSize,
}: {
  film: Film;
  region: string;
  onChanged?(): void;
  className?: string;
  actionSize?: 'S' | 'M' | 'L';
}) {
  const app = useApp();
  const pack = app.data.tagging.package;
  const entries = placements(pack, region).filter(({ definition: d, placement: p }) => {
    const spec = displaySpec(d, p);
    return hasSlotContent(
      film.values[d.key]?.value,
      p.mode === 'edit' && d.writes?.manual !== false && spec?.component === 'icon-toggle@1',
      localize(spec?.props?.emptyText, app.locale, pack),
    );
  });
  if (!entries.length) return null;
  const content = entries.map(({ definition: d, placement: p }) => {
    const entry = film.values[d.key];
    const spec = displaySpec(d, p);
    const editable = p.mode === 'edit' && d.writes?.manual !== false;
    if (editable && spec?.component === 'icon-toggle@1')
      return (
        <Button
          key={d.key}
          theme="borderless"
          size={actionSize}
          aria-label={localize(entry?.value ? spec.props?.trueLabel : spec.props?.falseLabel, app.locale, pack)}
          aria-pressed={Boolean(entry?.value)}
          icon={<SchemaIcon name={entry?.value ? spec.props?.trueIcon : spec.props?.falseIcon} />}
          onClick={() =>
            action(async () => {
              await call('annotations.batch', {
                expectedGeneration: app.data.tagging.generation,
                idempotencyKey: crypto.randomUUID(),
                writes: [
                  {
                    subject: { kind: 'film', id: film.id },
                    scope: whole,
                    tagKey: d.key,
                    value: !entry?.value,
                    expectedRevision: entry?.revision ?? 0,
                  },
                ],
              });
              // The change feed refreshes lists showing this film; no full bootstrap reload.
              onChanged?.();
            })
          }
        />
      );
    return <TagValue key={d.key} definition={d} value={entry?.value} spec={spec} />;
  });
  return className ? <span className={className}>{content}</span> : <>{content}</>;
}
interface Draft {
  value: Json;
  revision: number;
  operation?: string;
}
export function SchemaAction({
  config,
  label,
  disabled,
  onClick,
  selected,
  danger,
  badge,
}: {
  config: { command: string; icon?: string; presentation?: string; appearance?: string };
  label: string;
  disabled?: boolean;
  onClick(): void;
  selected?: boolean;
  danger?: boolean;
  badge?: number;
}) {
  const iconOnly = config.presentation === 'icon' && !!config.icon;
  return (
    <Button
      aria-label={label}
      title={iconOnly ? label : undefined}
      size={iconOnly ? 'S' : undefined}
      className={config.appearance === 'quiet' ? 'schema-action-quiet' : undefined}
      disabled={disabled}
      aria-pressed={selected}
      type={danger ? 'danger' : undefined}
      theme={config.appearance === 'quiet' ? 'borderless' : config.command === 'form.submit' ? 'solid' : undefined}
      icon={config.icon ? <SchemaIcon name={config.icon} /> : undefined}
      onClick={onClick}
    >
      {iconOnly ? undefined : (
        <>
          {label}
          {badge != null && <span className="command-count">{badge}</span>}
        </>
      )}
    </Button>
  );
}
interface SurfaceProps {
  surface: string;
  detail: FilmDetail;
  tab: WorkspaceTab;
  reload(): Promise<void>;
  position?: number;
  seek?(seconds: number): void;
  inPoint?: number;
  outPoint?: number | null;
}
export function Surface({ surface, detail, tab, reload, position = 0, seek, inPoint, outPoint }: SurfaceProps) {
  const app = useApp();
  const snapshot = app.data.tagging;
  const pack = snapshot.package;
  const film = detail.film;
  const profile = pack.ui.layouts[pack.ui.surfaceBindings[surface]];
  const t = (v: any) => localize(v, app.locale, pack);
  const word = (key: string) => ui(key, app.locale);
  const [saved, set] = useTabState(tab, {
    annotationScope: whole as Scope,
    scopeDrafts: {} as Record<string, Scope>,
    fieldDrafts: {} as Record<string, Draft>,
    extraFields: {} as Record<string, string[]>,
    annotationNotes: {} as Record<string, string>,
    backgroundTask: undefined as { filmId: string; id: string } | undefined,
    ribbons: {} as Record<string, RibbonState>,
  });
  const taskId = saved.backgroundTask?.filmId === film.id ? saved.backgroundTask.id : undefined;
  const trackedJob = useJob(taskId, () => {
    void reload();
  });
  const job = trackedJob?.id === taskId ? trackedJob : undefined;
  const [startingTask, setStartingTask] = useState(false);
  const taskRequest = useRef(false);
  const taskBusy = startingTask || (!!job && !terminal(job.state));
  const runTask = (command: string) =>
    action(async () => {
      if (taskRequest.current || taskBusy) return;
      taskRequest.current = true;
      setStartingTask(true);
      try {
        const id = await startJob(command, { id: film.id });
        set({ backgroundTask: { filmId: film.id, id } });
        Toast.info(appText('jobs.started'));
      } finally {
        taskRequest.current = false;
        setStartingTask(false);
      }
    });
  const { editor, state: editing } = useAnnotationEditor(tab, detail, reload);
  const previousFilm = useRef(film.id + ':' + film.partId);
  useEffect(() => {
    if (previousFilm.current !== film.id + ':' + film.partId) {
      previousFilm.current = film.id + ':' + film.partId;
      set({ annotationScope: whole });
    }
  }, [film.id, film.partId]);
  const [externalOpen, setExternalOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [annotationEditor, setAnnotationEditor] = useState(false);
  const scope = saved.annotationScope;
  const [filter, setFilter] = useState('');
  const error = editing.error;
  useEffect(() => {
    if (inPoint == null || outPoint == null || outPoint <= inPoint) return;
    set({
      annotationScope: {
        kind: 'interval',
        scopeId: crypto.randomUUID(),
        startUs: String(Math.round(inPoint * 1e6)),
        endUs: String(Math.round(outPoint * 1e6)),
        partId: film.partId,
        mediaRevision: film.mediaRevision,
      },
    });
  }, [inPoint, outPoint]);
  const binding = (key: string, target: Scope) => `${film.id}/${scopeKey(target)}/${key}`;
  const entry = (key: string, target: Scope) => editor.record(key, target);
  const draft = (key: string, target: Scope) => saved.fieldDrafts[binding(key, target)];
  const setDraft = (key: string, target: Scope, value: Json) => {
    const id = binding(key, target);
    const next = { ...saved.fieldDrafts };
    if (value == null && !entry(key, target)) delete next[id];
    else
      next[id] = {
        value,
        revision: next[id]?.revision ?? entry(key, target)?.revision ?? 0,
        operation: value == null ? 'clear' : 'set',
      };
    set({ fieldDrafts: next }, Object.keys(next).length > 0);
  };
  const submit = async (keys: string[], target: Scope) => {
    const next = { ...saved.fieldDrafts };
    for (const key of keys) {
      const d = draft(key, target);
      if (d) {
        editor.edit(key, target, d.value, {
          revision: d.revision,
          note: saved.annotationNotes[`${film.id}/${scopeKey(target)}`],
        });
        delete next[binding(key, target)];
      }
    }
    set({ fieldDrafts: next }, true);
    await editor.flush();
  };
  const immediate = (d: Definition, target: Scope, value: Json) =>
    editor.edit(d.key, target, value, { note: saved.annotationNotes[`${film.id}/${scopeKey(target)}`] });
  // Restore old form drafts only where the active layout now opts into autosave.
  useEffect(() => {
    if (!profile) return;
    const next = { ...saved.fieldDrafts };
    let changed = false;
    const visit = (node: LayoutNode) => {
      if (['auto', 'immediate'].includes(node.commitMode)) {
        const target = node.scope === 'whole' ? whole : scope;
        const keys = [
          ...placements(pack, node.region ?? [], target).map(m => m.definition.key),
          ...(saved.extraFields[node.id] ?? []),
        ];
        for (const key of keys) {
          const id = binding(key, target),
            d = next[id];
          if (d) {
            if (!editor.pending(key, target))
              editor.edit(key, target, d.value, {
                revision: d.revision,
                note: saved.annotationNotes[`${film.id}/${scopeKey(target)}`],
              });
            delete next[id];
            changed = true;
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(profile.root);
    if (changed) set({ fieldDrafts: next }, true);
  }, [profile, film.id, scopeKey(scope)]);
  const changeScope = (kind: Scope['kind']) => {
    const currentKey = `${film.id}/${film.partId}/${scope.kind}`;
    const previous = saved.scopeDrafts[`${film.id}/${film.partId}/${kind}`];
    set({
      scopeDrafts: { ...saved.scopeDrafts, [currentKey]: scope },
      annotationScope:
        kind === 'whole'
          ? whole
          : (previous ?? {
              kind,
              scopeId: crypto.randomUUID(),
              startUs: String(Math.round(position * 1e6)),
              ...(kind === 'interval'
                ? { endUs: String(Math.round(Math.min(film.duration, position + 5) * 1e6)) }
                : {}),
              mediaRevision: film.mediaRevision,
            }),
    });
  };
  const changeRange = (target: Scope) => {
    const autoKeys = new Set<string>(),
      manualKeys = new Set<string>();
    const visit = (node: LayoutNode) => {
      if (node.type === 'form' && node.scope !== 'whole') {
        const keys = node.commitMode === 'on-submit' ? manualKeys : autoKeys;
        placements(pack, node.region ?? [], target)
          .filter(m => m.definition.writes?.manual !== false)
          .forEach(m => keys.add(m.definition.key));
        (saved.extraFields[node.id] ?? []).forEach(key => keys.add(key));
      }
      node.children?.forEach(visit);
    };
    if (profile) visit(profile.root);
    const next = { ...saved.fieldDrafts };
    for (const key of manualKeys) {
      const value = draft(key, target)?.value ?? editor.value(key, target);
      if (value != null)
        next[binding(key, target)] = {
          value,
          revision: draft(key, target)?.revision ?? entry(key, target)?.revision ?? 0,
        };
    }
    set({ annotationScope: target, fieldDrafts: next }, manualKeys.size ? true : undefined);
    for (const key of autoKeys) {
      const value = editor.value(key, target);
      if (value != null) editor.edit(key, target, value);
    }
  };
  const changeNote = (note: string, keys: string[], target: Scope, commitMode: string) => {
    const next = { ...saved.fieldDrafts };
    for (const key of keys) {
      const value = draft(key, target)?.value ?? editor.value(key, target);
      if (value != null) {
        if (commitMode === 'on-submit')
          next[binding(key, target)] = {
            value,
            revision: draft(key, target)?.revision ?? entry(key, target)?.revision ?? 0,
          };
        else editor.edit(key, target, value, { note });
      }
    }
    set(
      { annotationNotes: { ...saved.annotationNotes, [`${film.id}/${scopeKey(target)}`]: note }, fieldDrafts: next },
      commitMode === 'on-submit' ? true : undefined,
    );
  };
  useEffect(() => {
    const updated = Object.values(editing.data.heads).find(a => scopeKey(a.scope) === scopeKey(scope));
    if (
      updated &&
      scope.kind !== 'whole' &&
      !Object.values(editing.data.pending).some(c => scopeKey(c.scope) === scopeKey(scope))
    )
      set({ annotationScope: updated.scope });
  }, [editing.data.heads]);
  const renderField = (
    d: Definition,
    target: Scope,
    readonly: boolean,
    commitMode: string,
    removeField?: () => void,
  ) => {
    const record = entry(d.key, target);
    const edited = draft(d.key, target);
    const value = edited ? edited.value : editor.value(d.key, target);
    const canWrite = !readonly && d.writes?.manual !== false;
    const change = (value: Json) =>
      commitMode === 'on-submit' ? setDraft(d.key, target, value) : immediate(d, target, value);
    const actions = [];
    if (canWrite && value != null) actions.push({ id: 'clear', label: word('clear'), run: () => change(null) });
    if (canWrite && record?.editPolicy?.locked)
      actions.push({
        id: 'unlock',
        label: word('unlock'),
        run: () => editor.edit(d.key, target, value ?? null, { locked: false }),
      });
    if (removeField) actions.push({ id: 'removeField', label: word('removeField'), run: removeField });
    const span =
      d.input.props?.layout?.span ??
      (['textarea@1', 'asset@1', 'rating@1'].includes(d.input.component) ? 'full' : 'auto');
    return (
      <div
        className="schema-field"
        key={d.key}
        data-span={span}
        data-component={d.input.component}
        data-editable={canWrite || undefined}
      >
        <div className="schema-field-label">
          <span className="schema-field-caption">
            <label>{t(d.label)}</label>
            <FieldInfo definition={d} record={record} actions={actions} />
          </span>
        </div>
        <div className="schema-field-control">
          {canWrite ? (
            <TagInput
              definition={d}
              value={value}
              compact={surface === 'player.inspector'}
              disabled={editing.busy && editing.data.flight?.direction !== 'edit'}
              onChange={change}
            />
          ) : (
            <TagValue definition={d} value={value} spec={d.display?.default} />
          )}
        </div>
        {edited && record && edited.revision !== record.revision && (
          <Banner type="warning" description={word('conflict')} />
        )}
      </div>
    );
  };
  const openFilm = (seconds?: number) => {
    const id = 'player:' + film.id + ':' + (film.partId ?? '');
    const existing = app.workspace.tabs.find(t => t.id === id);
    const state = { ...existing?.state, ...(seconds == null ? {} : { seekRequest: { filmId: film.id, seconds } }) };
    app.open({
      id,
      kind: 'player',
      title: film.presentation.tabTitle,
      params: { filmId: film.id, partId: film.partId },
      state,
    });
    if (existing && seconds != null) app.update(id, { state });
  };
  const actionButton = (key: string, formKeys: string[] = [], target = whole) => {
    const a = pack.ui.actions[key];
    if (!a) return null;
    return (
      <SchemaAction
        key={key}
        config={a}
        label={t(a.label)}
        disabled={
          ['media.probe', 'metadata.enrich'].includes(a.command)
            ? taskBusy
            : a.command === 'form.undo'
              ? editing.busy || !editing.canUndo
              : a.command === 'form.redo'
                ? editing.busy || !editing.canRedo
                : undefined
        }
        onClick={() => {
          if (a.command === 'form.submit') action(() => submit(formKeys, target));
          else if (a.command === 'form.undo' || a.command === 'form.redo')
            action(async () => {
              await editor.travel(a.command === 'form.undo' ? 'undo' : 'redo');
              set({ annotationNotes: {} });
            });
          else if (a.command === 'form.cancel') {
            const next = { ...saved.fieldDrafts };
            formKeys.forEach(k => delete next[binding(k, target)]);
            set({ fieldDrafts: next }, Object.keys(next).length > 0);
          } else if (['media.probe', 'metadata.enrich'].includes(a.command)) runTask(a.command);
          else if (a.command === 'playback.open') openFilm();
          else if (a.command === 'platform.reveal') action(() => call('platform.reveal', { id: film.id }));
          else if (a.command === 'playback.external') setExternalOpen(true);
          else if (a.command === 'media.resources') setResourcesOpen(true);
          else if (a.command === 'export.open')
            app.open({
              id: 'export',
              kind: 'export',
              title: t(a.label),
              params: { filmId: film.id, partId: film.partId },
            });
        }}
      />
    );
  };
  const editAnnotation = (a: AnnotationRecord) => {
    const extras = { ...saved.extraFields };
    const collect = (node: LayoutNode) => {
      if (node.type === 'form' && node.scope !== 'whole')
        extras[node.id] = [...new Set([...(extras[node.id] ?? []), a.tagKey])];
      node.children?.forEach(collect);
    };
    const inspector = pack.ui.layouts[pack.ui.surfaceBindings['player.inspector']];
    if (inspector) collect(inspector.root);
    set({
      annotationScope: a.scope,
      extraFields: extras,
      annotationNotes: { ...saved.annotationNotes, [`${film.id}/${scopeKey(a.scope)}`]: a.note ?? '' },
    });
    if (surface !== 'player.inspector') setAnnotationEditor(true);
  };
  const annotationNode = (node: LayoutNode, a: AnnotationRecord, d: Definition): React.ReactNode => {
    if (!visible(node.visibleWhen)) return null;
    const children = node.children?.map(child => (
      <div className="schema-node" key={child.id}>
        {annotationNode(child, a, d)}
      </div>
    ));
    if (node.type === 'stack') return <div className={`schema-stack gap-${node.gap ?? 'compact'}`}>{children}</div>;
    if (node.type === 'grid')
      return (
        <div
          className="schema-grid"
          style={{
            ['--layout-tracks' as string]: (node.tracks?.regular ?? [2, 1])
              .map((n: number) => `minmax(0, ${n}fr)`)
              .join(' '),
          }}
        >
          {children}
        </div>
      );
    if (node.type === 'section')
      return (
        <section className="schema-section">
          {node.title && <h3>{t(node.title)}</h3>}
          {children}
        </section>
      );
    if (node.type === 'provenance') return <FieldInfo definition={d} record={a} />;
    if (node.type === 'action-bar' || node.type === 'menu')
      return (
        <Space wrap>
          {node.actions?.map(key => {
            const config = pack.ui.actions[key];
            if (!config) return null;
            return (
              <SchemaAction
                key={key}
                config={config}
                label={t(config.label)}
                disabled={config.command !== 'annotation.seek' && !a.canWrite}
                onClick={() => {
                  if (config.command === 'annotation.seek') {
                    if (seek) seek(Number(a.scope.startUs ?? 0) / 1e6);
                    else openFilm(Number(a.scope.startUs ?? 0) / 1e6);
                  } else if (config.command === 'annotation.edit') editAnnotation(a);
                  else if (config.command === 'annotation.clear') immediate(d, a.scope, null);
                }}
              />
            );
          })}
        </Space>
      );
    if (node.type === 'value') {
      if (node.binding === 'annotation.label')
        return (
          <span className="schema-field-caption">
            <b>{t(d.label)}</b>
            <FieldInfo definition={d} record={a} />
          </span>
        );
      if (node.binding === 'annotation.note') return a.note ? <p>{a.note}</p> : null;
      if (node.binding === 'annotation.range')
        return (
          <small>
            {(Number(a.scope.startUs) / 1e6).toFixed(3)}
            {a.scope.endUs ? ` – ${(Number(a.scope.endUs) / 1e6).toFixed(3)}` : ''}
          </small>
        );
      const field = node.tag ? pack.definitions.find(f => f.key === node.tag) : d;
      return field ? <TagValue definition={field} value={node.tag ? film.values[node.tag]?.value : a.value} /> : null;
    }
    return null;
  };
  const history = (node: LayoutNode) => (
    <div className="schema-annotations">
      <Space>
        <h3>{node.title ? t(node.title) : word('history')}</h3>
        <Input value={filter} onChange={setFilter} placeholder={word('search')} aria-label={word('search')} />
      </Space>
      {detail.annotations
        .filter(
          a => !filter || `${t(pack.definitions.find(d => d.key === a.tagKey)?.label)} ${a.note}`.includes(filter),
        )
        .map(a => {
          const d = pack.definitions.find(d => d.key === a.tagKey);
          if (!d) return null;
          const row = pack.ui.layouts[node.itemLayout ?? pack.ui.surfaceBindings['annotation.row']];
          return (
            <article className="schema-annotation" key={a.id}>
              <div className="schema-annotation-layout">
                {row ? annotationNode(row.root, a, d) : <TagValue definition={d} value={a.value} />}
              </div>
            </article>
          );
        })}
      {!detail.annotations.length && <p className="muted">{word('empty')}</p>}
    </div>
  );
  const visible = (condition: any) => !condition || evaluate(condition, film.values, film.facts) === true;
  const render = (node: LayoutNode, inheritedDisabled = false): React.ReactNode => {
    if (!visible(node.visibleWhen)) return null;
    const disabled =
      inheritedDisabled || (!!node.disabledWhen && evaluate(node.disabledWhen, film.values, film.facts) === true);
    const children = node.children?.map(child => (
      <div
        key={child.id}
        className="schema-node"
        inert={child.disabledWhen ? evaluate(child.disabledWhen, film.values, film.facts) === true : undefined}
      >
        {render(child, disabled)}
      </div>
    ));
    const target: Scope = node.scope === 'whole' ? whole : scope;
    switch (node.type) {
      case 'ribbon':
        return (
          <RibbonLayout
            node={node}
            text={t}
            action={key => actionButton(key)}
            heading={node.binding ? <h1 title={film.presentation.title}>{film.presentation.title}</h1> : undefined}
            state={saved.ribbons[node.id]}
            onChange={value => set({ ribbons: { ...saved.ribbons, [node.id]: value } })}
            visible={child => visible(child.visibleWhen)}
            disabled={child =>
              disabled || (!!child.disabledWhen && evaluate(child.disabledWhen, film.values, film.facts) === true)
            }
          />
        );
      case 'stack':
      case 'grid':
      case 'section':
      case 'disclosure':
        return (
          <LayoutFrame node={node} title={t(node.title)}>
            {children}
          </LayoutFrame>
        );
      case 'identity':
        return (
          <header className="page-heading">
            <h1>{film.presentation.title}</h1>
            <Space>{node.actions?.map(k => actionButton(k))}</Space>
          </header>
        );
      case 'field-set':
      case 'form': {
        const matched = placements(pack, node.region ?? [], target);
        const baseKeys = matched.map(m => m.definition.key);
        const extras = saved.extraFields[node.id] ?? [];
        const fields = [
          ...matched.map(m => m.definition),
          ...extras
            .filter(k => !baseKeys.includes(k))
            .map(k => pack.definitions.find(d => d.key === k))
            .filter((d): d is Definition => Boolean(d?.enabled && supportsTarget(d, 'film', target.kind))),
        ];
        const bound = new Set(
          placements(
            pack,
            surface === 'film.details' ? 'film.details.primary' : 'player.annotations.primary',
            whole,
          ).map(m => m.definition.key),
        );
        const editable = fields.filter(
          d => !(target.kind === 'whole' && node.commitMode !== 'immediate' && bound.has(d.key)),
        );
        const candidates = pack.definitions.filter(
          d =>
            d.enabled &&
            supportsTarget(d, 'film', target.kind) &&
            d.writes?.manual !== false &&
            !editable.some(e => e.key === d.key) &&
            !(target.kind === 'whole' && bound.has(d.key)),
        );
        const actions = node.actions?.map(k =>
          actionButton(
            k,
            editable.map(d => d.key),
            target,
          ),
        );
        return (
          <section className="schema-fields" data-mode={node.mode} data-commit={node.commitMode}>
            {node.title && <h2>{t(node.title)}</h2>}
            <div className="schema-fields-body" data-actions-placement={node.actionsPlacement}>
              <div className="schema-fields-grid">
                {editable.map(d =>
                  renderField(
                    d,
                    target,
                    node.mode === 'display' ||
                      Boolean(node.disabledWhen && evaluate(node.disabledWhen, film.values, film.facts)),
                    node.commitMode ?? 'on-submit',
                    !baseKeys.includes(d.key)
                      ? () => {
                          const next = { ...saved.fieldDrafts };
                          delete next[binding(d.key, target)];
                          set(
                            {
                              extraFields: { ...saved.extraFields, [node.id]: extras.filter(key => key !== d.key) },
                              fieldDrafts: next,
                            },
                            Object.keys(next).length > 0,
                          );
                        }
                      : undefined,
                  ),
                )}
              </div>
              {!!actions?.length && node.actionsPlacement === 'inline-end' && (
                <Space className="schema-inline-actions">{actions}</Space>
              )}
            </div>
            {node.fieldPicker && (
              <FormField label={word('fields')}>
                <Select
                  aria-label={word('fields')}
                  placeholder={word('fields')}
                  value=""
                  optionList={candidates.map(d => ({ value: d.key, label: t(d.label) }))}
                  onChange={key => set({ extraFields: { ...saved.extraFields, [node.id]: [...extras, String(key)] } })}
                />
              </FormField>
            )}
            {node.type === 'form' && target.kind !== 'whole' && (
              <FormField label={word('note')}>
                <TextArea
                  aria-label={word('note')}
                  placeholder={word('note')}
                  value={
                    saved.annotationNotes[`${film.id}/${scopeKey(target)}`] ??
                    editable.map(d => entry(d.key, target)?.note).find(Boolean) ??
                    ''
                  }
                  onChange={note =>
                    changeNote(
                      note,
                      editable.filter(d => d.writes?.manual !== false).map(d => d.key),
                      target,
                      node.commitMode ?? 'on-submit',
                    )
                  }
                />
              </FormField>
            )}
            {!!actions?.length && node.actionsPlacement !== 'inline-end' && <Space>{actions}</Space>}
          </section>
        );
      }
      case 'scope-picker':
        return (
          <SegmentedControl
            aria-label={word('annotations')}
            selectedKey={scope.kind}
            onSelectionChange={key => changeScope(String(key) as Scope['kind'])}
          >
            {(node.modes ?? ['whole', 'point', 'interval']).map((kind: string) => (
              <SegmentedControlItem key={kind} id={kind}>
                {word(kind)}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        );
      case 'time-range':
        return scope.kind === 'whole' ? null : (
          <div className="schema-time-range">
            <FormField
              label={word('start')}
              actions={
                <Button
                  size="S"
                  theme="borderless"
                  onClick={() => changeRange({ ...scope, startUs: String(Math.round(position * 1e6)) })}
                >
                  {word('capture')}
                </Button>
              }
            >
              <InputNumber
                aria-label={word('start')}
                min={0}
                max={film.duration || undefined}
                step={0.001}
                value={Number(scope.startUs) / 1e6}
                onChange={start => changeRange({ ...scope, startUs: String(Math.round(start * 1e6)) })}
              />
            </FormField>
            {scope.kind === 'interval' && (
              <FormField label={word('end')}>
                <InputNumber
                  aria-label={word('end')}
                  min={0}
                  max={film.duration || undefined}
                  step={0.001}
                  value={Number(scope.endUs) / 1e6}
                  onChange={end => changeRange({ ...scope, endUs: String(Math.round(end * 1e6)) })}
                />
              </FormField>
            )}
          </div>
        );
      case 'annotation-list':
      case 'timeline':
        return history(node);
      case 'candidates':
        return !detail.candidates.length && node.empty === 'collapse' ? null : (
          <CandidateList candidates={detail.candidates} values={film.values} onChanged={reload} />
        );
      case 'action-bar':
      case 'menu':
        return <Space>{node.actions?.map(k => actionButton(k))}</Space>;
      case 'value': {
        const d = pack.definitions.find(d => d.key === node.tag);
        return d ? <TagValue definition={d} value={film.values[d.key]?.value} /> : null;
      }
      case 'asset': {
        const image = film.presentation.image;
        return image?.startsWith('asset:') ? (
          <img className="schema-asset" src={app.data.mediaBase + '/asset/' + image.slice(6)} alt="" />
        ) : null;
      }
      case 'collection':
      case 'table':
        return node.source === 'annotations' ? (
          history(node)
        ) : (
          <div>
            {pack.definitions
              .filter(d => film.values[d.key]?.value != null)
              .map(d => renderField(d, whole, true, 'on-submit'))}
          </div>
        );
      case 'provenance':
        return (
          <dl className="description-list">
            {Object.values(film.values).map(v => (
              <div key={v.id}>
                {v.origin.kind} · {v.provenance?.source}
              </div>
            ))}
          </dl>
        );
      case 'status':
        return error ? <Banner type="danger" description={error} /> : null;
      default:
        return <Banner type="warning" description={appText('layout.unsupported', { type: node.type })} />;
    }
  };
  return (
    <div className={`schema-surface ${surface === 'player.inspector' ? 'schema-inspector' : ''}`}>
      <ExternalPlayerDialog
        filmId={film.id}
        partId={film.partId}
        visible={externalOpen}
        onClose={() => setExternalOpen(false)}
      />
      <MediaResources
        filmId={film.id}
        title={film.presentation.tabTitle}
        visible={resourcesOpen}
        onClose={() => setResourcesOpen(false)}
        onChanged={reload}
      />
      {startingTask && <p role="status">{appText('jobs.starting')}</p>}
      <JobNotice job={job} />
      <span className="sr-only" role="status">
        {word(error ? 'saveFailed' : editing.busy || Object.keys(editing.data.pending).length ? 'saving' : 'saved')}
      </span>
      {error && (
        <Banner
          type="danger"
          title={word('saveFailed')}
          description={
            <>
              <p>{error}</p>
              <Space>
                <Button disabled={editing.busy} onClick={() => action(() => editor.flush())}>
                  {word('retry')}
                </Button>
                <Button
                  disabled={editing.busy}
                  onClick={() =>
                    action(async () => {
                      editor.discard();
                      set({ annotationNotes: {} });
                      await reload();
                    })
                  }
                >
                  {word('discardEdits')}
                </Button>
              </Space>
            </>
          }
        />
      )}
      {profile ? render(profile.root) : <Banner type="warning" description={appText('layout.unavailable')} />}
      <Modal
        mode="exclusive"
        visible={annotationEditor}
        title={word('edit') + word('annotations')}
        onCancel={() => setAnnotationEditor(false)}
        footer={<Button onClick={() => setAnnotationEditor(false)}>{word('close')}</Button>}
      >
        <Surface
          surface="player.inspector"
          detail={detail}
          tab={tab}
          reload={reload}
          position={Number(scope.startUs ?? 0) / 1e6}
        />
      </Modal>
    </div>
  );
}
