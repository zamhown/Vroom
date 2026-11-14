import resource from '../../../../resources/tagging/annotation-targets.json';

export const annotationTargets = resource.targets;

/** The four independent subjects are defined by the public contract. */
export function definitionTargets(definition: unknown): string[] {
  const d = definition as { targets?: unknown } | undefined;
  const targets = Array.isArray(d?.targets) ? d.targets : [];
  return annotationTargets.filter(t => targets.includes(t.id)).map(t => t.id);
}
export const supportsTarget = (definition: unknown, subject: string, scope?: string) =>
  annotationTargets.some(
    t => t.subject === subject && (!scope || t.scope === scope) && definitionTargets(definition).includes(t.id),
  );
