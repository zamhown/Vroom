import { expect, it } from 'vitest';
import {
  changeInput,
  changeValueType,
  changeVocabulary,
  compatibleInput,
  placementChoices,
  valueType,
} from './definition-designer';
import core from '../../../../resources/tagging/core.tagdefs.json';
import type { Definition } from './types';
const field: Definition = {
  key: 'example.field',
  revision: 1,
  enabled: true,
  label: { en: 'Example' },
  parents: [],
  targets: ['film-whole'],
  value: { cardinality: 'one', schema: { type: 'string', maxLength: 500 }, semanticVersion: 1 },
  input: { component: 'textarea@1', props: { rows: 4, layout: { span: 'full' } } },
  placements: [],
};
it('input changes cannot silently change the stored type, bounds, cardinality or revision', () => {
  expect(() => changeInput(field, 'multi-select@1')).toThrow();
  expect(() => changeInput(field, 'number@1')).toThrow();
  const before = JSON.stringify(field.value),
    next = changeInput(field, 'text@1');
  expect(JSON.stringify(next.value)).toBe(before);
  expect(next.input.props).toEqual({ layout: { span: 'full' } });
  expect(field.input.props?.rows).toBe(4);
});
it('data type changes create a stable entity-reference contract and recommend the matching control', () => {
  const next = changeValueType(field, 'terms', 'example.values');
  expect(next.value.cardinality).toBe('many');
  expect(next.value.schema.required).toEqual(['term']);
  expect(next.value.vocabulary).toBe('example.values');
  expect(next.input.component).toBe('multi-select@1');
  expect(next.value.semanticVersion).toBe(2);
  expect(valueType(next)).toBe('terms');
  const scalar = changeValueType(next, 'number');
  expect(scalar.value.vocabulary).toBeUndefined();
  expect(scalar.value.schema.type).toBe('number');
});
it('rating eligibility derives from data constraints while dates have an explicit value format', () => {
  const date = changeValueType(field, 'date');
  expect(date.value.schema.format).toBe('date');
  expect(date.input.component).toBe('date@1');
  expect(compatibleInput(field, 'date@1')).toBe(false);
  const integer = changeValueType(field, 'integer');
  expect(compatibleInput(integer, 'rating@1')).toBe(false);
  integer.value.schema.minimum = 1;
  integer.value.schema.maximum = 10;
  expect(compatibleInput(integer, 'rating@1')).toBe(true);
  expect(changeInput(integer, 'rating@1').value).toEqual(integer.value);
  integer.value.schema.maximum = 1000;
  expect(compatibleInput(integer, 'rating@1')).toBe(false);
});
it('preserves all unrelated strategies and display references while changing type', () => {
  const source = {
    ...field,
    initialization: [{ executor: 'fact.copy@1', args: { path: 'file.baseName' } }],
    display: { tile: { component: 'text-display@1' } },
    placements: [{ id: 'tile', slot: 'film.card.title', view: 'display.tile', mode: 'display' as const }],
  };
  const changed = changeValueType(source, 'number');
  expect(changed.initialization).toEqual(source.initialization);
  expect(changed.placements).toEqual(source.placements);
  expect(changed.display?.tile).toBeDefined();
});
it('placement options include layout-declared custom regions and respect subjects', () => {
  const pack = structuredClone(core) as any;
  pack.ui.layouts['example.layout'] = { surface: 'film.details', root: { type: 'form', region: 'example.editor' } };
  expect(placementChoices(pack, field).map(s => s.id)).toContain('film.details.fields');
  expect(placementChoices(pack, field).map(s => s.id)).toContain('example.editor');
  expect(placementChoices(pack, field).map(s => s.id)).not.toContain('term.details.fields');
  expect(placementChoices(pack, { ...field, targets: ['term-whole'] }).map(s => s.id)).toEqual(['term.details.fields']);
});

it('updates collection-dependent matching without altering unrelated rules', () => {
  const base = changeValueType(field, 'terms', 'example.old');
  base.initialization = [
    { id: 'match', executor: 'dictionary.match@1', args: { vocabulary: 'example.old', inputs: ['file.baseName'] } },
    { id: 'constant', executor: 'value.constant@1', args: { value: [] } },
  ];
  const next = changeVocabulary(base, 'example.new');
  expect(next.value.vocabulary).toBe('example.new');
  expect(next.initialization?.[0].args.vocabulary).toBe('example.new');
  expect(next.initialization?.[1]).toBe(base.initialization[1]);
  expect(base.initialization[0].args.vocabulary).toBe('example.old');
});
