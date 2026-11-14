import { prepareValueType } from './option-list';
import type { ValueType } from './definition-designer';
import type { Definition, TagPackage } from './types';

/** Readable, immutable keys: an ASCII slug of the name plus a short suffix that keeps them unique. */
export function readableKey(kind: string, name: string) {
  const prefix = kind === 'definition' ? 'user.field.' : kind === 'vocabularies' ? 'user.values.' : 'user.group.';
  const slug = name
    .trim()
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return prefix + (slug ? slug + '-' : '') + crypto.randomUUID().slice(0, 6);
}

/** Drafts for a new field, value collection or group, including a new field's own value list. */
export function newConfigDrafts(
  kind: string,
  name: string,
  type: ValueType,
  pack: Pick<TagPackage, 'i18n'>,
  generation: number,
) {
  const key = readableKey(kind, name);
  const label = { [pack.i18n.defaultLocale]: name.trim() };
  const definition: Definition = {
    key,
    revision: 1,
    enabled: true,
    label,
    parents: [],
    // New fields annotate whole films; time ranges and duplicate checks are opt-in.
    targets: ['film-whole'],
    value: { cardinality: 'one', schema: { type: 'string' }, semanticVersion: 1 },
    input: { component: 'text@1' },
    placements: [{ id: 'details', slot: 'film.details.fields', view: 'input', mode: 'edit' }],
    query: { filter: true, sort: true, groupBy: ['value'], deduplicate: false },
    writes: { manual: true },
  };
  const prepared = kind === 'definition' ? prepareValueType(definition, type) : undefined;
  const value = prepared?.definition ?? (kind === 'vocabularies' ? { label, enabled: true, items: [] } : { label });
  const id = kind + '/' + key;
  const drafts: Record<string, string> = { [id]: JSON.stringify(value, null, 2) },
    baseGenerations: Record<string, number> = { [id]: generation };
  if (prepared?.collection) {
    const relatedId = prepared.collection.kind + '/' + prepared.collection.key;
    drafts[relatedId] = JSON.stringify(prepared.collection.value, null, 2);
    baseGenerations[relatedId] = generation;
  }
  return { key, id, drafts, baseGenerations };
}
