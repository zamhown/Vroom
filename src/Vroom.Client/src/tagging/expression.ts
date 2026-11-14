import type { AnnotationRecord } from './types';
import { compareValue, operations } from './operators';

/** Pure preview evaluation of the same public operator contract used by the host. */
export function evaluate(e: any, values: Record<string, AnnotationRecord>, facts: any = {}, depth = 0): any {
  if (depth > 24) return undefined;
  if (e == null || typeof e !== 'object') return e;
  if ('literal' in e) return e.literal;
  if (e.fact)
    return String(e.fact)
      .split('.')
      .reduce((v, k) => v?.[k], facts);
  if (e.tag && !e.op) return values[e.tag]?.value;
  const evalChild = (x: any) => evaluate(x, values, facts, depth + 1),
    children = e.args ?? (e.arg ? [e.arg] : []);
  if (e.op === 'first-valid' || e.op === 'coalesce')
    return children.map(evalChild).find((v: any) => v != null && (e.op === 'coalesce' || v !== ''));
  if (e.op === 'case') {
    for (let i = 0; i < children.length - 1; i += 2)
      if (evalChild(children[i]) === true) return evalChild(children[i + 1]);
    return evalChild(children.at(-1));
  }
  const a = e.tag
    ? [
        values[e.tag]?.value,
        ...('values' in e ? [e.values] : e.op.endsWith('between') && Array.isArray(e.value) ? e.value : [e.value]),
      ]
    : children.map(evalChild);
  if (operations[e.op]?.types) return compareValue(e.op, a[0], a[1], a[2]) ?? undefined;
  const truth = (v: any) => (typeof v === 'boolean' ? v : undefined);
  if (e.op === 'and')
    return a.some((v: any) => truth(v) === false) ? false : a.some((v: any) => truth(v) == null) ? undefined : true;
  if (e.op === 'or')
    return a.some((v: any) => truth(v) === true) ? true : a.some((v: any) => truth(v) == null) ? undefined : false;
  if (e.op === 'not') return truth(a[0]) == null ? undefined : !a[0];
  if (e.op === 'nullif') return compareValue('eq', a[0], a[1]) === true ? undefined : a[0];
  if (a.some((v: any) => v == null)) return undefined;
  if (e.op === 'url-encode')
    return typeof a[0] === 'string'
      ? encodeURIComponent(a[0]).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      : undefined;
  if (e.op === 'date-only') {
    const match = /^\+?(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(a[0]));
    if (!match || +match[1] < 1) return undefined;
    const date = new Date(0);
    date.setUTCFullYear(+match[1], +match[2] - 1, +match[3]);
    return date.getUTCFullYear() === +match[1] &&
      date.getUTCMonth() === +match[2] - 1 &&
      date.getUTCDate() === +match[3]
      ? match.slice(1).join('-')
      : undefined;
  }
  if (e.op === 'object-get')
    return a[0] &&
      typeof a[0] === 'object' &&
      !Array.isArray(a[0]) &&
      typeof a[1] === 'string' &&
      Object.hasOwn(a[0], a[1])
      ? a[0][a[1]]
      : undefined;
  if (e.op === 'parse-number') {
    const raw = String(a[0]).trim();
    const n = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (['array-distinct', 'array-union', 'array-intersect'].includes(e.op)) {
    if (a.some((v: any) => !Array.isArray(v)) || a.reduce((n: number, v: any[]) => n + v.length, 0) > 10000)
      return undefined;
    const all = e.op === 'array-union' ? a.flat() : a[0];
    return all.filter(
      (v: any, i: number) =>
        all.findIndex((other: any) => compareValue('is', v, other) === true) === i &&
        (e.op !== 'array-intersect' ||
          a.slice(1).every((x: any[]) => x.some(other => compareValue('is', v, other) === true))),
    );
  }
  if (e.op === 'concat') return a.join(e.separator ?? '');
  if (e.op === 'count') return Array.isArray(a[0]) ? a[0].length : undefined;
  if (typeof a[0] === 'string') {
    if (e.op === 'length') return [...a[0]].length;
    if (e.op === 'lower') return a[0].replace(/[A-Z]/g, (c: string) => c.toLowerCase());
    if (e.op === 'upper') return a[0].replace(/[a-z]/g, (c: string) => c.toUpperCase());
    if (e.op === 'trim') return a[0].replace(/^ +| +$/g, '');
  }
  if (a.some((v: any) => typeof v !== 'number' || !Number.isFinite(v))) return undefined;
  let result: number | undefined;
  switch (e.op) {
    case 'add':
      result = a.reduce((x: number, y: number) => x + y, 0);
      break;
    case 'subtract':
      result = a[0] - a[1];
      break;
    case 'multiply':
      result = a.reduce((x: number, y: number) => x * y, 1);
      break;
    case 'divide':
      result = a[1] === 0 ? undefined : a[0] / a[1];
      break;
    case 'modulo':
      result = Math.trunc(a[1]) === 0 ? undefined : Math.trunc(a[0]) % Math.trunc(a[1]);
      break;
    case 'negate':
      result = -a[0];
      break;
    case 'abs':
      result = Math.abs(a[0]);
      break;
    case 'round': {
      const scale = 10 ** Math.max(0, Math.min(15, Math.trunc(a[1] ?? 0)));
      result = (Math.sign(a[0]) * Math.round((Math.abs(a[0]) + Number.EPSILON) * scale)) / scale;
      break;
    }
  }
  return result != null && Number.isFinite(result) ? result : undefined;
}
