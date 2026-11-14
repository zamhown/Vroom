import { changeValueType, changeVocabulary, type ValueType } from './definition-designer';
import type { Definition, TagPackage, Term } from './types';

export interface RelatedConfigChange {
  kind: string;
  key: string;
  value: any;
}

// Collections remain part of the public contract, but a new field owns its list by default.
export function privateOptionList(field: Definition): { definition: Definition; collection: RelatedConfigChange } {
  const key = 'user.values.' + crypto.randomUUID().replaceAll('-', '');
  return {
    definition: changeVocabulary(field, key),
    collection: { kind: 'vocabularies', key, value: { label: structuredClone(field.label), enabled: true, items: [] } },
  };
}

export function prepareValueType(
  field: Definition,
  type: ValueType,
): { definition: Definition; collection?: RelatedConfigChange } {
  const definition = changeValueType(field, type);
  // An enumerable field without a chosen collection gets its own list.
  return definition.value.vocabulary === '' ? privateOptionList(definition) : { definition };
}

// Runtime value profiles override seed values. Never resurrect a disabled override.
export function optionListTerms(pack: TagPackage, vocabulary: string): Term[] {
  const all = new Map<string, Term>();
  for (const v of Object.values(pack.vocabularies ?? {})) for (const term of v.items ?? []) all.set(term.id, term);
  for (const term of pack.terms ?? []) all.set(term.id, term);
  return [...all.values()].filter(term => term.vocabularyIds.includes(vocabulary));
}

export function stageOption(collection: any, term: Term) {
  const items: Term[] = collection.items ?? [];
  return {
    ...collection,
    items: items.some(item => item.id === term.id)
      ? items.map(item => (item.id === term.id ? term : item))
      : [...items, term],
  };
}

/** Discard an unpublished owned list only when no other retained draft refers to it. */
export function unsharedListDraft(
  fieldId: string,
  drafts: Record<string, string>,
  pack: TagPackage,
): string | undefined {
  try {
    const field: Definition = JSON.parse(drafts[fieldId]);
    const key = field.value.vocabulary,
      id = 'vocabularies/' + key;
    if (!key || pack.vocabularies?.[key] || !drafts[id]) return;
    if (
      Object.entries(drafts).some(
        ([otherId, json]) => otherId !== fieldId && otherId !== id && json.includes(JSON.stringify(key)),
      )
    )
      return;
    return id;
  } catch {
    return;
  }
}
