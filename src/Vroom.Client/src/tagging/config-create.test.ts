import { describe, expect, it } from 'vitest';
import { newConfigDrafts, readableKey } from './config-create';

const pack = { i18n: { defaultLocale: 'en', messages: {} } };

describe('new configuration drafts', () => {
  it('derives readable keys from the name and keeps a unique suffix', () => {
    expect(readableKey('definition', 'Shelf Code')).toMatch(/^user\.field\.shelf-code-[0-9a-f]{6}$/);
    expect(readableKey('groups', '收藏')).toMatch(/^user\.group\.[0-9a-f]{6}$/);
  });
  it('creates an enumerable field with its own empty value list and a localized label', () => {
    const created = newConfigDrafts('definition', 'Material', 'terms', pack, 7);
    const field = JSON.parse(created.drafts[created.id]);
    expect(field.label).toEqual({ en: 'Material' });
    expect(field.value.cardinality).toBe('many');
    const list = Object.keys(created.drafts).find(id => id.startsWith('vocabularies/'))!;
    expect(field.value.vocabulary).toBe(list.slice('vocabularies/'.length));
    expect(JSON.parse(created.drafts[list]).items).toEqual([]);
    expect(Object.values(created.baseGenerations)).toEqual([7, 7]);
  });
  it('creates plain configuration objects for other kinds', () => {
    const created = newConfigDrafts('groups', 'Personal', 'text', pack, 1);
    expect(JSON.parse(created.drafts[created.id])).toEqual({ label: { en: 'Personal' } });
  });
});
