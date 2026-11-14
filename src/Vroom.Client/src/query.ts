import { conditionOperators } from './tagging/operators';
import type { Json } from './tagging/types';
import type { Definition } from './tagging/types';
import type { Query } from './types';
import { supportsTarget } from './tagging/annotation-targets';

export type Comparison =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'has'
  | 'between'
  | 'like'
  | 'not-like'
  | 'glob'
  | 'not-glob'
  | 'starts-with'
  | 'ends-with'
  | 'not-between'
  | 'is'
  | 'is-not';
export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: 'exists' | 'missing'; tag: string }
  | { op: Comparison; tag: string; value: Json }
  | { op: 'in' | 'not-in'; tag: string; values: Json[] }
  | { op: 'related'; tag: string; where: Predicate }
  | { op: 'facet'; tag: string; facet: string; selection: string }
  | {
      op: 'scoped';
      scope: {
        partId?: string;
        kind: 'whole' | 'point' | 'interval' | 'any';
        startUs?: string;
        endUs?: string;
        match?: 'overlaps' | 'contains';
      };
      quantifier: 'any' | 'all' | 'none';
      where: Predicate;
    };

export function comparisons(type: string, many = false): Comparison[] {
  return conditionOperators(type, many).filter(o => !['in', 'not-in', 'exists', 'missing'].includes(o)) as Comparison[];
}

/** Incomplete edits stay in the draft; only complete predicates reach the query service. */
export function queryIssue(predicate: Predicate | null | undefined, definitions: Definition[]): string | undefined {
  if (!predicate) return;
  if (predicate.op === 'and' || predicate.op === 'or')
    return predicate.args.map(p => queryIssue(p, definitions)).find(Boolean);
  if (predicate.op === 'not') return queryIssue(predicate.arg, definitions);
  if (predicate.op === 'scoped') return queryIssue(predicate.where, definitions);
  if (
    !('tag' in predicate) ||
    !definitions.some(d => d.key === predicate.tag && d.enabled && d.query?.filter !== false)
  )
    return 'Query.chooseFieldHint';
  if (predicate.op === 'related') return queryIssue(predicate.where, definitions);

  if (
    ['between', 'not-between'].includes(predicate.op) &&
    'value' in predicate &&
    (!Array.isArray(predicate.value) ||
      predicate.value.length !== 2 ||
      predicate.value.some(v => v == null || (typeof v === 'number' && !Number.isFinite(v))))
  )
    return 'Query.valueRequired';
  if (
    'value' in predicate &&
    ((!['is', 'is-not', 'eq', 'ne'].includes(predicate.op) && predicate.value == null) ||
      (typeof predicate.value === 'number' && !Number.isFinite(predicate.value)))
  )
    return 'Query.valueRequired';
}
export function predicateCount(predicate?: Predicate | null): number {
  if (!predicate) return 0;
  if (predicate.op === 'and' || predicate.op === 'or')
    return predicate.args.reduce((sum, p) => sum + predicateCount(p), 0);
  if (predicate.op === 'not') return predicateCount(predicate.arg);
  return 1;
}

