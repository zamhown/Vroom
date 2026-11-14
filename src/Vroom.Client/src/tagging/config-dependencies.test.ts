import { describe, it, expect } from 'vitest';
import { definitionTargets, supportsTarget } from './annotation-targets';
import {
  configChoiceValues,
  configDependency,
  configShape,
  configWarnings,
  relatedConfigPaths,
} from './config-dependencies';
import { editConfigPath } from './config-editor';

describe('independent annotation subjects', () => {
  it('can combine values and film points without enabling whole films or intervals', () => {
    const field = { key: 'vendor.unfamiliar', targets: ['term-whole', 'film-point'] };
    expect(supportsTarget(field, 'term', 'whole')).toBe(true);
    expect(supportsTarget(field, 'film', 'point')).toBe(true);
    expect(supportsTarget(field, 'film', 'whole')).toBe(false);
    expect(supportsTarget(field, 'film', 'interval')).toBe(false);
    expect(supportsTarget(field, 'term', 'point')).toBe(false);
  });
  it('does not interpret obsolete subject combinations', () => {
    expect(definitionTargets({ targets: ['film', 'term'], temporal: ['point'] })).toEqual([]);
  });
});

describe('configuration cascades', () => {
  const field = {
    key: 'vendor.unknown',
    targets: ['film-whole'],
    input: {
      component: 'textarea@1',
      props: { rows: 5, placeholder: { en: 'Text' } },
    },
    value: { cardinality: 'one', schema: { type: 'string', maxLength: 40 } },
    extensions: { opaque: { keep: true } },
  };
  it('retains inactive control settings and reactivates them when switching back', () => {
    const switched = editConfigPath(field, ['input', 'component'], 'number@1');
    expect(configDependency('definition', switched, ['input', 'props', 'rows'])?.controller).toEqual([
      'input',
      'component',
    ]);
    expect(Object.keys(configShape('definition', switched, ['input', 'props'], {}).properties)).toEqual([
      'step',
      'layout',
    ]);
    expect(configWarnings('definition', switched)).toHaveLength(1);
    const restored = editConfigPath(switched, ['input', 'component'], 'textarea@1');
    expect(configDependency('definition', restored, ['input', 'props', 'rows'])).toBeUndefined();
    expect(restored).toEqual(field);
  });
  it('gates term and film-only settings independently without destroying existing values', () => {
    expect(configDependency('definition', field, ['subjectVocabularies'])?.controller).toEqual(['targets']);
    const term = { ...field, targets: ['term-whole', 'film-point'], subjectVocabularies: ['user.entities'] };
    expect(configDependency('definition', term, ['subjectVocabularies'])).toBeUndefined();
    expect(configDependency('definition', term, ['initialization', 0, 'args'])?.controller).toEqual(['targets']);
    expect(term.subjectVocabularies).toEqual(['user.entities']);
  });
  it('changes rule parameters and write-policy options according to the executor and value cardinality', () => {
    const document = {
      ...field,
      initialization: [
        { executor: 'fact.copy@1', apply: 'if-unset', args: { path: 'media.width', patterns: [{ pattern: '.*' }] } },
      ],
    };
    expect(Object.keys(configShape('definition', document, ['initialization', 0, 'args'], {}).properties)).toEqual([
      'path',
    ]);
    expect(configDependency('definition', document, ['initialization', 0, 'args', 'patterns'])?.controller).toEqual([
      'initialization',
      0,
      'executor',
    ]);
    expect(
      configShape('definition', document, ['initialization', 0, 'apply'], { enum: ['union', 'if-unset'] }).enum,
    ).toEqual(['if-unset']);
    expect(
      configShape('definition', document, ['enrichment', 0, 'apply'], { enum: ['union', 'if-unset'] }).enum,
    ).toEqual(['if-unset']);
    const referenced = { ...document, initialization: [{ executor: 'regex.extract@1', args: { rule: 'user.parse' } }] };
    expect(configDependency('definition', referenced, ['initialization', 0, 'args', 'patterns'])?.controller).toEqual([
      'initialization',
      0,
      'args',
      'rule',
    ]);
    expect(relatedConfigPaths('definition', document, ['initialization', 0, 'executor'])).toEqual([
      ['initialization', 0, 'args'],
    ]);
  });
  it('derives enrichment fields from the chosen source and retains a stale selection for review', () => {
    const pack = { sources: { one: { parse: { fields: { a: {} } } }, two: { parse: { fields: { b: {}, c: {} } } } } };
    const doc = { enrichment: [{ source: 'one', field: 'a' }] };
    const switched = editConfigPath(doc, ['enrichment', 0, 'source'], 'two');
    expect(configChoiceValues('definition', switched, ['enrichment', 0, 'field'], pack)).toEqual(['b', 'c']);
    expect(switched.enrichment[0].field).toBe('a');
  });
  it('cascades source transport, parser settings and nested value constraints', () => {
    const source = {
      transport: 'sidecar',
      request: { urlTemplate: 'https://example.test' },
      parse: { format: 'json', fields: { name: { selector: 'h1', pointer: '/name' } } },
    };
    expect(configDependency('sources', source, ['request', 'urlTemplate'])?.controller).toEqual(['transport']);
    expect(configDependency('sources', source, ['parse', 'fields', 'name', 'selector'])?.controller).toEqual([
      'parse',
      'format',
    ]);
    expect(configShape('sources', source, ['parse', 'fields', 'name'], {}).properties).toHaveProperty('pointer');
    const doc = { value: { schema: { type: 'array', items: { type: 'integer', minLength: 4 } } } };
    expect(configDependency('definition', doc, ['value', 'schema', 'items', 'minLength'])?.controller).toEqual([
      'value',
      'schema',
      'items',
      'type',
    ]);
  });
});
