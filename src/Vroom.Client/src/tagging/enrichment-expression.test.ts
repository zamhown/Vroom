import { expect, it } from 'vitest';
import fixtures from '../../../../tests/Vroom.Tests/Fixtures/enrichment-expressions.json';
import { evaluate } from './expression';
it.each(fixtures.map((row, index) => ({ ...row, index })))(
  'matches host source expression fixture $index ($op)',
  row => {
    const expression = { op: row.op, args: row.args.map(literal => ({ literal })) };
    expect(evaluate(expression, {}) ?? null).toEqual(row.expected);
  },
);
