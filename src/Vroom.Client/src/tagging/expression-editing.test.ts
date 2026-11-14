import { describe, expect, it } from 'vitest';
import { argumentRole, argumentType, expressionType, replaceOperation } from './expression-editing';
import { operations } from './operators';
import { evaluate } from './expression';
import type { TagPackage } from './types';

const catalog = {
  definitions: [{ key: 'user.sample', value: { schema: { type: 'number' }, cardinality: 'one' } }],
} as unknown as TagPackage;
describe('semantic rule editing', () => {
  it('keeps the read source while switching comparison shape', () => {
    const source = { tag: 'user.sample' },
      before = { op: 'gte', args: [source, { literal: 10 }] };
    const range = replaceOperation(before, 'between', catalog);
    expect(range.args).toEqual([source, { literal: 10 }, { literal: 0 }]);
    expect(replaceOperation(range, 'in', catalog).args).toEqual([source, { literal: [] }]);
    expect(replaceOperation(before, 'exists', catalog).args).toEqual([source]);
    expect(before).toEqual({ op: 'gte', args: [source, { literal: 10 }] });
  });
  it('wraps an existing calculation in a conditional without losing it', () => {
    const existing = { op: 'add', args: [{ literal: 2 }, { literal: 3 }] };
    const branch = replaceOperation(existing, 'case', catalog);
    expect(branch.args[1]).toEqual(existing);
    branch.args[0] = { literal: true };
    expect(evaluate(branch, {})).toBe(5);
    expect(argumentRole('case', 0, 3)).toBe('when');
    expect(argumentRole('case', 1, 3)).toBe('then');
    expect(argumentRole('case', 2, 3)).toBe('otherwise');
  });
  it('distinguishes collection, scalar and null-aware comparisons', () => {
    expect(argumentType('in', 1, { args: [{ literal: 'x' }, { literal: [] }] }, catalog)).toBe('array');
    expect(argumentType('eq', 1, { args: [{ tag: 'user.sample' }, { literal: null }] }, catalog)).toBe('number');
    expect(expressionType({ op: 'is', args: [{ literal: null }, { literal: null }] }, catalog)).toBe('boolean');
    expect(replaceOperation({ literal: 'kept' }, 'concat', catalog).args[0]).toEqual({ literal: 'kept' });
  });
  it('retains every registered operation and its required argument count', () => {
    for (const [op, info] of Object.entries(operations)) {
      const next = replaceOperation({ literal: 1 }, op, catalog);
      expect(next.args.length, op).toBeGreaterThanOrEqual(info.minArgs);
      expect(next.args.length, op).toBeLessThanOrEqual(info.maxArgs);
      next.args.forEach((_: unknown, i: number) => expect(argumentRole(op, i, next.args.length), op).toBeTruthy());
    }
  });
});
