import { describe, expect, it } from 'vitest';
import { rangeCases } from './numeric-rules';
import { evaluate } from './expression';

describe('visual numeric ranges', () => {
  const values = [{ term: 'a' }, { term: 'b' }, { term: 'c' }];
  it('converts minutes once and covers adjacent boundaries without overlap', () => {
    const cases = rangeCases('probe.duration', [10, 30], values, 60)!;
    for (const [seconds, term] of [
      [0, 'a'],
      [599.99, 'a'],
      [600, 'b'],
      [1799.99, 'b'],
      [1800, 'c'],
      [86400, 'c'],
    ] as const) {
      const matches = cases.filter(row => evaluate(row.when, {}, { probe: { duration: seconds } }) === true);
      expect(matches.map(row => row.value)).toEqual([{ term }]);
    }
    expect(cases.some(row => evaluate(row.when, {}, { probe: {} }) === true)).toBe(false);
    expect(cases.some(row => evaluate(row.when, {}, { probe: { duration: -1 } }) === true)).toBe(false);
  });
  it('rejects invalid boundaries and works with a different media property', () => {
    for (const boundaries of [[0, 30], [30, 10], [10, 10], [10, Infinity], [10]])
      expect(rangeCases('file.size', boundaries, values)).toBeUndefined();
    const cases = rangeCases('file.size', [1, 2], values, 1024 * 1024)!;
    expect(
      cases.filter(row => evaluate(row.when, {}, { file: { size: 1048576 } }) === true).map(row => row.value),
    ).toEqual([{ term: 'b' }]);
  });
});
