import { defaultQuery } from '../types';
import { supportsTarget } from './annotation-targets';
import { t as appText, translate } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { useEffect, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Button, Input, Select, Space, Modal, Switch } from '../ui';
import { IconPlus, IconTag } from '../icons';
import { call } from '../api';
import { action, notifyError, useApp, useTabState } from '../context';
import type { WorkspaceTab } from '../workspace';
import { isMessageReference, type Term } from './types';
import { localize, terms } from './i18n';
import { SubjectTags } from './SubjectTags';
import { LocalizedTextField } from '../components/LocalizedTextField';

type Link = { subjectKind: string; subjectId: string; tagKey: string; targetId: string };
export function TermManager({ tab }: { tab: WorkspaceTab }) {
  const app = useApp(),
    pack = app.data.tagging.package,
    t = (v: any) => localize(v, app.locale, pack),
    tr = (key: string) => translate(key, app.locale);
  const [state, set] = useTabState(tab, {
    termVocabulary: '',
    termSelected: '',
    termSearch: '',
    termProfileDrafts: {} as Record<string, Term>,
  });
  const vocabulary = state.termVocabulary || Object.keys(pack.vocabularies ?? {})[0] || '';
  const [items, setItems] = useState<Term[]>([]),
    [total, setTotal] = useState(0),
    [links, setLinks] = useState<Link[]>([]),
    [editing, setEditing] = useState<Term>(),
    [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Term>();
  useEffect(() => {
    let disposed = false;
    void call<{ items: Term[]; total: number }>('terms.query', {
      vocabulary,
      search: state.termSearch,
      includeDisabled: true,
      limit: 10000,
    })
      .then(r => {
        if (!disposed) {
          setItems(r.items);
          setTotal(r.total);
        }
      })
      .catch(notifyError);
    return () => {
      disposed = true;
    };
  }, [vocabulary, state.termSearch, app.revision]);
  useEffect(() => {
    if (!state.termSelected) {
      setSelected(undefined);
      setLinks([]);
      return;
    }
    let disposed = false;
    void call<{ term: Term; links: Link[] }>('terms.get', { id: state.termSelected })
      .then(r => {
        if (!disposed) {
          setSelected(r.term);
          setLinks(r.links);
        }
      })
      .catch(notifyError);
    return () => {
      disposed = true;
    };
  }, [state.termSelected, app.revision]);
  const editProfile = (next: Term) => {
    setEditing(next);
    if (!creating) set({ termProfileDrafts: { ...state.termProfileDrafts, [next.id]: next } }, true);
  };
  const put = async (term: Term) => {
    const r = await call<{ term: Term }>('terms.put', {
      term,
      expectedRevision: creating ? 0 : term.revision,
      expectedGeneration: app.data.tagging.generation,
    });
    set({ termSelected: r.term.id });
    const termProfileDrafts = { ...state.termProfileDrafts };
    delete termProfileDrafts[r.term.id];
    set({ termProfileDrafts });
    setEditing(undefined);
    setSelected(r.term);
    await app.refresh();
  };
  const create = () => {
    const id = 'user.term.' + crypto.randomUUID().replaceAll('-', '');
    setCreating(true);
    setEditing({
      id,
      revision: 0,
      enabled: true,
      label: { [pack.i18n.defaultLocale]: '' },
      description: { [pack.i18n.defaultLocale]: '' },
      vocabularyIds: [vocabulary],
    });
  };
  const choose = (id: string) => {
    const term = terms(pack).find(t => t.id === id);
    set({ termSelected: id, ...(term ? { termVocabulary: term.vocabularyIds[0] } : {}) });
  };
  return (
    <div className="term-manager">
      <aside className="term-list">
        <div className="term-list-tools">
          <Select
            aria-label={tr('TermManager.vocabulary')}
            value={vocabulary}
            optionList={Object.entries(pack.vocabularies ?? {}).map(([value, v]) => ({ value, label: t(v.label) }))}
            onChange={v => {
              set({ termVocabulary: String(v), termSelected: '', termSearch: '' });
            }}
          />
          <Input
            aria-label={tr('TermManager.searchValues')}
            placeholder={tr('TermManager.searchValues')}
            value={state.termSearch}
            onChange={termSearch => set({ termSearch })}
          />
          <Button icon={<IconPlus />} disabled={!vocabulary} onClick={create}>
            {tr('TermManager.newValue')}
          </Button>
        </div>
        <div className="term-list-items">
          {items.map(term => (
            <AriaButton
              data-context-resource=""
              key={term.id}
              className={'term-list-item' + (term.id === state.termSelected ? ' is-current' : '')}
              onPress={() => set({ termSelected: term.id })}
            >
              <IconTag />
              <span>{t(term.label)}</span>
              {state.termProfileDrafts[term.id] && (
                <span className="definition-dirty" aria-label={tr('TermManager.draftRetained')} />
              )}{' '}
              {!term.enabled && <small>{tr('TermManager.disabled')}</small>}
            </AriaButton>
          ))}
          {!items.length && <p className="muted">{tr('TermManager.noMatchingValues')}</p>}
        </div>
        <div className="definition-list-count">
          {items.length} / {total}
        </div>
      </aside>
      <section className="term-detail">
        {selected ? (
          <>
            <header className="term-detail-heading">
              <div>
                <h2>{t(selected.label)}</h2>
                <p className="muted">
                  {selected.vocabularyIds.map(id => t(pack.vocabularies?.[id]?.label) || id).join(' / ')}
                </p>
              </div>
              <Space>
                <Button
                  onClick={() =>
                    app.open({
                      id: crypto.randomUUID(),
                      kind: 'library',
                      title: t(selected.label),
                      params: {
                        query: {
                          ...defaultQuery(),
                          where: {
                            op: 'or',
                            args: pack.definitions
                              .filter(
                                d =>
                                  d.enabled &&
                                  supportsTarget(d, 'film') &&
                                  selected.vocabularyIds.includes(d.value.vocabulary ?? ''),
                              )
                              .map(d => ({
                                op: d.value.cardinality === 'many' ? 'has' : 'eq',
                                tag: d.key,
                                value: { term: selected.id },
                              })),
                          },
                        },
                      },
                      state: { showAdvanced: true },
                    })
                  }
                >
                  {appText('Journey.relatedFilms')}
                </Button>
                <Button
                  theme="borderless"
                  onClick={() => {
                    setCreating(false);
                    setEditing(structuredClone(state.termProfileDrafts[selected.id] ?? selected));
                  }}
                >
                  {tr('TermManager.editNameAndDescription')}
                </Button>
                <Switch
                  aria-label={tr('TermManager.enableThisValue')}
                  checked={selected.enabled}
                  onChange={enabled =>
                    action(async () => {
                      setCreating(false);
                      await call('terms.put', {
                        term: { ...selected, enabled },
                        expectedRevision: selected.revision,
                        expectedGeneration: app.data.tagging.generation,
                      });
                      await app.refresh();
                    })
                  }
                >
                  {tr('TermManager.enableThisValue')}
                </Switch>
              </Space>
            </header>
            {state.termProfileDrafts[selected.id] && (
              <p className="muted">{tr('TermManager.aRetainedProfileDraftIsAvailableUnder')}</p>
            )}
            {selected.description && <p className="term-description">{t(selected.description)}</p>}
            <SubjectTags key={selected.id} term={selected} tab={tab} />
            <TermRelations term={selected} links={links} onSelect={choose} />
          </>
        ) : (
          <div className="empty-state">
            <h3>{tr('TermManager.chooseAValue')}</h3>
            <p>{tr('TermManager.editItsProfileAttributesAndRelationshipsHere')}</p>
          </div>
        )}
      </section>
      <Modal
        mode="exclusive"
        title={creating ? tr('TermManager.newValue_10') : tr('TermManager.editValueProfile')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <Space>
            <Button onClick={() => setEditing(undefined)}>{tr('TermManager.cancel')}</Button>
            <Button
              theme="solid"
              disabled={!editing || !t(editing.label).trim()}
              onClick={() => action(() => put(editing!))}
            >
              {tr('TermManager.save')}
            </Button>
          </Space>
        }
      >
        {editing && (
          <FormLayout>
            <FormField layout="row" label={tr('TermManager.name')}>
              <LocalizedTextField
                label={tr('TermManager.name')}
                value={
                  !isMessageReference(editing.label)
                    ? editing.label
                    : { [pack.i18n.defaultLocale]: localize(editing.label, pack.i18n.defaultLocale, pack) }
                }
                locale={app.locale}
                onChange={label => editProfile({ ...editing, label })}
              />
            </FormField>
            <FormField layout="row" label={tr('TermManager.description')}>
              <LocalizedTextField
                label={tr('TermManager.description')}
                value={
                  editing.description && !isMessageReference(editing.description)
                    ? editing.description
                    : { [pack.i18n.defaultLocale]: localize(editing.description, pack.i18n.defaultLocale, pack) }
                }
                locale={app.locale}
                multiline
                onChange={description => editProfile({ ...editing, description })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
    </div>
  );
}
function TermRelations({ term, links, onSelect }: { term: Term; links: Link[]; onSelect(id: string): void }) {
  const app = useApp(),
    pack = app.data.tagging.package,
    t = (v: any) => localize(v, app.locale, pack),
    tr = (key: string) => translate(key, app.locale);
  const incoming = links.filter(l => l.subjectKind === 'term' && l.targetId === term.id),
    outgoing = links.filter(l => l.subjectKind === 'term' && l.subjectId === term.id);
  const left = [...new Set(incoming.map(l => l.subjectId))],
    right = [...new Set(outgoing.map(l => l.targetId))],
    height = Math.max(left.length, right.length, 1) * 68 + 24;
  const all = terms(pack),
    title = (id: string) => t(all.find(x => x.id === id)?.label) || id;
  const node = (id: string, x: number, y: number) => (
    <g
      key={id}
      className={'term-graph-node' + (id === term.id ? ' is-current' : '')}
      role="button"
      tabIndex={0}
      aria-label={title(id)}
      onClick={() => onSelect(id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(id);
        }
      }}
    >
      <title>{title(id)}</title>
      <rect x={x} y={y - 18} width="150" height="36" rx="5" />
      <text x={x + 75} y={y + 5} textAnchor="middle">
        {title(id).length > 14 ? title(id).slice(0, 13) + '…' : title(id)}
      </text>
    </g>
  );
  const edge = (x: number, y: number, endX: number, endY: number, key: string) => (
    <g key={key} className="term-graph-edge">
      <path d={`M${x},${y} C${x + 45},${y} ${endX - 45},${endY} ${endX},${endY}`} markerEnd="url(#term-arrow)" />
      <title>{key}</title>
    </g>
  );
  return (
    <section className="term-relations">
      <h3>{tr('TermManager.directRelationships')}</h3>
      {left.length + right.length > 0 ? (
        <>
          <div className="term-graph-labels">
            <span>{tr('TermManager.referencesThisValue')}</span>
            <span>{tr('TermManager.currentValue')}</span>
            <span>{tr('TermManager.referencedValues')}</span>
          </div>
          <div className="term-graph-scroll">
            <svg
              viewBox={`0 0 660 ${height}`}
              style={{ minHeight: height }}
              aria-label={tr('TermManager.directedValueRelationships')}
            >
              <defs>
                <marker
                  id="term-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0 0 L10 5 L0 10z" />
                </marker>
              </defs>
              {left.map((id, i) => edge(155, 42 + i * 68, 255, height / 2, id))}
              {right.map((id, i) => edge(405, height / 2, 505, 42 + i * 68, id))}
              {left.map((id, i) => node(id, 5, 42 + i * 68))}
              {node(term.id, 255, height / 2)}
              {right.map((id, i) => node(id, 505, 42 + i * 68))}
            </svg>
          </div>
          <div className="term-relation-list">
            {[...incoming, ...outgoing].map((link, i) => (
              <div key={i}>
                <Button theme="borderless" onClick={() => onSelect(link.subjectId)}>
                  {title(link.subjectId)}
                </Button>
                <span className="muted">{t(pack.definitions.find(d => d.key === link.tagKey)?.label)} →</span>
                <Button theme="borderless" onClick={() => onSelect(link.targetId)}>
                  {title(link.targetId)}
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">{tr('TermManager.noValueReferencesYet')}</p>
      )}
      <p className="muted">
        {tr('TermManager.filmReferences')}{' '}
        {new Set(links.filter(l => l.subjectKind === 'film').map(l => l.subjectId)).size}
        {links.length >= 500 ? ' +' : ''}
      </p>
    </section>
  );
}
