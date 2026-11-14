import { t } from '../i18n';
import registry from '../../../../resources/tagging/host-capabilities.json';
import type { Definition } from './types';

export const inputCapabilities = Object.entries(registry.components).filter(([, c]) => c.role === 'input') as [
  string,
  { role: string; types: string[]; cardinality: string; label: any; icon?: string; requirementHelp?: any },
][];
export const valueTypes = registry.valueTypes;
export type ValueType = keyof typeof valueTypes;
export function valueType(field: Definition): ValueType {
  const s = field.value.schema;
  if (s.type === 'object') return field.value.cardinality === 'many' ? 'terms' : 'term';
  if (s.type === 'string') return s.format === 'date' ? 'date' : 'text';
  return s.type as ValueType;
}
// The registry uses this small JSON Schema subset for component requirements.
// Publication evaluates exactly the same constraints using the full validator.
export function satisfiesRequirement(value: any, rule: any): boolean {
  if (rule.const !== undefined && value !== rule.const) return false;
  if (rule.type === 'object' && (!value || typeof value !== 'object')) return false;
  if (rule.type === 'integer' && !Number.isInteger(value)) return false;
  if (rule.type === 'number' && typeof value !== 'number') return false;
  if ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))
    return false;
  if (rule.required?.some((key: string) => value?.[key] === undefined)) return false;
  return Object.entries(rule.properties ?? {}).every(
    ([k, r]) => value?.[k] === undefined || satisfiesRequirement(value[k], r),
  );
}
export function compatibleInput(field: Definition, component: string): boolean {
  const p = (registry.components as Record<string, any>)[component];
  if (
    !p ||
    p.role !== 'input' ||
    p.cardinality !== field.value.cardinality ||
    !p.types.includes(field.value.schema.type)
  )
    return false;
  return (
    !p.valueContract ||
    satisfiesRequirement(field.value, (registry.$defs as Record<string, any>)[p.valueContract.$ref.split('/').at(-1)])
  );
}
export function changeInput(field: Definition, component: string): Definition {
  if (!compatibleInput(field, component)) throw new Error(t('editor.incompatibleInput'));
  const properties = (registry.$defs as Record<string, any>)['components.' + component].properties;
  return {
    ...field,
    input: {
      component,
      props: Object.fromEntries(Object.entries(field.input.props ?? {}).filter(([k]) => k in properties)),
    },
  };
}
/** Data type is the authority. Keep unrelated rules for publication validation. */
export function changeValueType(field: Definition, type: ValueType, vocabulary?: string): Definition {
  if (valueType(field) === type) return field;
  const p = valueTypes[type],
    next = structuredClone(field);
  next.value = {
    cardinality: p.cardinality as 'one' | 'many',
    schema: structuredClone(p.schema),
    semanticVersion: field.value.semanticVersion + 1,
  };
  next.input = {
    component: p.recommendedInput,
    ...(field.input.props?.layout ? { props: { layout: field.input.props.layout } } : {}),
  };
  // The collection is part of the value contract; term creation stays a write policy.
  if (type === 'term' || type === 'terms')
    next.value = { ...next.value, vocabulary: field.value.vocabulary ?? vocabulary ?? '' };
  else {
    next.value = { ...next.value };
    delete next.value.vocabulary;
    if (next.writes?.createTerms) {
      next.writes = { ...next.writes };
      delete next.writes.createTerms;
    }
  }
  next.display = Object.fromEntries(
    Object.entries(next.display ?? {}).map(([key, spec]) => {
      const profile = (registry.components as Record<string, any>)[spec.component];
      return [
        key,
        !profile?.types || profile.types.includes(next.value.schema.type) ? spec : { component: 'text-display@1' },
      ];
    }),
  );
  if (next.query?.groupBy)
    next.query.groupBy = next.query.groupBy.filter((m: string) => m !== 'member' || p.cardinality === 'many');
  return next;
}
/** Collection selection and collection-based matching are one dependency. */
export function changeVocabulary(field: Definition, vocabulary: string): Definition {
  const next = { ...field, value: { ...field.value, vocabulary } };
  for (const kind of ['initialization', 'automation'] as const)
    if (field[kind])
      next[kind] = field[kind]!.map(rule =>
        rule.executor === 'dictionary.match@1' && rule.args.vocabulary === field.value.vocabulary
          ? { ...rule, args: { ...rule.args, vocabulary } }
          : rule,
      );
  return next;
}
/** Include regions declared by the current layouts, not just host-owned slots. */
export function placementChoices(pack: any, field: Definition) {
  const slots = new Map<string, { id: string; surface?: string; mode?: string; scope?: string }>();
  for (const id of registry.placementRegions) slots.set(id, { id });
  const visit = (node: any, surface: string) => {
    if (!node) return;
    const regions = Array.isArray(node.region) ? node.region : node.region ? [node.region] : [];
    if (['field-set', 'form'].includes(node.type))
      for (const id of regions)
        slots.set(id, { id, surface, mode: node.mode, scope: typeof node.scope === 'string' ? node.scope : undefined });
    for (const child of node.children ?? []) visit(child, surface);
  };
  for (const layout of Object.values(pack.ui.layouts ?? {}) as any[]) visit(layout.root, layout.surface);
  return [...slots.values()].filter(s =>
    s.id.startsWith('term.') ? field.targets.includes('term-whole') : field.targets.some(t => t.startsWith('film-')),
  );
}
