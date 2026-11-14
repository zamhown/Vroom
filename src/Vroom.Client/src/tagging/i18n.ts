import { translate, formatBytes } from '../i18n';
import IntlMessageFormat from 'intl-messageformat';
import {
  isMessageReference,
  type Definition,
  type Json,
  type LocalizedText,
  type TagPackage,
  type Term,
} from './types';

function language(values: Record<string, string>, locale: string, fallback: string): string {
  const canonical = Intl.getCanonicalLocales(locale)[0] || locale;
  if (values[canonical] != null) return canonical;
  const parsed = new Intl.Locale(canonical);
  const parent = parsed.script ? `${parsed.language}-${parsed.script}` : parsed.language;
  return values[parent] != null ? parent : values[fallback] != null ? fallback : Object.keys(values)[0];
}
export function localize(
  value: LocalizedText | undefined,
  locale: string,
  pack: TagPackage,
  context: Record<string, unknown> = {},
): string {
  if (!value) return '';
  if (!isMessageReference(value)) {
    if (!Object.keys(value).length) return '';
    return value[language(value, locale, pack.i18n.defaultLocale)] ?? '';
  }
  const entry = pack.i18n.messages[value.message];
  if (!entry) return '';
  const chosen = language(entry.values, locale, pack.i18n.defaultLocale);
  const args = Object.fromEntries(
    Object.entries(value.args ?? {}).map(([key, arg]) => [key, arg.from ? (context[arg.from] ?? '') : arg.literal]),
  );
  try {
    return String(
      new IntlMessageFormat(entry.values[chosen], chosen, undefined, { ignoreTag: true }).format(
        args as Record<string, string | number>,
      ),
    );
  } catch {
    return entry.values[chosen];
  }
}
export function terms(pack: TagPackage): Term[] {
  const map = new Map(
    Object.values(pack.vocabularies ?? {})
      .flatMap(v => v.items ?? [])
      .map(t => [t.id, t]),
  );
  for (const term of pack.terms ?? []) map.set(term.id, term);
  return [...map.values()].filter(
    t => t.enabled && t.vocabularyIds.some(id => pack.vocabularies?.[id] && pack.vocabularies[id].enabled !== false),
  );
}
export function termOptions(d: Definition, pack: TagPackage) {
  if (
    !d.value.vocabulary ||
    !pack.vocabularies?.[d.value.vocabulary] ||
    pack.vocabularies[d.value.vocabulary].enabled === false
  )
    return [];
  return terms(pack)
    .filter(t => t.vocabularyIds.includes(d.value.vocabulary ?? ''))
    .map(t => ({
      id: t.id,
      label: t.label,
      value: { term: t.id },
      // Every translation and alias finds the option, whatever the interface language is.
      keywords: [
        ...Object.values(isMessageReference(t.label) ? {} : t.label),
        ...(((t as { aliases?: unknown[] }).aliases ?? []).filter(a => typeof a === 'string') as string[]),
      ],
    }));
}
export function formatValue(definition: Definition, value: Json | undefined, locale: string, pack: TagPackage): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(v => formatValue(definition, v, locale, pack)).join(' · ');
  if (typeof value === 'object') {
    const reference = terms(pack).find(d => d.id === value.term);
    return reference ? localize(reference.label, locale, pack) : '—';
  }
  if (typeof value === 'boolean') return value ? ui('yes', locale) : ui('no', locale);
  if (typeof value === 'number') {
    if (definition.value.unit === 'seconds')
      return [Math.floor(value / 3600), Math.floor(value / 60) % 60, Math.floor(value) % 60]
        .map(n => String(Math.max(0, n)).padStart(2, '0'))
        .join(':');
    if (definition.value.unit === 'bytes') return formatBytes(value, locale);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  }
  if (definition.value.schema.format === 'date' && typeof value === 'string') {
    const date = new Date(value + 'T12:00:00');
    if (!Number.isNaN(date.valueOf())) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  }
  if (definition.value.unit === 'datetime') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  }
  return String(value);
}

export const ui = (key: string, locale: string, args?: import('../i18n').MessageArgs) =>
  translate('ui.' + key, locale, args);
