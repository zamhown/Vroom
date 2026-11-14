import { describe, expect, it } from 'vitest';
import { formatValue, localize, termOptions, terms } from './i18n';
import defaults from '../../../../resources/tagging/core.tagdefs.json';
import type { Definition, TagPackage } from './types';

const pack = defaults as unknown as TagPackage;
describe('schema text and values', () => {
  it('uses one package fallback for both literal and shared text, without rewriting either', () => {
    const text = { en: 'Source', fr: 'Global' };
    const custom = {
      ...pack,
      i18n: { defaultLocale: 'fr', messages: { example: { values: text } } },
    } as TagPackage;
    expect(localize(text, 'ja', custom)).toBe('Global');
    expect(localize({ message: 'example' }, 'ja', custom)).toBe('Global');
    expect(localize(text, 'en', custom)).toBe('Source');
    // Without a package default for the requested language the package default wins, then the first entry.
    expect(localize(text, 'ja', { ...custom, i18n: { defaultLocale: 'de', messages: {} } } as TagPackage)).toBe(
      'Source',
    );
  });
  it('uses script-aware fallback and keeps stored literals unchanged', () => {
    expect(localize({ en: 'Default', 'zh-Hant': '標籤' }, 'zh-Hant-TW', pack)).toBe('標籤');
    const field = { key: 'user.unfamiliar', value: { schema: {}, cardinality: 'one' } } as Definition;
    expect(formatValue(field, 'Literal Name', 'zh-CN', pack)).toBe('Literal Name');
  });
  it('formats ICU messages and units without knowing a tag key', () => {
    const custom = {
      ...pack,
      i18n: {
        defaultLocale: 'en',
        messages: { count: { values: { en: '{n, plural, one {# item} other {# items}}' } } },
      },
    } as TagPackage;
    expect(localize({ message: 'count', args: { n: { literal: 2 } } }, 'en-US', custom)).toBe('2 items');
    expect(formatValue({ value: { unit: 'seconds' } } as Definition, 90061, 'en-US', pack)).toBe('25:01:01');
  });
  it('does not resurrect a disabled fixed value or an orphaned vocabulary', () => {
    const value = {
      id: 'example.a',
      revision: 1,
      enabled: true,
      label: { en: 'A' },
      vocabularyIds: ['example.values'],
    };
    const custom = {
      ...pack,
      vocabularies: { 'example.values': { enabled: true, label: value.label, items: [value] } },
      terms: [{ ...value, revision: 2, enabled: false }],
    } as TagPackage;
    expect(terms(custom)).toEqual([]);
    custom.terms = [{ ...value, enabled: true, vocabularyIds: ['removed'] }];
    expect(terms(custom)).toEqual([]);
  });
  it('keeps identity when a value is renamed using stable references', () => {
    const value = {
      id: 'example.a',
      revision: 2,
      enabled: true,
      label: { en: 'New name' },
      vocabularyIds: ['example.values'],
    };
    const custom = {
      ...pack,
      vocabularies: { 'example.values': { enabled: true, label: value.label, items: [] } },
      terms: [value],
    } as TagPackage;
    const field = {
      value: { cardinality: 'one', schema: { type: 'string' }, vocabulary: 'example.values' },
    } as unknown as Definition;
    expect(termOptions(field, custom)[0]).toMatchObject({ id: 'example.a', value: { term: 'example.a' } });
    expect(formatValue(field, { term: 'example.a' }, 'en-US', custom)).toBe('New name');
  });
});
