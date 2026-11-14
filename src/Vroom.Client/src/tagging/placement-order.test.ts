import { describe, expect, it } from 'vitest';
import { placements } from './LayoutFrame';
import type { Definition, TagPackage } from './types';

const field = (key: string, slot = 'example.region'): Definition =>
  ({
    key,
    revision: 1,
    enabled: true,
    label: { en: key },
    parents: [],
    targets: ['film-whole'],
    value: { cardinality: 'one', schema: { type: 'string' }, semanticVersion: 1 },
    input: { component: 'text@1' },
    placements: [{ id: 'p', slot, view: 'input', mode: 'edit' }],
  }) as unknown as Definition;

describe('region-owned member order', () => {
  it('lists members in the region order, then unlisted members by key, with regions in the requested order', () => {
    const pack = {
      definitions: [field('example.c'), field('example.a'), field('example.b'), field('example.z', 'example.second')],
      ui: { placementOrder: { 'example.region': ['example.b', 'example.c'] } },
    } as unknown as TagPackage;
    expect(placements(pack, 'example.region').map(x => x.definition.key)).toEqual([
      'example.b',
      'example.c',
      'example.a',
    ]);
    expect(placements(pack, ['example.second', 'example.region']).map(x => x.definition.key)[0]).toBe('example.z');
  });
});
