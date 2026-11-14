import { describe, expect, it } from 'vitest';
import { QuerySqlError, queryToSql, sqlToQuery } from './query-sql';
import { queryEditorIssue, type Predicate } from './query';
import type { Query } from './types';
import type { Definition } from './tagging/types';

const base: Query = { offset: 60, limit: 30, libraryId: 'library-unfamiliar', locale: 'eo', ignoreDefaultQuery: true };
const parse = (sql: string) => sqlToQuery(sql, base);
const field = 'custom.measure';
describe('query SQL editing contract', () => {
  it('parses SQL precedence, inclusive bounds, NOT IN and composite arrangement into the public AST', () => {
    const query = parse(`SELECT * FROM films WHERE "custom.measure" BETWEEN 0 AND 12.5
      AND ("custom.caption" LIKE 'A_%' OR "custom.measure" NOT IN (3, 4))
      GROUP BY "custom.caption", MEMBER("custom.links")
      ORDER BY "custom.measure" DESC NULLS FIRST, LABEL("custom.link") ASC;`);
    expect(query).toEqual({
      ...base,
      search: '',
      where: {
        op: 'and',
        args: [
          { op: 'between', tag: field, value: [0, 12.5] },
          {
            op: 'or',
            args: [
              { op: 'like', tag: 'custom.caption', value: 'A_%' },
              { op: 'not-in', tag: field, values: [3, 4] },
            ],
          },
        ],
      },
      groupBy: [
        { tag: 'custom.caption', mode: 'value' },
        { tag: 'custom.links', mode: 'member' },
      ],
      orderBy: [
        { tag: field, mode: 'value', direction: 'desc', nulls: 'first' },
        { tag: 'custom.link', mode: 'label', direction: 'asc', nulls: 'last' },
      ],
    });
    expect(parse('SELECT * FROM films WHERE a = 1 OR b = 2 AND c = 3').where).toEqual({
      op: 'or',
      args: [
        { op: 'eq', tag: 'a', value: 1 },
        {
          op: 'and',
          args: [
            { op: 'eq', tag: 'b', value: 2 },
            { op: 'eq', tag: 'c', value: 3 },
          ],
        },
      ],
    });
  });
  const predicates: Predicate[] = [
    { op: 'exists', tag: field },
    { op: 'missing', tag: field },
    ...(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const).map(op => ({ op, tag: field, value: -1.25e3 })),
    { op: 'contains', tag: 'custom.caption', value: "name's, %_\\text" },
    { op: 'like', tag: 'custom.caption', value: 'a\\_%' },
    ...(['not-like', 'glob', 'not-glob', 'starts-with', 'ends-with'] as const).map(op => ({
      op,
      tag: 'custom.caption',
      value: 'a_*%',
    })),
    { op: 'not-between', tag: field, value: [0, 5] },
    { op: 'not-in', tag: field, values: [null, 1] },
    { op: 'is', tag: field, value: 1 },
    { op: 'is-not', tag: field, value: 1 },
    { op: 'is', tag: field, value: null },
    { op: 'is-not', tag: field, value: null },
    { op: 'in', tag: field, values: [] },
    { op: 'not-in', tag: field, values: [] },
    { op: 'eq', tag: field, value: null },
    { op: 'between', tag: field, value: [0, 5] },
    { op: 'has', tag: 'custom.links', value: { term: 'term-42' } },
    { op: 'in', tag: 'custom.caption', values: ['one,two', "three's", ''] },
    { op: 'eq', tag: 'custom.flags', value: [true, false] },
    { op: 'eq', tag: 'custom.links', value: [{ term: 'one' }, { term: 'two' }] },
    { op: 'not', arg: { op: 'and', args: [{ op: 'exists', tag: field }] } },
    { op: 'and', args: [] },
    { op: 'or', args: [] },
    { op: 'related', tag: 'custom.link', where: { op: 'eq', tag: 'custom.caption', value: 'term text' } },
    { op: 'facet', tag: field, facet: 'bands', selection: 'bucket-a' },
    {
      op: 'scoped',
      scope: { kind: 'interval', startUs: '9999999999999991', endUs: '9999999999999999', match: 'contains' },
      quantifier: 'all',
      where: { op: 'exists', tag: field },
    },
    {
      op: 'scoped',
      scope: { kind: 'point', match: 'overlaps', partId: "unfamiliar-part's-id" },
      quantifier: 'any',
      where: { op: 'eq', tag: field, value: 71 },
    },
  ];
  it.each(predicates.map((where, i) => [i, where] as const))(
    'round-trips predicate %s, retaining values and explicit group structure',
    (_i, where) => {
      const query = { ...base, where, search: "don't lose this" };
      const text = queryToSql(query),
        converted = parse(text);
      expect(converted.where).toEqual(where);
      expect(converted.search).toBe(query.search);
      expect(converted.libraryId).toBe(base.libraryId);
      expect(converted.offset).toBe(base.offset);
      expect(queryToSql(converted)).toBe(text);
    },
  );
  it('retains same-operator nested groups and group/sort modes after repeated switching', () => {
    const query: Query = {
      ...base,
      where: {
        op: 'and',
        args: [predicates[0], { op: 'and', args: [predicates[1], predicates[2]] }, { op: 'or', args: [predicates[3]] }],
      },
      groupBy: [
        { tag: field, mode: 'facet', facet: 'bands' },
        { tag: 'custom.links', mode: 'member' },
      ],
      orderBy: [
        { tag: field, mode: 'min', direction: 'asc', nulls: 'last' },
        { tag: 'custom.links', mode: 'max', direction: 'desc', nulls: 'first' },
      ],
    };
    const result = parse(queryToSql(parse(queryToSql(query))));
    expect(result).toEqual({ ...query, search: '' });
  });
  it('handles comments, quoted identifiers, apostrophes, boolean values and scientific numbers', () => {
    expect(
      parse(
        `-- note\nselect * from films /* note */ where "custom.""field" = 'it''s -- data' AND flag = FALSE AND number >= 1.2e-3;`,
      ).where,
    ).toEqual({
      op: 'and',
      args: [
        { op: 'eq', tag: 'custom."field', value: "it's -- data" },
        { op: 'eq', tag: 'flag', value: false },
        { op: 'gte', tag: 'number', value: 0.0012 },
      ],
    });
    expect(parse('SELECT * FROM films').where).toBeNull();
    expect(parse("SELECT * FROM films WHERE SEARCH('needle')").search).toBe('needle');
  });
  it.each([
    'DELETE FROM films',
    'SELECT * FROM sqlite_master',
    'SELECT count(*) FROM films',
    'SELECT * FROM films; DROP TABLE films',
    'SELECT * FROM films JOIN other ON TRUE',
    'SELECT * FROM films LIMIT 100',
    'SELECT * FROM films WHERE a = 1 HAVING a > 0',
    "SELECT * FROM films WHERE SEARCH('one') OR a = 1",
    "SELECT * FROM films WHERE NOT SEARCH('one')",
    "SELECT * FROM films WHERE SEARCH('one') AND SEARCH('two')",
    "SELECT * FROM films WHERE SEARCH('') AND SEARCH('two')",
    'SELECT * FROM films WHERE a = 1e999',
    "SELECT * FROM films WHERE a = 'unclosed",
    'SELECT * FROM films /* unclosed',
    'SELECT * FROM films WHERE ' + 'NOT '.repeat(40) + 'a = 1',
  ])('rejects unsupported or incomplete input without modifying the applied query: %s', sql => {
    const previous = structuredClone(base);
    expect(() => parse(sql)).toThrow(QuerySqlError);
    expect(base).toEqual(previous);
  });
  it('reports the exact syntax-error offset', () => {
    const sql = 'SELECT * FROM films\nWHERE a = ;';
    expect(() => parse(sql)).toThrow(QuerySqlError);
    try {
      parse(sql);
    } catch (error) {
      expect(error).toBeInstanceOf(QuerySqlError);
      expect((error as QuerySqlError).offset).toBe(sql.indexOf(';'));
    }
  });
  it('validates unavailable fields, type errors and capabilities before either view applies', () => {
    const definitions: Definition[] = [
      {
        key: field,
        revision: 1,
        enabled: true,
        label: { eo: 'Measure' },
        parents: [],
        input: { component: 'number@1' },
        placements: [],
        targets: ['film-whole'],
        value: { cardinality: 'one', semanticVersion: 1, schema: { type: 'number' } },
        query: { filter: true, sort: true, groupBy: ['value'] },
      },
    ];
    expect(queryEditorIssue(parse(`SELECT * FROM films WHERE "${field}" >= 0`), definitions)).toBeUndefined();
    expect(queryEditorIssue(parse(`SELECT * FROM films WHERE "${field}" = 'bad'`), definitions)).toBe(
      'Query.typeMismatch',
    );
    expect(queryEditorIssue(parse('SELECT * FROM films WHERE unknown = 0'), definitions)).toBe('Query.chooseFieldHint');
    expect(queryEditorIssue(parse(`SELECT * FROM films ORDER BY MIN("${field}")`), definitions)).toBe(
      'Query.arrangementInvalid',
    );
    expect(queryEditorIssue(parse(`SELECT * FROM films GROUP BY MEMBER("${field}")`), definitions)).toBe(
      'Query.arrangementInvalid',
    );
  });
});
