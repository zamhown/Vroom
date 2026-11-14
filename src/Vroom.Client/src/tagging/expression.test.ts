import { describe, it, expect } from 'vitest';
import { evaluate } from './expression';
import type { AnnotationRecord } from './types';

describe('dynamic visibility without concrete tag knowledge', () => {
  const values = { 'user.any.key': { value: 0 } } as unknown as Record<string, AnnotationRecord>;
  it('distinguishes missing values from zero', () => {
    expect(evaluate({ op: 'exists', tag: 'user.any.key' }, values)).toBe(true);
    expect(evaluate({ op: 'gte', tag: 'removed', value: 0 }, values)).toBeUndefined();
  });
  it('combines conditions and media facts without executing source text', () => {
    expect(
      evaluate(
        {
          op: 'and',
          args: [
            { op: 'eq', tag: 'user.any.key', value: 0 },
            { op: 'gt', args: [{ fact: 'probe.duration' }, { literal: 3 }] },
          ],
        },
        values,
        { probe: { duration: 10 } },
      ),
    ).toBe(true);
    expect(evaluate({ op: 'eval', args: ['throw new Error()'] }, values)).toBeUndefined();
  });
});
