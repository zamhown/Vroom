import { describe, expect, it } from 'vitest';
import {
  breakConfigEditGroup,
  configDraftState,
  configHistory,
  hasRelatedDraftChanges,
  recordConfigEdit,
  sameConfiguration,
  travelConfigHistory,
  type ConfigDraftState,
} from './config-history';

const field = 'definition/user.unfamiliar';
const initial = JSON.stringify({ key: 'user.unfamiliar', label: 'Original', enabled: true, extension: { private: 7 } });
const named = JSON.stringify({ key: 'user.unfamiliar', label: 'Renamed', enabled: true, extension: { private: 7 } });
function edit(state: ConfigDraftState, changes: Record<string, string | undefined>, mode = 'form', at = 1000) {
  const next = configDraftState(state);
  next.drafts = { ...state.drafts };
  next.baseGenerations = { ...state.baseGenerations };
  for (const [id, text] of Object.entries(changes)) {
    if (text === undefined) {
      delete next.drafts[id];
      delete next.baseGenerations[id];
    } else {
      next.drafts[id] = text;
      next.baseGenerations[id] = 9;
    }
  }
  return recordConfigEdit(state, field, next, { mode, at, baseline: initial });
}
describe('per-configuration draft history', () => {
  it('replays form, structure and unfinished JSON changes in chronological order after restore', () => {
    let state = edit(configDraftState({}), { [field]: named });
    const structured = named.replace('true', 'false');
    state = edit(state, { [field]: structured }, 'structure', 1100);
    state = edit(state, { [field]: '{"key":' }, 'json', 1200);
    state = JSON.parse(JSON.stringify(state));
    for (const expected of [structured, named, undefined]) {
      state = travelConfigHistory(state, field, 'undo').state;
      expect(state.drafts[field]).toBe(expected);
    }
    expect(state.baseGenerations[field]).toBeUndefined();
    for (const expected of [named, structured, '{"key":']) {
      state = travelConfigHistory(state, field, 'redo').state;
      expect(state.drafts[field]).toBe(expected);
    }
  });
  it('groups continuous typing only in the same field and mode', () => {
    let state = edit(configDraftState({}), { [field]: named });
    state = edit(state, { [field]: named.replace('Renamed', 'Renamed again') }, 'form', 1100);
    expect(configHistory(state, field).undo).toHaveLength(1);
    state = edit(state, { [field]: named.replace('Renamed', 'Renamed in JSON') }, 'json', 1200);
    expect(configHistory(state, field).undo).toHaveLength(2);
    state = edit(state, { [field]: named.replace('Renamed', 'Later') }, 'json', 2500);
    expect(configHistory(state, field).undo).toHaveLength(3);
  });
  it('never folds a new branch into the edit preceding undo', () => {
    let state = edit(configDraftState({}), { [field]: named });
    state = edit(state, { [field]: named.replace('true', 'false') }, 'structure', 1100);
    state = travelConfigHistory(state, field, 'undo').state;
    state = edit(state, { [field]: named.replace('Renamed', 'Branch') }, 'form', 1200);
    expect(configHistory(state, field).redo).toHaveLength(0);
    expect(travelConfigHistory(state, field, 'undo').state.drafts[field]).toBe(named);
  });
  it('ends a typing group on navigation without creating a data edit', () => {
    let state = edit(configDraftState({}), { [field]: named });
    state = breakConfigEditGroup(state, field);
    expect(configHistory(state, field).undo).toHaveLength(1);
    state = edit(state, { [field]: named.replace('Renamed', 'After returning') }, 'form', 1100);
    expect(configHistory(state, field).undo).toHaveLength(2);
    expect(travelConfigHistory(state, field, 'undo').state.drafts[field]).toBe(named);
  });
  it('treats edits to another property as a separate step even during one burst', () => {
    let state = edit(configDraftState({}), { [field]: named });
    state = edit(state, { [field]: named.replace('"private":7', '"private":8') }, 'form', 1100);
    expect(configHistory(state, field).undo).toHaveLength(2);
    expect(travelConfigHistory(state, field, 'undo').state.drafts[field]).toBe(named);
  });
  it('undoes owned related resources atomically while preserving another field', () => {
    const other = 'definition/user.other',
      list = 'vocabularies/user.choices';
    let state = configDraftState({ drafts: { [other]: '{"label":"untouched"}' }, baseGenerations: { [other]: 9 } });
    state = edit(state, { [field]: named, [list]: '{"items":[]}' });
    expect(hasRelatedDraftChanges(state, field)).toBe(true);
    const undone = travelConfigHistory(state, field, 'undo').state;
    expect(undone.drafts).toEqual({ [other]: '{"label":"untouched"}' });
    expect(travelConfigHistory(undone, field, 'redo').state.drafts).toEqual(state.drafts);
  });
  it('retains source edits made through another owner instead of silently overwriting', () => {
    const source = 'sources/user.shared';
    let state = edit(configDraftState({}), { [field]: named, [source]: '{"path":"one"}' });
    state = { ...state, drafts: { ...state.drafts, [source]: '{"path":"two"}' } };
    const result = travelConfigHistory(state, field, 'undo');
    expect(result.conflict).toBe(source);
    expect(result.state).toBe(state);
  });
  it('will not remove a newly shared list referenced by another retained draft', () => {
    const list = 'vocabularies/user.choices';
    let state = edit(configDraftState({}), { [field]: named, [list]: '{"items":[]}' });
    state = {
      ...state,
      drafts: { ...state.drafts, 'definition/user.other': '{"options":{"vocabulary":"user.choices"}}' },
    };
    expect(travelConfigHistory(state, field, 'undo').conflict).toBe(list);
  });
  it('provides an aggregate undo for a retained current-format draft', () => {
    const state = configDraftState({ drafts: { [field]: named }, baseGenerations: { [field]: 6 } });
    const undone = travelConfigHistory(state, field, 'undo').state;
    expect(undone.drafts[field]).toBeUndefined();
    expect(travelConfigHistory(undone, field, 'redo').state).toMatchObject({
      drafts: { [field]: named },
      baseGenerations: { [field]: 6 },
    });
  });
  it('keeps independent histories when another field is undone', () => {
    let state = edit(configDraftState({}), { [field]: named });
    const other = 'definition/user.other';
    state = recordConfigEdit(
      state,
      other,
      { ...state, drafts: { ...state.drafts, [other]: '{}' } },
      { mode: 'form', at: 3000 },
    );
    const restored = travelConfigHistory(state, field, 'undo').state;
    expect(restored.drafts[other]).toBe('{}');
    expect(configHistory(restored, other).undo).toHaveLength(1);
  });
  it('does not report a related draft as pending after it returns to the published state', () => {
    const source = 'sources/user.shared';
    const before = configDraftState({ drafts: { [source]: '{"path":"earlier"}' }, baseGenerations: { [source]: 9 } });
    let state = edit(before, { [field]: named, [source]: '{"path":"changed"}' });
    expect(hasRelatedDraftChanges(state, field)).toBe(true);
    state = edit(state, { [field]: undefined, [source]: undefined }, 'form', 3000);
    expect(hasRelatedDraftChanges(state, field)).toBe(false);
    expect(travelConfigHistory(state, field, 'undo').state.drafts[source]).toBe('{"path":"changed"}');
  });
  it('recognizes semantic equality without losing unknown fields or accepting incomplete JSON', () => {
    expect(sameConfiguration(initial, JSON.stringify(JSON.parse(initial), null, 2))).toBe(true);
    expect(sameConfiguration(initial, named)).toBe(false);
    expect(sameConfiguration(initial, '{')).toBe(false);
    let state = edit(configDraftState({}), { [field]: named });
    state = edit(state, { [field]: undefined }, 'form', 3000);
    expect(state.drafts[field]).toBeUndefined();
    expect(travelConfigHistory(state, field, 'undo').state.drafts[field]).toBe(named);
  });
});
