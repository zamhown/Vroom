import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledPacks,
  defaultLocale,
  getLocale,
  installedLanguages,
  rejectedLanguagePacks,
  setInstalledPacks,
  setLanguage,
  translate,
  validateLanguagePack,
  type LanguagePack,
} from './index';
import { initialLanguage, matchLanguage, translationLocales } from './locale';

afterEach(() => {
  setInstalledPacks([]);
  setLanguage(defaultLocale);
});
describe('installed language packs', () => {
  it('renders regex capture placeholders as literal guidance without interpolation arguments', () => {
    for (const locale of ['zh-CN', 'en']) {
      const help = translate('DefinitionRulesEditor.isTheFullMatchIsTheFirst', locale);
      expect(help).toContain('{0}');
      expect(help).toContain('{1}');
      expect(help).not.toContain('DefinitionRulesEditor.');
    }
  });
  it('ships complete packs with valid ICU syntax and identical interpolation arguments', () => {
    const base = bundledPacks.find(pack => pack.locale === defaultLocale)!;
    expect(bundledPacks.map(pack => pack.locale)).toEqual(expect.arrayContaining(['zh-CN', 'en']));
    for (const pack of bundledPacks) {
      expect(Object.keys(pack.messages).sort()).toEqual(Object.keys(base.messages).sort());
      expect(() => validateLanguagePack(pack)).not.toThrow();
    }
  });
  it('matches system preferences without treating unrelated languages or scripts as English', () => {
    expect(initialLanguage(null, ['en-AU'], ['zh-CN', 'en'], 'zh-CN')).toBe('en');
    expect(initialLanguage(null, ['de-DE', 'en-GB'], ['zh-CN', 'en'], 'zh-CN')).toBe('en');
    expect(initialLanguage(null, ['de-DE'], ['zh-CN', 'en'], 'zh-CN')).toBe('zh-CN');
    expect(matchLanguage(['sr-Latn-BA'], ['sr-Cyrl', 'sr-Latn'], 'en')).toBe('sr-Latn');
    expect(matchLanguage(['zh-Hant'], ['zh-CN', 'en'], 'en')).toBe('en');
    expect(matchLanguage(['bad_locale'], ['en'], 'en')).toBe('en');
  });
  it('keeps a stored choice on later launches and falls back when its pack is absent', () => {
    expect(initialLanguage('en', ['zh-CN'], ['zh-CN', 'en'], 'zh-CN')).toBe('en');
    expect(initialLanguage('fr', ['en'], ['zh-CN', 'en'], 'zh-CN')).toBe('zh-CN');
  });
  it('installs an unfamiliar pack, formats plurals and falls back per message without changing declarations', () => {
    const french: LanguagePack = {
      formatVersion: 1,
      locale: 'fr',
      displayName: 'Français',
      direction: 'ltr',
      messages: { 'ui.cancel': 'Annuler', 'config.itemCount': '{count, plural, one {# élément} other {# éléments}}' },
    };
    setInstalledPacks([french]);
    setLanguage('fr-CA');
    expect(getLocale()).toBe('fr');
    expect(translate('ui.cancel')).toBe('Annuler');
    expect(translate('config.itemCount', 'fr', { count: 2 })).toBe('2 éléments');
    expect(translate('ui.save')).toBe(translate('ui.save', defaultLocale));
    setInstalledPacks([]);
    expect(getLocale()).toBe(defaultLocale);
  });
  it('rejects malformed packs and isolates persisted invalid packs from startup', () => {
    const pack: LanguagePack = {
      formatVersion: 1,
      locale: 'fr',
      displayName: 'Français',
      direction: 'ltr',
      messages: { 'ui.cancel': 'Annuler' },
    };
    expect(() => validateLanguagePack({ ...pack, formatVersion: 2 })).toThrow();
    expect(() => validateLanguagePack({ ...pack, locale: '../fr' })).toThrow();
    expect(() => validateLanguagePack({ ...pack, messages: { 'ui.cancel': '{unexpected}' } })).toThrow();
    expect(() =>
      validateLanguagePack({ ...pack, messages: { 'config.itemCount': '{count, plural, one {x}}' } }),
    ).toThrow();
    expect(() => validateLanguagePack({ ...pack, messages: { 'unknown.key': 'x' } })).toThrow();
    setInstalledPacks([{ ...pack, messages: { 'ui.cancel': '{' } }]);
    expect(installedLanguages().some(p => p.locale === 'fr')).toBe(false);
    expect(rejectedLanguagePacks()).toHaveLength(1);
    expect(translate('ui.cancel')).not.toBe('ui.cancel');
  });
  it('unions installed packs and all declared literal/shared locales, without guessing from annotation data', () => {
    const document = {
      i18n: { defaultLocale: 'de', messages: { shared: { values: { 'sr-Latn': 'Text' } } } },
      definitions: [
        {
          label: { 'fr-CA': 'Nom', ja: '名' },
          extensions: { values: { cost: 'literal data' } },
        },
      ],
    };
    const before = structuredClone(document);
    expect(translationLocales(document, ['en', 'zh-CN', 'en'])).toEqual([
      'en',
      'zh-CN',
      'sr-Latn',
      'de',
      'fr-CA',
      'ja',
    ]);
    expect(document).toEqual(before);
  });
});
