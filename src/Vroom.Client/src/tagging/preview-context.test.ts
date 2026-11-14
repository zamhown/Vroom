import { describe, expect, it } from 'vitest';
import { previewContext, previewValue } from './preview-context';
import type { Definition, TagPackage } from './types';

const pack = {
  definitions: [],
  vocabularies: {},
  i18n: { defaultLocale: 'en', messages: {} },
  ui: {
    surfaceBindings: { 'film.details': 'example.active' },
    layouts: {
      'example.unused': { surface: 'film.details', root: { id: 'old', type: 'form', region: 'example.unused-region' } },
      'example.active': {
        surface: 'film.details',
        root: {
          id: 'root',
          type: 'grid',
          children: [
            { id: 'other', type: 'form', region: 'example.other' },
            {
              id: 'nested',
              type: 'section',
              children: [{ id: 'selected', type: 'form', region: ['example.region', 'example.second'] }],
            },
          ],
        },
      },
    },
    actions: {},
    identity: {},
    navigation: {},
    agentHints: {},
  },
  catalogPolicy: {},
} satisfies TagPackage;
const field = {
  key: 'example.measure',
  revision: 1,
  enabled: true,
  parents: [],
  targets: ['film-whole'],
  label: { en: 'Measure' },
  placements: [],
  value: { cardinality: 'one', schema: { type: 'integer', minimum: 3, maximum: 9, multipleOf: 2 }, semanticVersion: 1 },
  input: { component: 'number@1' },
} satisfies Definition;
const placement = { id: 'example', slot: 'example.region', view: 'input', mode: 'edit' } as const;

describe('contextual definition previews', () => {
  it('locates custom regions through the active layout without relying on default keys', () => {
    const context = previewContext(pack, placement);
    expect(context?.kind).toBe('layout');
    if (context?.kind === 'layout') expect(context.path.map(n => n.id)).toEqual(['root', 'nested', 'selected']);
    expect(previewContext(pack, { ...placement, slot: 'example.second' })?.kind).toBe('layout');
    expect(previewContext(pack, { ...placement, slot: 'example.unused-region' })).toBeUndefined();
  });
  it('follows changed bindings and does not claim an unbound placement is on a page', () => {
    const changed = structuredClone(pack);
    changed.ui.surfaceBindings['film.details'] = 'example.unused';
    expect(previewContext(changed, placement)).toBeUndefined();
    expect(previewContext(changed, { ...placement, slot: 'example.unused-region' })?.kind).toBe('layout');
    expect(previewContext(pack)).toBeUndefined();
  });
  it('distinguishes card, navigation, list and player host regions', () => {
    for (const [slot, kind] of [
      ['film.card.overlay.top-right', 'card'],
      ['nav.after-all-films', 'navigation'],
      ['film.table.columns', 'table'],
      ['library.sorts', 'library'],
      ['player.queue.item.trailing', 'player'],
    ])
      expect(previewContext(pack, { ...placement, slot })?.kind).toBe(kind);
  });
  it('keeps sample values local and honors bounded numeric contracts', () => {
    expect(previewValue(field, pack, 'Example')).toBe(6);
    expect(previewValue({ ...field, value: { ...field.value, cardinality: 'many' } }, pack, 'Example')).toEqual([6]);
    expect(
      previewValue(
        { ...field, value: { ...field.value, schema: { type: 'string', pattern: '^X[0-9]+$' } } },
        pack,
        'Example',
      ),
    ).toBeNull();
  });
  it('previews enum values using enabled stable IDs and never creates sample terms', () => {
    const withTerms: TagPackage = {
      ...pack,
      vocabularies: {
        'example.collection': {
          label: field.label,
          items: [
            {
              id: 'example.disabled',
              revision: 1,
              enabled: false,
              label: field.label,
              vocabularyIds: ['example.collection'],
            },
            {
              id: 'example.stable',
              revision: 1,
              enabled: true,
              label: field.label,
              vocabularyIds: ['example.collection'],
            },
          ],
        },
      },
    };
    const enumField: Definition = { ...field, value: { ...field.value, vocabulary: 'example.collection' } };
    const original = JSON.stringify(withTerms);
    expect(previewValue(enumField, withTerms, 'Example')).toEqual({ term: 'example.stable' });
    expect(previewValue(enumField, pack, 'Example')).toBeNull();
    expect(JSON.stringify(withTerms)).toBe(original);
  });
});
