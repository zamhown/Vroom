import { compatibleInput } from './definition-designer';
import resource from '../../../../resources/tagging/editor-dependencies.json';
import capabilities from '../../../../resources/tagging/host-capabilities.json';
import { definitionTargets } from './annotation-targets';
import type { ConfigPath } from './config-tree';
import type { LocalizedText } from './types';

const rules = { ...resource, ...capabilities } as any;
export const getConfigValue = (doc: any, path: ConfigPath): any => path.reduce((at, key) => at?.[key], doc);
const prefix = (path: ConfigPath, parent: ConfigPath) => parent.every((p, i) => p === path[i]);
const parameterShape = (ref: { $ref: string }) =>
  ref.$ref
    .slice(2)
    .split('/')
    .reduce((at: any, key) => at?.[key], capabilities).properties;
const components = Object.fromEntries(
  Object.entries(capabilities.components).map(([id, c]) => [id, { ...c, props: parameterShape(c.parameters) }]),
) as Record<
  string,
  { props: Record<string, any>; types?: string[]; cardinality?: string; enumerable?: boolean; role: string }
>;
const executors = Object.fromEntries(
  Object.entries(capabilities.executors).map(([id, e]) => [id, parameterShape(e.parameters)]),
) as Record<string, Record<string, any>>;
const componentOwner = (path: ConfigPath): ConfigPath | undefined =>
  path[0] === 'input' ? ['input'] : path[0] === 'display' && path.length > 1 ? path.slice(0, 2) : undefined;
const ruleOwner = (path: ConfigPath): ConfigPath | undefined =>
  ['initialization', 'automation'].includes(String(path[0])) && typeof path[1] === 'number'
    ? path.slice(0, 2)
    : undefined;
const message = (key: string) => rules.messages[key] as LocalizedText;

export interface ConfigDependency {
  reason: LocalizedText;
  controller: ConfigPath;
}
/** Inactive settings stay in the document and can be reactivated by changing their controller. */
export function configDependency(kind: string, doc: any, path: ConfigPath): ConfigDependency | undefined {
  for (const rule of rules.conditions) {
    if (rule.kind !== kind || !prefix(path, rule.path.split('.'))) continue;
    const controller = rule.controller.split('.');
    const value = rule.controller === 'targets' ? definitionTargets(doc) : getConfigValue(doc, controller);
    const applies =
      'equals' in rule
        ? value === rule.equals
        : 'notEquals' in rule
          ? value !== rule.notEquals
          : Array.isArray(value) && value.includes(rule.includes);
    if (!applies) return { reason: rule.reason, controller };
  }
  if (kind === 'definition') {
    const owner = componentOwner(path);
    if (owner && ['props', 'compact'].includes(String(path[owner.length])) && path.length > owner.length + 1) {
      const property = String(path[owner.length + 1]),
        component = getConfigValue(doc, owner)?.component;
      const known = Object.values(components).some(p => property in p.props);
      if (known && components[component] && !(property in components[component].props))
        return { reason: message('componentParameter'), controller: [...owner, 'component'] };
      if (owner[0] === 'input' && ['min', 'max', 'step'].includes(property)) {
        const constraint = { min: 'minimum', max: 'maximum', step: 'multipleOf' }[property as 'min' | 'max' | 'step']!;
        if (doc.value?.schema?.[constraint] !== undefined)
          return { reason: message('valueConstraint'), controller: ['value', 'schema', constraint] };
      }
    }
    if (prefix(path, ['value', 'schema']) && path.length > 2) {
      // The same constraint rules apply to nested item schemas.
      const parent = path.slice(0, -1),
        property = String(path.at(-1)),
        constraint = rules.valueConstraints[property];
      if (constraint && !constraint.types.includes(getConfigValue(doc, parent)?.type))
        return { reason: message('constraintType'), controller: [...parent, 'type'] };
    }
    const rulePath = ruleOwner(path);
    if (rulePath && path[2] === 'args' && path.length > 3) {
      const rule = getConfigValue(doc, rulePath),
        property = String(path[3]);
      if (
        Object.values(executors).some(p => property in p) &&
        executors[rule.executor] &&
        !(property in executors[rule.executor])
      )
        return { reason: message('executorParameter'), controller: [...rulePath, 'executor'] };
      if (['patterns', 'normalize'].includes(property) && rule.executor === 'regex.extract@1' && rule.args?.rule)
        return { reason: message('referenceRule'), controller: [...rulePath, 'args', 'rule'] };
      if (property === 'createOptions' && (!doc.writes?.createTerms || rule.apply !== 'suggest-only'))
        return { reason: message('createOptions'), controller: [...rulePath, 'apply'] };
    }
    if (
      prefix(path, ['writes', 'sourcePriority']) &&
      ![...(doc.initialization ?? []), ...(doc.automation ?? []), ...(doc.enrichment ?? [])].some(
        r => r.apply === 'prefer-source',
      )
    )
      return { reason: message('sourcePriority'), controller: ['initialization'] };
  }
  if (kind === 'sources' && prefix(path, ['parse', 'fields']) && path.length > 3) {
    const property = String(path[3]),
      profiles = rules.sourceFormats;
    if (
      Object.values(profiles).some((p: any) => property in p) &&
      profiles[doc.parse?.format] &&
      !(property in profiles[doc.parse.format])
    )
      return { reason: message('sourceFormat'), controller: ['parse', 'format'] };
  }
}

