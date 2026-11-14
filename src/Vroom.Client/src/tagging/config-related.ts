import type { RelatedConfigChange } from './option-list';

export type RelatedConfigChanges = RelatedConfigChange | RelatedConfigChange[];
export const relatedChanges = (change?: RelatedConfigChanges): RelatedConfigChange[] =>
  !change ? [] : Array.isArray(change) ? change : [change];

/** Publish dependencies using the retained draft graph, never the stale installed source. */
export function configurationDependencies(kind: string, value: any, sources: Record<string, any>): string[] {
  const result = new Set<string>();
  const sourceRules = (source: any) => {
    for (const field of Object.values(source?.parse?.fields ?? {}) as any[])
      if (field.normalizeWith) result.add('rules/' + field.normalizeWith);
  };
  if (kind === 'definition') {
    if (value?.value?.vocabulary) result.add('vocabularies/' + value.value.vocabulary);
    for (const rule of [...(value?.initialization ?? []), ...(value?.automation ?? [])])
      if (rule.args?.rule) result.add('rules/' + rule.args.rule);
    for (const mapping of value?.enrichment ?? []) {
      result.add('sources/' + mapping.source);
      sourceRules(sources[mapping.source]);
    }
  }
  if (kind === 'sources') sourceRules(value);
  return [...result];
}
