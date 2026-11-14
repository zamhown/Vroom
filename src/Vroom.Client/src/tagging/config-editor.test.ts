import { describe, expect, it } from 'vitest';
import {
  availableTranslationLanguages,
  editConfigPath,
  removeLocalizedText,
  updateDefaultLocalizedText,
  updateLocalizedText,
} from './config-editor';

describe('configuration form round trips', () => {
  it('edits a nested setting without losing translations, future components or extensions', () => {
    const original = {
      key: 'user.custom',
      label: { fr: 'Couleur', en: 'Color' },
      input: { component: 'custom@9', props: { width: 2, future: { opaque: [1, 2] } } },
      extension: { version: 99 },
    };
    const edited = editConfigPath(JSON.parse(JSON.stringify(original)), ['input', 'props', 'width'], 4);
    expect(edited.input.props.width).toBe(4);
    expect(edited.input.component).toBe('custom@9');
    expect(edited.input.props.future).toEqual(original.input.props.future);
    expect(edited.label).toEqual(original.label);
    expect(edited.extension).toEqual(original.extension);
    expect(original.input.props.width).toBe(2);
  });
  it('removes one list entry while retaining the remaining values and order', () => {
    const original = {
      placements: [
        { id: 'a', order: 1 },
        { id: 'b', order: 2 },
        { id: 'c', order: 3 },
      ],
    };
    expect(editConfigPath(original, ['placements', 1], undefined)).toEqual({
      placements: [original.placements[0], original.placements[2]],
    });
    expect(original.placements).toHaveLength(3);
  });
  it('adds a translation without replacing the default locale or other languages', () => {
    expect(updateLocalizedText({ fr: 'Bonjour', en: 'Hello' }, 'zh-CN', '你好')).toEqual({
      fr: 'Bonjour',
      en: 'Hello',
      'zh-CN': '你好',
    });
  });
  it('inline editing follows the global default and preserves existing regional translations', () => {
    const value = { 'fr-CA': 'Couleur', fr: 'Teinte', en: 'Color' };
    expect(updateDefaultLocalizedText(value, 'en', 'New color')).toEqual({
      'fr-CA': 'Couleur',
      fr: 'Teinte',
      en: 'New color',
    });
    expect(value['fr-CA']).toBe('Couleur');
  });
  it('keeps an empty default value and initializes absent text in the configured default', () => {
    expect(updateDefaultLocalizedText({ ja: '名称', en: 'Name' }, 'en', '')).toEqual({ ja: '名称', en: '' });
    expect(updateDefaultLocalizedText(undefined, 'de', 'Titel')).toEqual({ de: 'Titel' });
  });
  it('does not implicitly flatten a shared message or discard its dynamic arguments', () => {
    const value = { message: 'user.summary', args: { count: { from: 'count' } } };
    expect(() => updateDefaultLocalizedText(value, 'en', 'Replacement')).toThrow();
    expect(value).toEqual({ message: 'user.summary', args: { count: { from: 'count' } } });
  });
  it('keeps untrusted extension property names as data rather than modifying prototypes', () => {
    const edited = editConfigPath({}, ['__proto__', 'injected'], true);
    expect(Object.getPrototypeOf(edited)).toBe(Object.prototype);
    expect(Object.hasOwn(edited, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });
  it('offers languages from installed packs and the document while preserving regional translations independently', () => {
    const value = { 'en-US': 'Label', ja: '保持' };
    const document = { label: { 'fr-CA': 'Nom', 'sr-Latn': 'Ime' } };
    const available = availableTranslationLanguages(value, document);
    expect(available).toContain('zh-CN');
    expect(available).toContain('en');
    expect(available).toContain('fr-CA');
    expect(available).toContain('sr-Latn');
    expect(available).not.toContain('ja');
    expect(available).not.toContain('en-US');
    const edited = updateLocalizedText(value, 'zh-CN', '名称');
    expect(edited).toEqual({ 'en-US': 'Label', ja: '保持', 'zh-CN': '名称' });
    expect(value).toEqual({ 'en-US': 'Label', ja: '保持' });
  });
  it('preserves the default language and unrelated translations when a row is removed', () => {
    const value = { 'zh-CN': '名称', en: 'Name', ja: '保持' };
    expect(removeLocalizedText(value, 'zh-CN', 'zh-CN')).toBe(value);
    expect(removeLocalizedText(value, 'en', 'zh-CN')).toEqual({ 'zh-CN': '名称', ja: '保持' });
    expect(availableTranslationLanguages(removeLocalizedText(value, 'en', 'zh-CN'))).toContain('en');
    expect(availableTranslationLanguages(value)).not.toContain('en');
  });
  it('protects the global language when removing a translation recorded as the document source', () => {
    const value = { fr: 'Source', en: 'Global', ja: '保持' };
    expect(removeLocalizedText(value, 'en', 'en')).toBe(value);
    expect(removeLocalizedText(value, 'fr', 'en')).toEqual({ en: 'Global', ja: '保持' });
  });
});
