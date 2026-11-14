import { expect, it } from 'vitest';
import { optionListTerms, prepareValueType, stageOption, unsharedListDraft } from './option-list';
import { termOptions } from './i18n';
import { previewValue } from './preview-context';
import type { Definition, TagPackage, Term } from './types';

const field: Definition = {
  key: 'example.material',
  revision: 1,
  enabled: true,
  label: { en: 'Material' },
  parents: [],
  targets: ['film-whole'],
  value: { cardinality: 'one', schema: { type: 'string' }, semanticVersion: 1 },
  input: { component: 'text@1' },
  placements: [],
};
const term: Term = {
  id: 'example.cotton',
  revision: 1,
  enabled: true,
  label: { en: 'Cotton' },
  vocabularyIds: ['example.materials'],
};
const pack = (vocabularies: any, terms: Term[] = []): TagPackage => ({
  vocabularies,
  terms,
  definitions: [],
  catalogPolicy: {},
  ui: { layouts: {}, surfaceBindings: {}, actions: {}, identity: {}, navigation: {}, agentHints: {} },
  i18n: { defaultLocale: 'en', messages: {} },
});

it('new enum fields have independent empty lists without selecting a global collection', () => {
  const first = prepareValueType(field, 'terms'),
    second = prepareValueType({ ...field, key: 'example.other' }, 'terms');
  expect(first.collection?.key).not.toBe(second.collection?.key);
  expect(first.definition.value.vocabulary).toBe(first.collection?.key);
  expect(first.collection?.value.items).toEqual([]);
  expect(first.collection?.value.label).toEqual(field.label);
  expect(field.value.vocabulary).toBeUndefined();
  expect(prepareValueType(field, 'integer').collection).toBeUndefined();
});

it('changing one versus many retains option identity and shared collection references', () => {
  const source = {
    ...prepareValueType(field, 'term').definition,
    writes: { manual: true, createTerms: { namespace: 'example.value' } },
  };
  source.value = { ...source.value, vocabulary: 'example.materials' };
  const many = prepareValueType(source, 'terms');
  expect(many.collection).toBeUndefined();
  expect(many.definition.value.vocabulary).toEqual(source.value.vocabulary);
  expect(many.definition.value.schema.required).toEqual(['term']);
});

it('new option drafts are previewable and publishable with the field without touching the published catalog', () => {
  const next = prepareValueType(field, 'term'),
    collection = next.collection!;
  const added = { ...term, vocabularyIds: [collection.key] };
  const draft = stageOption(collection.value, added),
    catalog = pack({ [collection.key]: draft });
  expect(collection.value.items).toEqual([]);
  expect(termOptions(next.definition, catalog)[0].value).toEqual({ term: term.id });
  expect(previewValue(next.definition, catalog, 'Example')).toEqual({ term: term.id });
  expect(stageOption(draft, { ...added, label: { en: 'Renamed' } }).items).toHaveLength(1);
});

it('runtime profiles win over seeds, including disabled options; renames preserve references', () => {
  const vocabulary = { label: field.label, enabled: true, items: [term] };
  const disabled = { ...term, revision: 2, enabled: false, label: { en: 'Renamed' } };
  const catalog = pack({ 'example.materials': vocabulary }, [disabled]);
  const base = prepareValueType(field, 'term').definition;
  const d = { ...base, value: { ...base.value, vocabulary: 'example.materials' } };
  expect(optionListTerms(catalog, 'example.materials')).toEqual([disabled]);
  expect(termOptions(d, catalog)).toEqual([]);
  catalog.terms = [{ ...disabled, enabled: true }];
  expect(termOptions(d, catalog)[0].value).toEqual({ term: term.id });
  expect(optionListTerms(catalog, 'example.unrelated')).toEqual([]);
});

it('discarding a new enum draft only removes its unshared unpublished list', () => {
  const next = prepareValueType(field, 'terms'),
    collection = next.collection!;
  const fieldId = 'definition/' + field.key,
    listId = 'vocabularies/' + collection.key;
  const drafts = { [fieldId]: JSON.stringify(next.definition), [listId]: JSON.stringify(collection.value) };
  expect(unsharedListDraft(fieldId, drafts, pack({}))).toBe(listId);
  expect(
    unsharedListDraft(fieldId, { ...drafts, 'definition/example.other': JSON.stringify(next.definition) }, pack({})),
  ).toBeUndefined();
  expect(unsharedListDraft(fieldId, drafts, pack({ [collection.key]: collection.value }))).toBeUndefined();
});
