import { describe, expect, it } from 'vitest';
import { compareValue, conditionOperators, operations } from './operators';
import { evaluate } from './expression';
import type { Json } from './types';

describe('SQL operators in local previews', () => {
  it.each<[string, Json, Json | undefined, Json | undefined, boolean | null]>([
    ['eq', 1, 1, undefined, true],
    ['ne', null, 1, undefined, null],
    ['is', null, null, undefined, true],
    ['is-not', null, 1, undefined, true],
    ['between', 10, 10, 30, true],
    ['not-between', 30, 10, 30, false],
    ['between', 5, 10, null, false],
    ['between', 15, 10, null, null],
    ['in', 2, [1, null], undefined, null],
    ['in', 1, [1, null], undefined, true],
    ['not-in', null, [], undefined, true],
    ['like', 'a_50%', 'A\\_50\\%', undefined, true],
    ['not-like', 'æ', 'Æ', undefined, true],
    ['like', '😀', '_', undefined, true],
    ['glob', 'A9', '[A-Z][0-9]', undefined, true],
    ['not-glob', 'a9', '[A-Z]*', undefined, true],
    ['glob', ']', '[]]', undefined, true],
    ['glob', 'x', '[^]]', undefined, true],
    ['contains', 'A_50%', '50%', undefined, true],
    ['starts-with', 'A_50%', 'a_', undefined, true],
    ['ends-with', 'A_50%', '%', undefined, true],
    ['eq', { a: 1, b: 2 }, { b: 2, a: 1 }, undefined, true],
    ['has', [{ term: 'x' }], { term: 'x' }, undefined, true],
  ])('%s preserves expected typed SQL semantics', (op, a, b, c, result) =>
    expect(compareValue(op, a, b, c)).toBe(result),
  );
  const expr = (op: string, ...values: any[]) => ({ op, args: values.map(literal => ({ literal })) });
  it('keeps unknown values unknown through compound logic', () => {
    for (const a of [true, false, null])
      for (const b of [true, false, null]) {
        expect(evaluate(expr('and', a, b), {})).toBe(
          a === false || b === false ? false : a == null || b == null ? undefined : true,
        );
        expect(evaluate(expr('or', a, b), {})).toBe(
          a === true || b === true ? true : a == null || b == null ? undefined : false,
        );
      }
    expect(evaluate(expr('not', null), {})).toBeUndefined();
    expect(evaluate({ op: 'not', args: [expr('like', 'x'.repeat(4000), '%'.repeat(4000))] }, {})).toBeUndefined();
  });
  it('evaluates arithmetic, null functions and lazy CASE without coercing missing facts', () => {
    expect(evaluate(expr('divide', 3, 2), {})).toBe(1.5);
    expect(evaluate(expr('divide', 1, 0), {})).toBeUndefined();
    expect(evaluate(expr('add', null, 3), {})).toBeUndefined();
    expect(evaluate(expr('coalesce', null, 0, 4), {})).toBe(0);
    expect(evaluate(expr('nullif', 3, 3), {})).toBeUndefined();
    expect(evaluate(expr('concat', 'a', null), {})).toBeUndefined();
    expect(evaluate(expr('round', -1.25, 1), {})).toBe(-1.3);
    expect(evaluate(expr('modulo', 5.6, 2.2), {})).toBe(1);
    expect(evaluate(expr('case', null, 'ignored', true, 'chosen', 'fallback'), {})).toBe('chosen');
    expect(evaluate(expr('length', '😀a'), {})).toBe(2);
  });
  it('offers every compatible registered predicate, with no numeric comparisons on booleans', () => {
    expect(conditionOperators('number')).toEqual(
      expect.arrayContaining(['gte', 'lt', 'between', 'not-between', 'in', 'not-in', 'is', 'is-not', 'missing']),
    );
    expect(conditionOperators('string')).toEqual(
      expect.arrayContaining(['like', 'not-like', 'glob', 'starts-with', 'ends-with']),
    );
    expect(conditionOperators('boolean')).not.toContain('between');
    expect(conditionOperators('array', true)).toContain('has');
    for (const op of Object.values(operations)) expect(op.minArgs).toBeLessThanOrEqual(op.maxArgs);
  });
});
