import type { ReactNode } from 'react';
import { supportsTarget } from './annotation-targets';
import { whole, type Scope, type LayoutNode, type TagPackage } from './types';

/** Regions own their member order (ui.placementOrder); unlisted members follow in key order. */
export function placementRank(pack: Pick<TagPackage, 'ui'>, slot: string, key: string) {
  const index = pack.ui.placementOrder?.[slot]?.indexOf(key) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
export function comparePlacements(
  pack: Pick<TagPackage, 'ui'>,
  slots: string[],
  a: { key: string; slot: string },
  b: { key: string; slot: string },
) {
  return (
    slots.indexOf(a.slot) - slots.indexOf(b.slot) ||
    placementRank(pack, a.slot, a.key) - placementRank(pack, b.slot, b.key) ||
    a.key.localeCompare(b.key)
  );
}
export function placements(
  pack: Pick<TagPackage, 'definitions' | 'ui'>,
  regions: string | string[],
  scope: Scope = whole,
) {
  const slots = Array.isArray(regions) ? regions : [regions],
    seen = new Set<string>();
  return pack.definitions
    .filter(d => d.enabled && supportsTarget(d, 'film', scope.kind))
    .flatMap(definition =>
      definition.placements.filter(p => slots.includes(p.slot)).map(placement => ({ definition, placement })),
    )
    .sort((a, b) =>
      comparePlacements(
        pack,
        slots,
        { key: a.definition.key, slot: a.placement.slot },
        { key: b.definition.key, slot: b.placement.slot },
      ),
    )
    .filter(x => {
      if (seen.has(x.definition.key)) return false;
      seen.add(x.definition.key);
      return true;
    });
}

/** Shared structural renderer. The caller supplies leaves and all side effects. */
export function LayoutFrame({ node, title, children }: { node: LayoutNode; title?: string; children: ReactNode }) {
  if (node.type === 'grid')
    return (
      <div
        className="schema-grid"
        style={{
          ['--layout-tracks' as string]: (node.tracks?.regular ?? [2, 1])
            .map((n: number) => `minmax(0, ${n}fr)`)
            .join(' '),
        }}
      >
        {children}
      </div>
    );
  if (node.type === 'section')
    return (
      <section className="schema-section">
        {title && <h2>{title}</h2>}
        {children}
      </section>
    );
  if (node.type === 'disclosure')
    return (
      <details className="schema-section disclosure-section">
        <summary>{title}</summary>
        {children}
      </details>
    );
  return <div className={`schema-stack gap-${node.gap ?? 'field'}`}>{children}</div>;
}
