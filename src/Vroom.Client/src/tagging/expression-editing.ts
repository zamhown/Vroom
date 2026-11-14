import { operations } from './operators';
import registry from '../../../../resources/tagging/host-capabilities.json';
import type { TagPackage } from './types';

export const expressionKind = (v: any): string =>
  v?.op ?? (Object.hasOwn(v ?? {}, 'tag') ? 'tag' : Object.hasOwn(v ?? {}, 'fact') ? 'fact' : 'literal');
export const predicateOperation = (op: string) => !!operations[op]?.shape;
export function expressionType(v: any, catalog: TagPackage): string | undefined {
  if (Object.hasOwn(v ?? {}, 'literal'))
    return v.literal == null ? undefined : Array.isArray(v.literal) ? 'array' : typeof v.literal;
  if (v?.fact)
    return (
      (registry.facts as Record<string, any>)[v.fact]?.type ??
      (registry.eventFacts as Record<string, any>)[v.fact]?.type
    );
  if (v?.tag) {
    const d = catalog.definitions.find(d => d.key === v.tag);
    return d?.value.cardinality === 'many' ? 'array' : d?.value.schema.type;
  }
  const resultType = (operations[v?.op] as any)?.resultType;
  if (resultType) return resultType === 'any' ? undefined : resultType;
  if (predicateOperation(v?.op) || ['and', 'or', 'not'].includes(v?.op)) return 'boolean';
  if (['concat', 'lower', 'upper', 'trim'].includes(v?.op)) return 'string';
  if (['first-valid', 'coalesce', 'nullif', 'case'].includes(v?.op))
    return expressionType(v.args?.[v.op === 'case' ? 1 : 0], catalog);
  return v?.op ? 'number' : undefined;
}
export function argumentRole(op: string, index: number, count: number): string {
  const roles = (operations[op] as any)?.argumentRoles;
  if (roles) return roles[Math.min(index, roles.length - 1)];
  if (op === 'case') return index === count - 1 ? 'otherwise' : index % 2 === 0 ? 'when' : 'then';
  if (['and', 'or', 'not'].includes(op)) return 'condition';
  if (op.endsWith('between')) return ['readValue', 'lowerBound', 'upperBound'][index];
  if (['in', 'not-in', 'has'].includes(op)) return index === 0 ? 'readValue' : op === 'has' ? 'member' : 'candidates';
  if (predicateOperation(op)) return index === 0 ? 'readValue' : 'compareValue';
  if (['coalesce', 'first-valid'].includes(op)) return 'candidate';
  if (op === 'nullif') return index === 0 ? 'readValue' : 'ignoreValue';
  if (op === 'divide' || op === 'modulo') return index === 0 ? 'dividend' : 'divisor';
  if (op === 'round') return index === 0 ? 'number' : 'decimalPlaces';
  if (op === 'count') return 'list';
  if (['concat', 'length', 'lower', 'upper', 'trim'].includes(op)) return 'text';
  return 'number';
}
export function argumentType(op: string, index: number, value: any, catalog: TagPackage): string | undefined {
  const types = (operations[op] as any)?.argumentTypes;
  if (types) return types[Math.min(index, types.length - 1)];
  const role = argumentRole(op, index, value.args?.length ?? 0);
  if (['condition', 'when'].includes(role)) return 'boolean';
  if (['candidates', 'list'].includes(role)) return 'array';
  if (['number', 'dividend', 'divisor', 'decimalPlaces'].includes(role)) return 'number';
  if (
    ['text'].includes(role) ||
    ['contains', 'starts-with', 'ends-with', 'like', 'not-like', 'glob', 'not-glob'].includes(op)
  )
    return 'string';
  if (['compareValue', 'lowerBound', 'upperBound', 'ignoreValue'].includes(role))
    return expressionType(value.args?.[0], catalog);
  return undefined;
}
export const initialLiteral = (type?: string): any =>
  type === 'boolean'
    ? false
    : type === 'number' || type === 'integer'
      ? 0
      : type === 'array'
        ? []
        : type === 'object'
          ? {}
          : '';
/** Changing an operator keeps its source expression. It never evaluates or writes catalog data. */
export function replaceOperation(value: any, op: string, catalog: TagPackage) {
  if (value?.op === op) return value;
  const old = value?.op ? (value.args ?? []) : [value ?? { literal: '' }];
  if (op === 'case') return { op, args: [{ literal: false }, value ?? { literal: '' }, { literal: null }] };
  const next: any = {
    op,
    args: Array.from({ length: operations[op].minArgs }, (_, i) => old[i] ?? { literal: null }),
    ...(op === 'concat' ? { separator: ' ' } : {}),
  };
  next.args = next.args.map((arg: any, i: number) => {
    if (i === 0 && old[0]) return old[0];
    const type = argumentType(op, i, next, catalog),
      oldType = expressionType(arg, catalog);
    return oldType && (!type || type === oldType || (type === 'number' && oldType === 'integer'))
      ? arg
      : { literal: initialLiteral(type) };
  });
  return next;
}
