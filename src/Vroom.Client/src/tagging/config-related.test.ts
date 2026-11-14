import { describe, expect, it } from 'vitest';
import { configurationDependencies } from './config-related';
import { configDraftState, recordConfigEdit, travelConfigHistory } from './config-history';

describe('in-context configuration dependencies', () => {
  const definition = {
    enrichment: [{ source: 'source.a', field: 'title' }],
    initialization: [{ args: { rule: 'rule.direct' } }],
  };
  const sources = {
    'source.a': {
      parse: { fields: { title: { normalizeWith: 'rule.new' }, other: { normalizeWith: 'rule.shared' } } },
    },
    'source.unrelated': { parse: { fields: { value: { normalizeWith: 'rule.unrelated' } } } },
  };
  it('publishes rules referenced by the staged source, including its other fields, without unrelated drafts', () => {
    expect(configurationDependencies('definition', definition, sources).sort()).toEqual([
      'rules/rule.direct',
      'rules/rule.new',
      'rules/rule.shared',
      'sources/source.a',
    ]);
    expect(configurationDependencies('sources', sources['source.a'], sources).sort()).toEqual([
      'rules/rule.new',
      'rules/rule.shared',
    ]);
  });
  it('undoes a mapping and a newly created processor as one edit and refuses to remove a newly shared processor', () => {
    const owner = 'definition/user.field',
      source = 'sources/source.a',
      processor = 'rules/rule.new';
    const before = configDraftState({});
    const next = configDraftState({
      drafts: {
        [owner]: JSON.stringify(definition),
        [source]: JSON.stringify(sources['source.a']),
        [processor]: '{"patterns":[{"pattern":"(.*)","template":"{1}"}]}',
      },
      baseGenerations: { [owner]: 4, [source]: 4, [processor]: 4 },
    });
    const edited = recordConfigEdit(before, owner, next, { mode: 'form', at: 1000 });
    const undone = travelConfigHistory(edited, owner, 'undo');
    expect(undone.conflict).toBeUndefined();
    expect(undone.state.drafts).toEqual({});
    expect(travelConfigHistory(undone.state, owner, 'redo').state.drafts).toEqual(next.drafts);
    const shared = {
      ...edited,
      drafts: { ...edited.drafts, 'sources/source.b': '{"parse":{"fields":{"code":{"normalizeWith":"rule.new"}}}}' },
    };
    expect(travelConfigHistory(shared, owner, 'undo').conflict).toBe(processor);
  });
});
