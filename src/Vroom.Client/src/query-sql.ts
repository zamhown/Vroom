import type { Predicate, Comparison } from './query';
import type { Query, QueryGroupField, QueryOrderField } from './types';
import type { Json } from './tagging/types';

// SQL is an editing notation for the public query AST, never database SQL.
// Stable field IDs are identifiers; all strings remain data in the typed compiler.
export class QuerySqlError extends Error {
  constructor(
    public code: string,
    public offset: number,
    public args: Record<string, string | number> = {},
  ) {
    super(code);
  }
}
type Token = { kind: 'word' | 'identifier' | 'string' | 'number' | 'symbol' | 'end'; text: string; at: number };
const quoted = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export const sqlIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: Json): string => {
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === null) return 'NULL';
  if (
    !Array.isArray(value) &&
    typeof value === 'object' &&
    typeof value.term === 'string' &&
    Object.keys(value).length === 1
  )
    return `TERM(${quoted(value.term)})`;
  return `JSON(${quoted(JSON.stringify(value))})`;
};
const comparison: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  'not-like': 'NOT LIKE',
  glob: 'GLOB',
  'not-glob': 'NOT GLOB',
  is: 'IS NOT DISTINCT FROM',
  'is-not': 'IS DISTINCT FROM',
};
function predicateSql(p: Predicate, depth = 0): string {
  const pad = '  '.repeat(depth),
    next = '  '.repeat(depth + 1);
  if (p.op === 'and' || p.op === 'or') {
    if (!p.args.length) return p.op === 'and' ? 'TRUE' : 'FALSE';
    // A named group retains an explicit one-child group on a round trip.
    if (p.args.length === 1) return `${p.op === 'and' ? 'ALL_OF' : 'ANY_OF'}(${predicateSql(p.args[0], depth)})`;
    return `(\n${next}${p.args.map(a => predicateSql(a, depth + 1)).join(`\n${next}${p.op.toUpperCase().replaceAll('-', '_')} `)}\n${pad})`;
  }
  if (p.op === 'not') return `NOT (${predicateSql(p.arg, depth)})`;
  if (p.op === 'scoped' && p.scope.partId) {
    const { partId, ...scope } = p.scope;
    return `WITHIN_PART(${literal(partId)}, ${predicateSql({ ...p, scope }, depth)})`;
  }
  if (p.op === 'scoped')
    return `WITHIN_SCOPE(${[p.scope.kind, p.quantifier, p.scope.match ?? 'overlaps', p.scope.startUs ?? null, p.scope.endUs ?? null].map(literal).join(', ')}, ${predicateSql(p.where, depth)})`;
  if (!('tag' in p)) throw new QuerySqlError('Query.sqlUnsupported', 0);
  const field = sqlIdentifier(p.tag);
  if (p.op === 'exists' || p.op === 'missing') return `${field} IS ${p.op === 'exists' ? 'NOT ' : ''}NULL`;
  if (p.op === 'related') return `RELATED(${field}, ${predicateSql(p.where, depth)})`;
  if (p.op === 'facet') return `FACET(${field}, ${quoted(p.facet)}) = ${quoted(p.selection)}`;
  if (p.op === 'in' || p.op === 'not-in')
    return `${field} ${p.op === 'not-in' ? 'NOT ' : ''}IN (${p.values.map(literal).join(', ')})`;
  if ('value' in p) {
    if ((p.op === 'between' || p.op === 'not-between') && Array.isArray(p.value))
      return `${field} ${p.op === 'not-between' ? 'NOT ' : ''}BETWEEN ${literal(p.value[0])} AND ${literal(p.value[1])}`;
    if (['contains', 'has', 'starts-with', 'ends-with'].includes(p.op))
      return `${p.op.toUpperCase().replaceAll('-', '_')}(${field}, ${literal(p.value)})`;
    if (comparison[p.op]) return `${field} ${comparison[p.op]} ${literal(p.value)}`;
  }
  throw new QuerySqlError('Query.sqlUnsupported', 0);
}
export function queryToSql(query: Query): string {
  const lines = ['SELECT * FROM films'];
  const where = query.where ? predicateSql(query.where) : '';
  if (query.search) lines.push(`WHERE SEARCH(${quoted(query.search)})${where ? '\n  AND ' + where : ''}`);
  else if (where) lines.push('WHERE ' + where);
  if (query.groupBy?.length)
    lines.push(
      'GROUP BY ' +
        query.groupBy
          .map(f =>
            f.mode === 'facet'
              ? `FACET(${sqlIdentifier(f.tag)}, ${quoted(f.facet ?? '')})`
              : f.mode === 'member'
                ? `MEMBER(${sqlIdentifier(f.tag)})`
                : sqlIdentifier(f.tag),
          )
          .join(',\n  '),
    );
  if (query.orderBy?.length)
    lines.push(
      'ORDER BY ' +
        query.orderBy
          .map(f => {
            const field =
              f.mode && f.mode !== 'value' ? `${f.mode.toUpperCase()}(${sqlIdentifier(f.tag)})` : sqlIdentifier(f.tag);
            return `${field} ${(f.direction ?? 'desc').toUpperCase()} NULLS ${(f.nulls ?? 'last').toUpperCase()}`;
          })
          .join(',\n  '),
    );
  return lines.join('\n') + ';';
}
function lex(source: string): Token[] {
  if (source.length > 100000) throw new QuerySqlError('Query.sqlLimit', 0);
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith('--', i)) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new QuerySqlError('Query.sqlUnclosed', i);
      i = end + 2;
      continue;
    }
    const at = i,
      char = source[i];
    if (char === "'" || char === '"' || char === '`') {
      let text = '',
        closed = false;
      i++;
      while (i < source.length) {
        if (source[i] === char) {
          i++;
          if (source[i] === char) {
            text += char;
            i++;
          } else {
            closed = true;
            break;
          }
        } else text += source[i++];
      }
      if (!closed) throw new QuerySqlError('Query.sqlUnclosed', at);
      tokens.push({ kind: char === "'" ? 'string' : 'identifier', text, at });
    } else {
      const number = source.slice(i).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
      const word = source.slice(i).match(/^[a-z_][a-z0-9_.]*/i);
      const symbol = source.slice(i).match(/^(?:>=|<=|<>|!=|[(),;*=<>])/);
      const match = number ?? word ?? symbol;
      if (!match) throw new QuerySqlError('Query.sqlUnexpected', i, { token: char });
      tokens.push({ kind: number ? 'number' : word ? 'word' : 'symbol', text: match[0], at });
      i += match[0].length;
    }
    if (tokens.length > 20000) throw new QuerySqlError('Query.sqlLimit', i);
  }
  return [...tokens, { kind: 'end', text: '', at: source.length }];
}
type Expression =
  | Predicate
  | { op: 'search'; text: string }
  | { op: 'and' | 'or'; args: Expression[] }
  | { op: 'not'; arg: Expression };