/** Supplies only relevant candidates; existing incompatible and unknown properties remain visible. */
export function configShape(kind: string, doc: any, path: ConfigPath, schema: any): any {
  let properties: Record<string, any> | undefined;
  if (kind === 'definition') {
    const owner = componentOwner(path);
    if (owner && path.length === owner.length + 1 && path.at(-1) === 'component') {
      schema = {
        ...schema,
        enum: Object.keys(components).filter(
          id =>
            components[id].role === (owner[0] === 'input' ? 'input' : 'display') &&
            (owner[0] !== 'input' || compatibleInput(doc, id)),
        ),
      };
    }
    if (owner && path.length === owner.length)
      properties = { component: { type: 'string' }, props: { type: 'object' }, compact: { type: 'object' } };
    if (owner && path.length === owner.length + 1 && ['props', 'compact'].includes(String(path.at(-1))))
      properties = components[getConfigValue(doc, owner)?.component]?.props;
    const rule = ruleOwner(path);
    if (rule && path.length === 3 && path[2] === 'args') properties = executors[getConfigValue(doc, rule)?.executor];
    if (prefix(path, ['value', 'schema']) && (path.length === 2 || path.at(-1) === 'items')) {
      const type = getConfigValue(doc, path)?.type;
      properties = {
        type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'array', 'object'] },
        enum: { type: 'array', items: {} },
        ...Object.fromEntries(
          Object.entries(rules.valueConstraints)
            .filter(([, v]: any) => v.types.includes(type))
            .map(([k, v]: any) => [k, v.schema]),
        ),
      };
    }
    if (path.length === 2 && path[0] === 'enrichment')
      properties = {
        source: { type: 'string' },
        field: { type: 'string' },
        apply: {
          type: 'string',
          enum: ['if-unset', 'replace-same-source', 'prefer-source', 'union', 'unless-locked', 'suggest-only'],
        },
      };
  }
  if (kind === 'sources') {
    if (!path.length)
      properties = {
        enabled: { type: 'boolean', default: true },
        transport: { type: 'string', enum: ['sidecar', 'http'] },
        extension: { type: 'string', default: '.nfo' },
        request: { type: 'object' },
        parse: { type: 'object' },
        limits: { type: 'object' },
        match: { type: 'array', items: { type: 'object' } },
      };
    if (path.join('.') === 'parse')
      properties = { format: { type: 'string', enum: ['html', 'xml', 'json', 'text'] }, fields: { type: 'object' } };
    if (prefix(path, ['parse', 'fields']) && path.length === 3)
      properties = {
        ...rules.sourceFormats[doc.parse?.format],
        cardinality: { type: 'string', enum: ['one', 'many'] },
        resolveUrl: { type: 'boolean' },
        normalizeWith: { type: 'string' },
      };
  }
  const next = properties ? { ...schema, type: 'object', properties } : { ...schema };
  if (next.properties)
    next.properties = Object.fromEntries(
      Object.entries(next.properties).filter(([key]) => !configDependency(kind, doc, [...path, key])),
    );
  if (
    kind === 'definition' &&
    (ruleOwner(path) || path[0] === 'enrichment') &&
    path.at(-1) === 'apply' &&
    doc.value?.cardinality !== 'many' &&
    next.enum
  )
    next.enum = next.enum.filter((s: string) => s !== 'union');
  return next;
}

