import { match } from '@formatjs/intl-localematcher';

export function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/** Preserve preference order. Never match a different language or writing system. */
export function matchLanguage(requested: readonly string[], available: readonly string[], fallback: string): string {
  const supported = available.map(canonicalLocale).filter((v): v is string => !!v);
  for (const candidate of requested) {
    const canonical = canonicalLocale(candidate);
    if (!canonical) continue;
    if (supported.includes(canonical)) return canonical;
    const desired = new Intl.Locale(canonical).maximize();
    const compatible = supported.filter(id => {
      const locale = new Intl.Locale(id).maximize();
      return locale.language === desired.language && locale.script === desired.script;
    });
    if (compatible.length) return match([canonical], compatible, compatible[0]);
  }
  return fallback;
}

export function initialLanguage(
  saved: string | null,
  system: readonly string[],
  installed: readonly string[],
  fallback: string,
): string {
  return matchLanguage(saved ? [saved] : system, installed, fallback);
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
/** A locale map: non-empty, string members only, every key a known language tag. */
export function isLocaleMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key, text]) => {
      if (typeof text !== 'string') return false;
      try {
        return !!languageNames.of(Intl.getCanonicalLocales(key)[0]);
      } catch {
        return false;
      }
    })
  );
}

/** Definition languages come from the public localized-text contract, not a second registry. */
export function translationLocales(document: unknown, installed: readonly string[]): string[] {
  const locales = new Set(installed.map(canonicalLocale).filter((v): v is string => !!v));
  function visit(value: unknown, shared = false) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(item => visit(item));
      return;
    }
    const node = value as Record<string, unknown>;
    // The package default language (i18n.defaultLocale) is always a translation language.
    if (typeof node.defaultLocale === 'string') {
      const locale = canonicalLocale(node.defaultLocale);
      if (locale) locales.add(locale);
    }
    const texts = shared ? node.values : node;
    if (isLocaleMap(texts))
      for (const key of Object.keys(texts)) {
        const locale = canonicalLocale(key);
        if (locale) locales.add(locale);
      }
    if (node.i18n && typeof node.i18n === 'object') {
      const messages = (node.i18n as { messages?: Record<string, unknown> }).messages;
      Object.values(messages ?? {}).forEach(value => visit(value, true));
    }
    Object.values(node).forEach(value => visit(value));
  }
  visit(document);
  return [...locales];
}