/** Both editors validate the same draft. The host remains authoritative. */
export function queryEditorIssue(query: Query, definitions: Definition[]): string | undefined {
  let count = 0;
  const visit = (
    p: Predicate | null | undefined,
    depth = 0,
    subject = 'film',
    scope = 'whole',
    scoped = false,
  ): string | undefined => {
    if (!p) return;
    if (depth > 24 || ++count > 1000) return 'Query.sqlLimit';
    if (p.op === 'and' || p.op === 'or')
      return p.args.length > 100
        ? 'Query.sqlLimit'
        : p.args.map(a => visit(a, depth + 1, subject, scope, scoped)).find(Boolean);
    if (p.op === 'not') return visit(p.arg, depth + 1, subject, scope, scoped);
    if (p.op === 'scoped') {
      const { startUs, endUs, kind } = p.scope;
      if ([startUs, endUs].some(v => v != null && !/^\d{1,16}$/.test(v))) return 'Query.sqlScope';
      if (
        subject !== 'film' ||
        scoped ||
        (kind === 'whole' && (startUs != null || endUs != null)) ||
        (endUs != null && (startUs == null || BigInt(endUs) <= BigInt(startUs)))
      )
        return 'Query.sqlScope';
      return visit(p.where, depth + 1, subject, kind, true);
    }
    if (!('tag' in p)) return 'Query.sqlUnsupported';
    const d = definitions.find(d => d.key === p.tag && d.enabled && d.query?.filter !== false);
    if (!d || !supportsTarget(d, subject, scope === 'any' ? undefined : scope)) return 'Query.chooseFieldHint';
    if (p.op === 'exists' || p.op === 'missing') return;
    if (p.op === 'related') return d.value.vocabulary ? visit(p.where, depth + 1, 'term') : 'Query.typeMismatch';
    if (p.op === 'facet')
      return d.facets?.[p.facet]?.bands?.some((b: { id: string }) => b.id === p.selection) ||
        d.facets?.[p.facet]?.missing?.id === p.selection
        ? undefined
        : 'Query.typeMismatch';
    const many = d.value.cardinality === 'many',
      schema = d.value.schema;
    const valid = (v: Json): boolean =>
      d.value.vocabulary
        ? !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.term === 'string' && !!v.term
        : schema.type === 'integer'
          ? typeof v === 'number' && Number.isInteger(v)
          : schema.type === 'number'
            ? typeof v === 'number' && Number.isFinite(v)
            : typeof v === schema.type;
    if (p.op === 'in' || p.op === 'not-in')
      return p.values.length <= 500 && p.values.every(v => v === null || valid(v)) ? undefined : 'Query.typeMismatch';
    if (!('value' in p)) return 'Query.sqlUnsupported';
    if (['eq', 'ne', 'is', 'is-not'].includes(p.op) && p.value === null) return;
    if (p.op === 'between' || p.op === 'not-between')
      return !many &&
        !d.value.vocabulary &&
        ['number', 'integer', 'string'].includes(schema.type) &&
        Array.isArray(p.value) &&
        p.value.length === 2 &&
        p.value.every(valid)
        ? undefined
        : 'Query.typeMismatch';
    if (
      (p.op === 'has' && !many) ||
      ([
        'like',
        'not-like',
        'glob',
        'not-glob',
        'starts-with',
        'ends-with',
        'contains',
        'gt',
        'gte',
        'lt',
        'lte',
      ].includes(p.op) &&
        (many || !!d.value.vocabulary || !['string', 'number', 'integer'].includes(schema.type))) ||
      (['contains', 'like', 'not-like', 'glob', 'not-glob', 'starts-with', 'ends-with'].includes(p.op) &&
        schema.type !== 'string')
    )
      return 'Query.typeMismatch';
    return many && ['eq', 'ne', 'is', 'is-not'].includes(p.op)
      ? Array.isArray(p.value) && p.value.every(valid)
        ? undefined
        : 'Query.typeMismatch'
      : valid(p.value)
        ? undefined
        : 'Query.typeMismatch';
  };
  const issue = queryIssue(query.where, definitions) ?? visit(query.where);
  if (issue) return issue;
  if ((query.search?.length ?? 0) > 500 || (query.orderBy?.length ?? 0) > 12 || (query.groupBy?.length ?? 0) > 12)
    return 'Query.sqlLimit';
  for (const f of query.orderBy ?? []) {
    const d = definitions.find(
      d => d.key === f.tag && d.enabled && d.query?.sort && supportsTarget(d, 'film', 'whole'),
    );
    if (
      !d ||
      (d.value.cardinality === 'many'
        ? !['min', 'max'].includes(f.mode ?? 'value')
        : ['min', 'max'].includes(f.mode ?? '') || (f.mode === 'label' && !d.value.vocabulary))
    )
      return 'Query.arrangementInvalid';
  }
  for (const f of query.groupBy ?? []) {
    const d = definitions.find(d => d.key === f.tag && d.enabled && supportsTarget(d, 'film', 'whole'));
    if (!d?.query?.groupBy?.includes(f.mode ?? 'value') || (f.mode === 'facet' && !d.facets?.[f.facet ?? '']))
      return 'Query.arrangementInvalid';
  }
}
