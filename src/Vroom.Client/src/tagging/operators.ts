import registry from '../../../../resources/tagging/host-capabilities.json';
import type { Json } from './types';

export const operations: Record<
  string,
  { label: any; minArgs: number; maxArgs: number; types?: string[]; shape?: string; sql?: string }
> = registry.operations;
export const conditionOperators = (type: string, many = false) =>
  Object.entries(operations)
    .filter(
      ([key, op]) =>
        op.types?.includes(many ? 'array' : type === 'date' ? 'string' : type) &&
        (!many || ['has', 'eq', 'ne', 'is', 'is-not', 'exists', 'missing'].includes(key)),
    )
    .map(([key]) => key);
export const operandShape = (op: string) => operations[op]?.shape ?? 'scalar';
/** Local preview only; the host re-evaluates persisted rules. SQL NULL is preserved under NOT. */
export function compareValue(op: string, left: Json | undefined, right?: Json, upper?: Json): boolean | null {
  const nil = (v: unknown) => v === null || v === undefined;
  const canonical = (v: Json): string =>
    Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : v && typeof v === 'object'
        ? '{' +
          Object.keys(v)
            .filter(k => v[k] !== undefined)
            .sort()
            .map(k => JSON.stringify(k) + ':' + canonical(v[k]!))
            .join(',') +
          '}'
        : JSON.stringify(v);
  const equal = (a: Json | undefined, b: Json | undefined): boolean | null =>
    nil(a) || nil(b) ? null : canonical(a!) === canonical(b!);
  const invert = (v: boolean | null) => (v === null ? null : !v);
  if (op === 'exists' || op === 'missing') return op === 'exists' ? !nil(left) : nil(left);
  if (op === 'is' || op === 'is-not') {
    const same = (nil(left) && nil(right)) || equal(left, right) === true;
    return op === 'is' ? same : !same;
  }
  if (op === 'in' || op === 'not-in') {
    const items = Array.isArray(right) ? right : [];
    const found =
      items.length === 0
        ? false
        : items.some(x => equal(left, x) === true)
          ? true
          : nil(left) || items.some(nil)
            ? null
            : false;
    return op === 'in' ? found : invert(found);
  }
  if (op === 'between' || op === 'not-between') {
    const a = compareValue('gte', left, right),
      b = compareValue('lte', left, upper),
      v = a === false || b === false ? false : a === null || b === null ? null : true;
    return op === 'between' ? v : invert(v);
  }
  if (nil(left) || nil(right)) return null;
  if (op === 'eq' || op === 'ne') return op === 'eq' ? equal(left, right) : invert(equal(left, right));
  if (op === 'has') return Array.isArray(left) ? left.some(x => equal(x, right) === true) : null;
  if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
    if (typeof left !== typeof right || !['number', 'string'].includes(typeof left)) return null;
    return op === 'gt'
      ? left! > right!
      : op === 'gte'
        ? left! >= right!
        : op === 'lt'
          ? left! < right!
          : left! <= right!;
  }
  if (typeof left !== 'string' || typeof right !== 'string') return null;
  const lower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());
  const a = lower(left),
    b = lower(right);
  if (op === 'contains') return a.includes(b);
  if (op === 'starts-with') return a.startsWith(b);
  if (op === 'ends-with') return a.endsWith(b);
  if (['like', 'not-like', 'glob', 'not-glob'].includes(op)) {
    if (right.length > 4096 || right.length * left.length > 8_000_000) return null;
    // Dynamic programming avoids catastrophic wildcard backtracking in local previews.
    const glob = op.endsWith('glob'),
      text = [...(glob ? left : a)],
      pattern = [...(glob ? right : b)];
    const tokens: { kind: 'any' | 'one' | 'char' | 'set'; value?: string }[] = [];
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (!glob && c === '\\') {
        if (++i === pattern.length) return op.startsWith('not-');
        tokens.push({ kind: 'char', value: pattern[i] });
      } else if (c === (glob ? '*' : '%')) tokens.push({ kind: 'any' });
      else if (c === (glob ? '?' : '_')) tokens.push({ kind: 'one' });
      else if (glob && c === '[') {
        let start = i + 1;
        if (pattern[start] === '^') start++;
        if (pattern[start] === ']') start++;
        const end = pattern.indexOf(']', start);
        if (end < 0) return op.startsWith('not-');
        tokens.push({ kind: 'set', value: pattern.slice(i + 1, end).join('') });
        i = end;
      } else tokens.push({ kind: 'char', value: c });
    }
    let prev = Array<boolean>(text.length + 1).fill(false);
    prev[0] = true;
    for (const token of tokens) {
      const next = Array<boolean>(text.length + 1).fill(false);
      next[0] = token.kind === 'any' && prev[0];
      for (let j = 1; j <= text.length; j++) {
        let matches = token.kind === 'one' || token.value === text[j - 1];
        if (token.kind === 'set') {
          const set = [...token.value!],
            negated = set[0] === '^',
            c = text[j - 1].codePointAt(0)!;
          let found = false;
          for (let i = negated ? 1 : 0; i < set.length; i++) {
            if (i + 2 < set.length && set[i + 1] === '-') {
              found ||= c >= set[i].codePointAt(0)! && c <= set[i + 2].codePointAt(0)!;
              i += 2;
            } else found ||= c === set[i].codePointAt(0)!;
          }
          matches = found !== negated;
        }
        next[j] = token.kind === 'any' ? prev[j] || next[j - 1] : prev[j - 1] && matches;
      }
      prev = next;
    }
    return op.startsWith('not-') ? !prev[text.length] : prev[text.length];
  }
  return null;
}