class Parser {
  private index = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}
  get token() {
    return this.tokens[this.index];
  }
  fail(
    code = 'Query.sqlUnexpected',
    args: Record<string, string | number> = { token: this.token.text || 'EOF' },
  ): never {
    throw new QuerySqlError(code, this.token.at, args);
  }
  take(text: string) {
    if (this.token.kind !== 'identifier' && this.token.kind !== 'string' && this.token.text.toUpperCase() === text) {
      this.index++;
      return true;
    }
    return false;
  }
  need(text: string) {
    if (!this.take(text)) this.fail('Query.sqlExpected', { token: text });
  }
  string() {
    if (this.token.kind !== 'string') this.fail('Query.sqlExpected', { token: "'…'" });
    return this.tokens[this.index++].text;
  }
  field() {
    if (!['word', 'identifier'].includes(this.token.kind)) this.fail('Query.sqlExpected', { token: '"field.id"' });
    return this.tokens[this.index++].text;
  }
  value(): Json {
    if (this.token.kind === 'string') return this.string();
    if (this.token.kind === 'number') {
      const value = Number(this.tokens[this.index++].text);
      if (!Number.isFinite(value)) this.fail('Query.valueRequired', {});
      return value;
    }
    if (this.take('TRUE')) return true;
    if (this.take('FALSE')) return false;
    if (this.take('NULL')) return null;
    if (this.take('TERM')) {
      this.need('(');
      const term = this.string();
      this.need(')');
      return { term };
    }
    if (this.take('JSON')) {
      this.need('(');
      const source = this.string();
      this.need(')');
      try {
        return JSON.parse(source);
      } catch {
        this.fail('Query.sqlJson', {});
      }
    }
    return this.fail('Query.valueRequired', {});
  }
  expression(): Expression {
    if (++this.depth > 24) this.fail('Query.sqlLimit', {});
    const args = [this.and()];
    while (this.take('OR')) args.push(this.and());
    this.depth--;
    return args.length === 1 ? args[0] : { op: 'or', args };
  }
  and(): Expression {
    const args = [this.atom()];
    while (this.take('AND')) args.push(this.atom());
    return args.length === 1 ? args[0] : { op: 'and', args };
  }
  nested(): Predicate {
    return this.noSearch(this.expression());
  }
  atom(): Expression {
    if (this.take('NOT')) {
      if (++this.depth > 24) this.fail('Query.sqlLimit', {});
      const arg = this.atom();
      this.depth--;
      return { op: 'not', arg };
    }
    if (this.take('(')) {
      const p = this.expression();
      this.need(')');
      return p;
    }
    if (this.take('TRUE')) return { op: 'and', args: [] };
    if (this.take('FALSE')) return { op: 'or', args: [] };
    if (this.take('SEARCH')) {
      this.need('(');
      const text = this.string();
      this.need(')');
      return { op: 'search', text };
    }
    if (this.take('ALL_OF') || this.take('ANY_OF')) {
      const op = this.tokens[this.index - 1].text.toUpperCase() === 'ALL_OF' ? 'and' : 'or';
      this.need('(');
      const args: Predicate[] = [];
      if (!this.take(')')) {
        do {
          args.push(this.nested());
        } while (this.take(','));
        this.need(')');
      }
      return { op, args };
    }
    if (
      this.take('CONTAINS') ||
      this.take('HAS') ||
      this.take('STARTS_WITH') ||
      this.take('ENDS_WITH') ||
      this.take('RELATED')
    ) {
      const op = this.tokens[this.index - 1].text.toLowerCase().replaceAll('_', '-') as 'contains' | 'has' | 'related';
      this.need('(');
      const tag = this.field();
      this.need(',');
      const p: Predicate = op === 'related' ? { op, tag, where: this.nested() } : { op, tag, value: this.value() };
      this.need(')');
      return p;
    }
    if (this.take('WITHIN_PART')) {
      this.need('(');
      const partId = this.string();
      this.need(',');
      const value = this.nested();
      this.need(')');
      if (value.op !== 'scoped' || value.scope.kind === 'whole') this.fail('Query.sqlScope', {});
      return { ...value, scope: { ...value.scope, partId } };
    }
    if (this.take('WITHIN_SCOPE')) {
      this.need('(');
      const kind = this.string();
      this.need(',');
      const quantifier = this.string();
      this.need(',');
      const match = this.string();
      this.need(',');
      const start = this.value();
      this.need(',');
      const end = this.value();
      this.need(',');
      const where = this.nested();
      this.need(')');
      if (
        !['whole', 'point', 'interval', 'any'].includes(kind) ||
        !['any', 'all', 'none'].includes(quantifier) ||
        !['contains', 'overlaps'].includes(match) ||
        [start, end].some(v => v !== null && (typeof v !== 'string' || !/^\d{1,16}$/.test(v)))
      )
        this.fail('Query.sqlScope', {});
      return {
        op: 'scoped',
        scope: {
          kind: kind as 'any',
          match: match as 'overlaps',
          ...(start !== null ? { startUs: String(start) } : {}),
          ...(end !== null ? { endUs: String(end) } : {}),
        },
        quantifier: quantifier as 'any',
        where,
      };
    }
    if (this.take('FACET')) {
      this.need('(');
      const tag = this.field();
      this.need(',');
      const facet = this.string();
      this.need(')');
      this.need('=');
      return { op: 'facet', tag, facet, selection: this.string() };
    }
    const tag = this.field();
    if (this.take('IS')) {
      const not = this.take('NOT');
      if (this.take('DISTINCT')) {
        this.need('FROM');
        return { op: not ? 'is' : 'is-not', tag, value: this.value() };
      }
      if (this.take('NULL')) return { op: not ? 'exists' : 'missing', tag };
      return { op: not ? 'is-not' : 'is', tag, value: this.value() };
    }
    const negated = this.take('NOT');
    let result: Predicate;
    if (this.take('IN')) {
      this.need('(');
      const values: Json[] = [];
      if (!this.take(')')) {
        do {
          values.push(this.value());
        } while (this.take(','));
        this.need(')');
      }
      result = { op: 'in', tag, values };
    } else if (this.take('BETWEEN')) {
      const start = this.value();
      this.need('AND');
      result = { op: 'between', tag, value: [start, this.value()] };
    } else if (this.take('GLOB')) {
      result = { op: 'glob', tag, value: this.value() };
    } else if (this.take('LIKE')) {
      result = { op: 'like', tag, value: this.value() };
      if (this.take('ESCAPE') && this.string() !== '\\') this.fail('Query.sqlEscape', {});
    } else {
      if (negated) this.fail();
      const ops: Record<string, Comparison> = {
        '=': 'eq',
        '<>': 'ne',
        '!=': 'ne',
        '<': 'lt',
        '<=': 'lte',
        '>': 'gt',
        '>=': 'gte',
      };
      const op = ops[this.token.text];
      if (!op) this.fail();
      this.index++;
      result = { op, tag, value: this.value() };
    }
    return negated && ['in', 'between', 'like', 'glob'].includes(result.op)
      ? ({ ...result, op: 'not-' + result.op } as Predicate)
      : negated
        ? { op: 'not', arg: result }
        : result;
  }
  noSearch(p: Expression): Predicate {
    if (p.op === 'search') this.fail('Query.sqlSearchPosition', {});
    if (p.op === 'and' || p.op === 'or') return { ...p, args: p.args.map(a => this.noSearch(a)) };
    if (p.op === 'not') return { ...p, arg: this.noSearch(p.arg) };
    return p as Predicate;
  }
  arrangement(group: boolean): QueryGroupField | QueryOrderField {
    let mode = 'value',
      facet: string | undefined;
    if (this.token.kind === 'word' && this.tokens[this.index + 1]?.text === '(') {
      mode = this.tokens[this.index++].text.toLowerCase();
      this.need('(');
    }
    const tag = this.field();
    if (mode === 'facet') {
      this.need(',');
      facet = this.string();
    }
    if (mode !== 'value') this.need(')');
    if (group) {
      if (!['value', 'member', 'facet'].includes(mode)) this.fail('Query.sqlUnsupported', {});
      return { tag, mode: mode as 'value', ...(facet ? { facet } : {}) };
    }
    if (!['value', 'label', 'min', 'max'].includes(mode)) this.fail('Query.sqlUnsupported', {});
    const direction = this.take('DESC') ? 'desc' : (this.take('ASC'), 'asc');
    let nulls: 'first' | 'last' = 'last';
    if (this.take('NULLS')) {
      if (this.take('FIRST')) nulls = 'first';
      else this.need('LAST');
    }
    return { tag, mode: mode as 'value', direction, nulls };
  }
  parse(base: Query): Query {
    this.need('SELECT');
    this.need('*');
    this.need('FROM');
    this.need('FILMS');
    let where: Predicate | null = null,
      search = '',
      hasSearch = false;
    if (this.take('WHERE')) {
      const expr = this.expression();
      const extract = (p: Expression): Predicate | undefined => {
        if (p.op === 'search') {
          if (hasSearch) this.fail('Query.sqlSearchPosition', {});
          hasSearch = true;
          search = p.text;
          return;
        }
        if (p.op === 'and') {
          const args = p.args.map(extract).filter((a): a is Predicate => !!a);
          return args.length === p.args.length
            ? { op: 'and', args }
            : args.length === 1
              ? args[0]
              : args.length
                ? { op: 'and', args }
                : undefined;
        }
        return this.noSearch(p);
      };
      where = extract(expr) ?? null;
    }
    const groupBy: QueryGroupField[] = [],
      orderBy: QueryOrderField[] = [];
    if (this.take('GROUP')) {
      this.need('BY');
      do {
        groupBy.push(this.arrangement(true) as QueryGroupField);
      } while (this.take(','));
    }
    if (this.take('ORDER')) {
      this.need('BY');
      do {
        orderBy.push(this.arrangement(false) as QueryOrderField);
      } while (this.take(','));
    }
    this.take(';');
    if (this.token.kind !== 'end') this.fail('Query.sqlUnsupported', {});
    if (groupBy.length > 12 || orderBy.length > 12) this.fail('Query.sqlLimit', {});
    return { ...base, where, search, groupBy, orderBy };
  }
}
export const sqlToQuery = (sql: string, base: Query): Query => new Parser(lex(sql)).parse(base);