export function configChoiceValues(kind: string, doc: any, path: ConfigPath, pack: any): string[] | undefined {
  const key = String(path.at(-1));
  if (kind === 'definition') {
    if (path[0] === 'enrichment' && typeof path[1] === 'number') {
      if (key === 'source') return Object.keys(pack.sources ?? {});
      if (key === 'field') return Object.keys(pack.sources?.[doc.enrichment?.[path[1]]?.source]?.parse?.fields ?? {});
    }
    const rule = ruleOwner(path);
    if (rule) {
      if (key === 'event' && path.length === 3) return capabilities.events.film;
      if (key === 'rule' && path[2] === 'args') return Object.keys(pack.rules ?? {});
      if (key === 'facet' && path[2] === 'args') return Object.keys(doc.facets ?? {});
    }
    const owner = componentOwner(path);
    if (owner && key === 'facet') return Object.keys(doc.facets ?? {});
    if (path[0] === 'placements' && typeof path[1] === 'number') {
      if (key === 'view') return ['input', ...Object.keys(doc.display ?? {}).map(k => 'display.' + k)];
      if (key === 'slot') {
        const regions = new Map<string, string>(
          capabilities.placementRegions.map(s => [s, s.startsWith('term.') ? 'term' : 'film']),
        );
        const walk = (n: any, subject: string) => {
          for (const region of typeof n?.region === 'string' ? [n.region] : (n?.region ?? []))
            regions.set(region, subject);
          for (const c of n?.children ?? []) walk(c, subject);
        };
        for (const layout of Object.values(pack.ui?.layouts ?? {}) as any[])
          walk(layout.root, layout.surface === 'term.details' ? 'term' : 'film');
        const targets = definitionTargets(doc);
        return [...regions]
          .filter(([, subject]) =>
            subject === 'term' ? targets.includes('term-whole') : targets.some(t => t.startsWith('film-')),
          )
          .map(([key]) => key);
      }
    }
  }
}

export function relatedConfigPaths(kind: string, doc: any, path: ConfigPath): ConfigPath[] {
  if (kind === 'sources') {
    if (path.join('.') === 'transport') return ['extension', 'request', 'limits'].map(k => [k]);
    if (path.join('.') === 'parse.format') return [['parse', 'fields']];
    return [];
  }
  if (kind !== 'definition') return [];
  if (path.join('.') === 'targets')
    return [['subjectVocabularies'], ['placements'], ['initialization'], ['automation'], ['enrichment']];
  const owner = componentOwner(path);
  if (owner && path.at(-1) === 'component')
    return [
      ...['props', 'compact'].map(k => [...owner, k]),
      ...(owner[0] === 'input'
        ? [['value'], ...(components[doc.input?.component]?.enumerable ? [['value', 'vocabulary']] : [])]
        : []),
    ];
  if (path.join('.') === 'value.cardinality')
    return [
      ['value', 'schema'],
      ['input', 'component'],
    ];
  if (path.join('.') === 'value.schema.type')
    return [
      ['value', 'schema'],
      ['input', 'component'],
    ];
  if (path.join('.') === 'value.vocabulary')
    return [
      ['writes', 'createTerms'],
      ['value', 'schema'],
    ];
  const rule = ruleOwner(path);
  if (rule && path.at(-1) === 'executor') return [[...rule, 'args']];
  if (rule && path.at(-1) === 'apply')
    return [
      ['writes', 'sourcePriority'],
      ['value', 'cardinality'],
    ];
  if (path[0] === 'enrichment' && path.at(-1) === 'source') return [[...path.slice(0, -1), 'field']];
  return [];
}

export function configWarnings(kind: string, doc: any): { path: ConfigPath; message: LocalizedText }[] {
  if (kind !== 'definition') return [];
  const warnings: { path: ConfigPath; message: LocalizedText }[] = [];
  const say = (path: ConfigPath, key: string) => warnings.push({ path, message: message(key) });
  const profile = components[doc.input?.component],
    contract = doc.value;
  if (
    profile?.cardinality &&
    (contract?.cardinality !== profile.cardinality || !profile.types?.includes(contract?.schema?.type))
  )
    say(['value'], 'validation1');
  if (profile?.enumerable && !doc.value?.vocabulary) say(['value', 'vocabulary'], 'validation2');
  if (contract?.cardinality === 'many' && contract.schema?.type === 'array') say(['value', 'schema'], 'validation3');
  const member = contract?.schema;
  if (doc.value?.vocabulary && (member?.type !== 'object' || !member?.properties?.term))
    say(['value', 'schema'], 'validation4');
  return warnings;
}
