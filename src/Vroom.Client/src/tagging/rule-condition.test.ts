import { describe, expect, it } from 'vitest';
import { conditionFacts, conditionReady, emptyCondition } from './rule-condition';
import { evaluate } from './expression';
import registry from '../../../../resources/tagging/host-capabilities.json';
import type { AnnotationRecord, TagPackage } from './types';

const catalog = {
  definitions: [
    { key: 'user.measure', value: { cardinality: 'one', schema: { type: 'number' } } },
    { key: 'user.flag', value: { cardinality: 'one', schema: { type: 'boolean' } } },
    { key: 'user.date', value: { cardinality: 'one', schema: { type: 'string', format: 'date' } } },
  ],
} as unknown as TagPackage;
describe('rule execution conditions', () => {
  it('blocks an unfinished property choice, including inside a nested group', () => {
    expect(conditionReady(emptyCondition(), catalog)).toBe(false);
    expect(conditionReady({ op: 'or', args: [{ literal: true }, emptyCondition()] }, catalog)).toBe(false);
    expect(conditionReady({ op: 'exists', args: [{ tag: 'missing' }] }, catalog)).toBe(false);
  });
  it('keeps always, never, false and unknown distinct', () => {
    expect(conditionReady(undefined, catalog)).toBe(true);
    for (const literal of [true, false]) expect(conditionReady({ literal }, catalog)).toBe(true);
    for (const literal of [0, 1, '', null]) expect(conditionReady({ literal }, catalog)).toBe(false);
    expect(conditionReady({ tag: 'user.date' }, catalog)).toBe(false);
    expect(conditionReady({ op: 'and', args: [{ tag: 'user.date' }, { literal: true }] }, catalog)).toBe(false);
    expect(conditionReady({ tag: 'user.flag' }, catalog)).toBe(true);
    const condition = { op: 'not', args: [{ op: 'gte', args: [{ tag: 'user.measure' }, { literal: 600 }] }] };
    expect(conditionReady(condition, catalog)).toBe(true);
    expect(evaluate(condition, {})).toBeUndefined();
    expect(evaluate(condition, { 'user.measure': { value: 600 } as AnnotationRecord })).toBe(false);
    expect(evaluate(condition, { 'user.measure': { value: 599 } as AnnotationRecord })).toBe(true);
  });
  it('offers event properties only in events where they are available', () => {
    for (const [path, fact] of Object.entries(registry.eventFacts)) {
      const condition = { op: 'exists', args: [{ fact: path }] };
      expect(conditionFacts()[path]).toBeUndefined();
      expect(conditionReady(condition, catalog)).toBe(false);
      expect(conditionReady(condition, catalog, fact.events[0])).toBe(true);
      expect(conditionReady(condition, catalog, 'unregistered.event')).toBe(false);
    }
  });
  it('preserves complex SQL-style conditions and rejects broken operation arity', () => {
    const value = {
      op: 'between',
      args: [{ op: 'multiply', args: [{ tag: 'user.measure' }, { literal: 60 }] }, { literal: 600 }, { literal: 1800 }],
    };
    const before = JSON.stringify(value);
    expect(conditionReady(value, catalog)).toBe(true);
    expect(JSON.stringify(value)).toBe(before);
    expect(conditionReady({ ...value, args: value.args.slice(0, 2) }, catalog)).toBe(false);
  });
});
