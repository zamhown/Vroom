import type { LocalizedText } from './types';
import { CandidateList } from './CandidateList';
import { JobNotice } from '../components';
import { translate } from '../i18n';
import { FormField } from '../components/FormLayout';
import { supportsTarget } from './annotation-targets';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Select, Space, Banner } from '../ui';
import { action, useApp, notifyError, useJob, useTabState } from '../context';
import { call, startJob } from '../api';
import { terminal } from '../types';
import { IconUndo, IconRedo } from '../icons';
import { TagInput, TagValue } from './Inputs';
import { localize, ui } from './i18n';
import type { AnnotationRecord, Candidate, LayoutNode, Term } from './types';
import type { WorkspaceTab } from '../workspace';
import { FieldInfo } from './FieldInfo';
import { comparePlacements } from './LayoutFrame';
import { AnnotationEditor, annotationSessions, type EditorData } from './AnnotationEditor';

/** Only enumerable value entities are annotation subjects. A definition is never a subject. */
export function SubjectTags({ term, tab }: { term: Term; tab: WorkspaceTab }) {
  const app = useApp(),
    pack = app.data.tagging.package,
    t = (v: LocalizedText | undefined) => localize(v, app.locale, pack);
  const tr = (key: string) => translate(key, app.locale);
  const [values, setValues] = useState<Record<string, AnnotationRecord>>({}),
    [extra, setExtra] = useState<string[]>([]),
    [loaded, setLoaded] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const reload = async () => {
    const data = await call<{ values: Record<string, AnnotationRecord>; candidates: Candidate[] }>('terms.get', {
      id: term.id,
    });
    setValues(data.values);
    setCandidates(data.candidates);
    setLoaded(true);
  };
  const [taskState, setTaskState] = useTabState(tab, { enrichmentJobs: {} as Record<string, string> });
  const job = useJob(taskState.enrichmentJobs[term.id], () => {
    void reload().catch(notifyError);
  });
  const [starting, setStarting] = useState(false);
  const enrich = () =>
    action(async () => {
      setStarting(true);
      try {
        const id = await startJob('metadata.enrich', { id: term.id, subjectKind: 'term' });
        setTaskState({ enrichmentJobs: { ...taskState.enrichmentJobs, [term.id]: id } });
      } finally {
        setStarting(false);
      }
    });
  const editor = useMemo(() => {
    const key = tab.id + '/term/' + term.id;
    let session = annotationSessions.get(key);
    if (!session) {
      session = new AnnotationEditor(
        term.id,
        r => call('annotations.batch', r),
        (tab.state.termEditors as Record<string, EditorData> | undefined)?.[term.id],
        'term',
      );
      annotationSessions.set(key, session);
    }
    return session;
  }, [term.id]);
  editor.observe(Object.values(values), app.data.tagging.generation);
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot),
    live = useRef({ app, tab });
  live.current = { app, tab };
  useEffect(() => {
    void reload().catch(notifyError);
    setExtra([]);
  }, [term.id, app.revision]);
  useEffect(() => {
    const unsubscribe = editor.subscribe(() => {
      const { app, tab } = live.current;
      const next = editor.getSnapshot().data;
      const dirty =
        !!Object.keys(next.pending).length ||
        !!next.flight ||
        !!Object.keys((tab.state.drafts as object) ?? {}).length ||
        !!Object.keys((tab.state.termProfileDrafts as object) ?? {}).length;
      app.patchState(
        tab.id,
        current => ({ ...current, termEditors: { ...(current.termEditors as object), [term.id]: next } }),
        dirty,
      );
    });
    editor.resume();
    return unsubscribe;
  }, [editor]);
  useEffect(() => {
    void reload().catch(notifyError);
    if (Object.keys(state.data.heads).length) void app.refresh().catch(notifyError);
  }, [state.data.heads]);
  const fields = pack.definitions.filter(
    d =>
      d.enabled &&
      supportsTarget(d, 'term', 'whole') &&
      (!d.subjectVocabularies?.length || d.subjectVocabularies.some(id => term.vocabularyIds.includes(id))),
  );
  const scope = { kind: 'whole' as const };
  const field = (key: string, mode = 'edit') => {
    const d = fields.find(d => d.key === key);
    if (!d) return null;
    return (
      <div className="schema-field" key={key}>
        <div className="schema-field-label">
          <span>{t(d.label)}</span>
          <FieldInfo definition={d} record={values[key]} />
        </div>
        <div className="schema-field-control">
          {mode === 'display' ? (
            <TagValue definition={d} value={editor.value(key, scope)} />
          ) : (
            <TagInput
              definition={d}
              value={editor.value(key, scope)}
              showState
              disabled={!loaded || !term.enabled || d.writes?.manual === false}
              onChange={v => editor.edit(key, scope, v)}
            />
          )}
        </div>
      </div>
    );
  };
  const placed = new Set<string>();
  const render = (node: LayoutNode): ReactNode => {
    const children = node.children?.map(render);
    if (node.type === 'field-set') {
      const regions = (Array.isArray(node.region) ? node.region : [node.region]).filter((r): r is string => !!r);
      const entries = fields
        .flatMap(d => d.placements.filter(p => regions.includes(p.slot)).map(p => ({ d, p })))
        .sort((a, b) =>
          comparePlacements(pack, regions, { key: a.d.key, slot: a.p.slot }, { key: b.d.key, slot: b.p.slot }),
        )
        .filter(({ d }) => {
          if (placed.has(d.key)) return false;
          placed.add(d.key);
          return true;
        });
      return (
        <section key={node.id} className="term-fields-section">
          {node.title && <h3>{t(node.title)}</h3>}
          <div className="schema-fields-grid">{entries.map(({ d, p }) => field(d.key, p.mode))}</div>
        </section>
      );
    }
    if (node.type === 'candidates')
      return <CandidateList key={node.id} candidates={candidates} values={values} onChanged={reload} />;
    if (node.type === 'action-bar')
      return (
        <Space key={node.id}>
          {node.actions?.map(id => {
            const command = pack.ui.actions[id];
            return command?.command === 'metadata.enrich' ? (
              <Button key={id} disabled={starting || (!!job && !terminal(job.state))} onClick={enrich}>
                {t(command.label)}
              </Button>
            ) : null;
          })}
        </Space>
      );
    if (node.type === 'grid')
      return (
        <div
          key={node.id}
          className="schema-grid"
          style={{
            ['--layout-tracks' as string]: (node.tracks?.regular ?? [1, 1])
              .map((n: number) => `minmax(0, ${n}fr)`)
              .join(' '),
          }}
        >
          {children}
        </div>
      );
    return (
      <section
        key={node.id}
        className={node.type === 'stack' ? `schema-stack gap-${node.gap ?? 'field'}` : 'term-layout-section'}
      >
        {node.title && <h3>{t(node.title)}</h3>}
        {children}
      </section>
    );
  };
  const layout = pack.ui.layouts[pack.ui.surfaceBindings['term.details']];
  const content = layout ? render(layout.root) : null;
  const additional = fields.filter(d => !placed.has(d.key) && (extra.includes(d.key) || values[d.key]?.value != null));
  const missing = fields.filter(d => !placed.has(d.key) && !additional.includes(d) && d.writes?.manual !== false);
  return (
    <div className="term-properties">
      <div className="term-section-heading">
        <h3>{tr('SubjectTags.attributesAndRelationships')}</h3>
        <Space>
          <span className="muted" role="status">
            {ui(
              state.error ? 'saveFailed' : state.busy || Object.keys(state.data.pending).length ? 'saving' : 'saved',
              app.locale,
            )}
          </span>
          <Button
            theme="borderless"
            icon={<IconUndo />}
            aria-label={tr('SubjectTags.undo')}
            disabled={!state.canUndo || state.busy}
            onClick={() => action(() => editor.travel('undo'))}
          />
          <Button
            theme="borderless"
            icon={<IconRedo />}
            aria-label={tr('SubjectTags.redo')}
            disabled={!state.canRedo || state.busy}
            onClick={() => action(() => editor.travel('redo'))}
          />
        </Space>
      </div>
      {state.error && (
        <Banner
          type="danger"
          description={
            <Space>
              {state.error}
              <Button onClick={() => action(() => editor.flush())}>{ui('retry', app.locale)}</Button>
            </Space>
          }
        />
      )}
      <JobNotice job={job} />
      {content}
      <div className="schema-fields-grid">{additional.map(d => field(d.key))}</div>
      {missing.length > 0 && (
        <FormField label={ui('fields', app.locale)}>
          <Select
            aria-label={ui('fields', app.locale)}
            placeholder={ui('fields', app.locale)}
            value=""
            optionList={missing.map(d => ({ value: d.key, label: t(d.label) }))}
            onChange={key => setExtra(x => [...x, String(key)])}
          />
        </FormField>
      )}
      {!fields.length && <p className="muted">{tr('SubjectTags.noAttributesTargetThisVocabularySetThe')}</p>}
    </div>
  );
}
