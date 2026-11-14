import IntlMessageFormat from 'intl-messageformat';
import { parse, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import manifest from '../../../../resources/localization/manifest.json';
import { canonicalLocale, matchLanguage } from './locale';

export interface LanguagePack {
  formatVersion: 1;
  locale: string;
  displayName: string;
  direction: 'ltr' | 'rtl';
  messages: Record<string, string>;
}
export type MessageArgs = Record<string, string | number | boolean | Date | null | undefined>;
export const defaultLocale = manifest.defaultLocale;
const files = import.meta.glob<LanguagePack>('../../../../resources/localization/packs/*.json', {
  eager: true,
  import: 'default',
});
export const bundledPacks = Object.values(files);
let packs = new Map(bundledPacks.map(pack => [pack.locale, pack]));
let currentLocale = defaultLocale;
let rejected: { locale: string; displayName: string; error: string }[] = [];
let version = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, IntlMessageFormat>();
const changed = () => {
  version++;
  cache.clear();
  listeners.forEach(fn => fn());
};
export const subscribeLanguage = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const languageVersion = () => version;
export const getLocale = () => currentLocale;
export const installedLanguages = () => [...packs.values()];
export const rejectedLanguagePacks = () => rejected;
export function setLanguage(locale: string) {
  currentLocale = matchLanguage([locale], [...packs.keys()], defaultLocale);
  cache.clear();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLocale;
    document.documentElement.dir = packs.get(currentLocale)?.direction ?? 'ltr';
    document.title = translate('app.windowTitle', currentLocale);
  }
  changed();
}
export function setInstalledPacks(installed: LanguagePack[]) {
  const accepted: LanguagePack[] = [];
  rejected = [];
  for (const pack of installed) {
    try {
      validateLanguagePack(pack);
      if (bundledPacks.some(builtin => builtin.locale === pack.locale)) throw new Error('error.LANGUAGE_PACK_BUILTIN');
      accepted.push(pack);
    } catch (error) {
      rejected.push({
        locale: String(pack?.locale ?? ''),
        displayName: String(pack?.displayName ?? ''),
        error: String(error),
      });
    }
  }
  packs = new Map([...bundledPacks, ...accepted].map(pack => [pack.locale, pack]));
  setLanguage(currentLocale);
}
function argumentsOf(ast: MessageFormatElement[], into = new Set<string>()) {
  for (const element of ast) {
    if (element.type !== 0 && element.type !== 7) into.add(element.value);
    if ('options' in element) Object.values(element.options).forEach(option => argumentsOf(option.value, into));
    if ('children' in element) argumentsOf(element.children, into);
  }
  return [...into].sort().join('|');
}
export function validateLanguagePack(value: unknown): asserts value is LanguagePack {
  const pack = value as LanguagePack;
  if (
    !pack ||
    pack.formatVersion !== 1 ||
    typeof pack.locale !== 'string' ||
    canonicalLocale(pack.locale) !== pack.locale ||
    typeof pack.displayName !== 'string' ||
    !pack.displayName.trim() ||
    !['ltr', 'rtl'].includes(pack.direction) ||
    !pack.messages ||
    Array.isArray(pack.messages) ||
    typeof pack.messages !== 'object' ||
    Object.keys(pack).some(key => !['formatVersion', 'locale', 'displayName', 'direction', 'messages'].includes(key))
  )
    throw new Error('error.LANGUAGE_PACK_INVALID');
  const base = bundledPacks.find(pack => pack.locale === defaultLocale)!;
  for (const [key, pattern] of Object.entries(pack.messages)) {
    if (!Object.hasOwn(base.messages, key) || typeof pattern !== 'string' || !pattern.trim())
      throw new Error('error.LANGUAGE_PACK_MESSAGE_INVALID', { cause: key });
    let ast: MessageFormatElement[];
    try {
      ast = parse(pattern, { ignoreTag: true });
    } catch (cause) {
      throw new Error('error.LANGUAGE_PACK_MESSAGE_INVALID', { cause });
    }
    if (argumentsOf(ast) !== argumentsOf(parse(base.messages[key], { ignoreTag: true })))
      throw new Error('error.LANGUAGE_PACK_ARGUMENTS_INVALID', { cause: key });
  }
}
export function translate(key: string, locale = currentLocale, args: MessageArgs = {}): string {
  const id = matchLanguage([locale], [...packs.keys()], defaultLocale);
  const source = packs.get(id)?.messages[key] != null ? packs.get(id)! : packs.get(defaultLocale)!;
  const pattern = source?.messages[key];
  if (pattern == null) return key;
  const cacheKey = source.locale + ':' + key;
  let formatter = cache.get(cacheKey);
  if (!formatter) {
    formatter = new IntlMessageFormat(pattern, source.locale, undefined, { ignoreTag: true });
    cache.set(cacheKey, formatter);
  }
  try {
    return String(formatter.format(args));
  } catch {
    return key;
  } // A missing parameter must not break the workspace or discard an editing draft.
}
export const t = (key: string, args?: MessageArgs) => translate(key, currentLocale, args);
/** One byte formatter for every surface: binary units with locale-aware digits. */
export const formatBytes = (value: number, locale: string = currentLocale) => {
  const exponent = Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))));
  return (
    new Intl.NumberFormat(locale, { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(value / 1024 ** exponent) +
    ' ' +
    ['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]
  );
};
