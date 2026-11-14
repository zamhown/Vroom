import { describe, expect, it } from 'vitest';
import { queryIssue } from './query';
import type { Definition } from './tagging/types';

describe('query draft completion', () => {
  const definitions = [{ key: 'custom.measure', enabled: true, query: { filter: true } }] as Definition[];
  it('blocks incomplete conditions at any nesting depth without changing their draft', () => {
    const draft = { op: 'and' as const, args: [{ op: 'not' as const, arg: { op: 'exists' as const, tag: '' } }] };
    expect(queryIssue(draft, definitions)).toBe('Query.chooseFieldHint');
    expect(draft.args[0].arg.tag).toBe('');
    expect(queryIssue({ op: 'eq', tag: 'custom.measure', value: NaN }, definitions)).toBe('Query.valueRequired');
    expect(queryIssue({ op: 'gte', tag: 'custom.measure', value: 0 }, definitions)).toBeUndefined();
  });
});
