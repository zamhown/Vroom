import { termOptions } from './i18n';
import type { Definition, Json, LayoutNode, LocalizedText, Placement, TagPackage } from './types';

export type PreviewContext =
  | { kind: 'layout'; surface: string; title?: LocalizedText; root: LayoutNode; path: LayoutNode[] }
  | { kind: 'card' | 'navigation' | 'table' | 'player' | 'library'; surface: string };

export function regionPath(node: LayoutNode, region: string): LayoutNode[] | undefined {
  const regions = Array.isArray(node.region) ? node.region : [node.region];
  if (regions.includes(region)) return [node];
  for (const child of node.children ?? []) {
    const path = regionPath(child, region);
    if (path) return [node, ...path];
  }
}

/** Resolve the active surface binding, never an unused layout with a similar name.
 * Host-owned regions describe UI geometry only; field identity has no role here. */
export function previewContext(pack: TagPackage, placement?: Placement): PreviewContext | undefined {
  if (!placement) return undefined;
  for (const [surface, id] of Object.entries(pack.ui.surfaceBindings)) {
    const layout = pack.ui.layouts[id];
    if (!layout) continue;
    const path = regionPath(layout.root, placement.slot);
    if (path) return { kind: 'layout', surface, title: layout.title, root: layout.root, path };
  }
  if (placement.slot.startsWith('film.card.')) return { kind: 'card', surface: 'film.card' };
  if (placement.slot === 'nav.after-all-films') return { kind: 'navigation', surface: 'navigation' };
  if (placement.slot === 'film.table.columns') return { kind: 'table', surface: 'film.table' };
  if (['player.queue.item.trailing', 'player.toolbar.extensions'].includes(placement.slot))
    return { kind: 'player', surface: 'player' };
  if (['library.filters', 'library.sorts', 'library.groupings'].includes(placement.slot))
    return { kind: 'library', surface: 'library' };
}

/** Local trial data only. Enum examples always use existing stable term identities. */
export function previewValue(d: Definition, pack: TagPackage, text: string): Json {
  const schema = d.value.schema;
  let sample: Json = null;
  if (d.value.vocabulary) sample = termOptions(d, pack)[0]?.value ?? null;
  else if (schema.type === 'boolean') sample = true;
  else if (['number', 'integer'].includes(schema.type)) {
    const min = schema.minimum ?? 0,
      max = schema.maximum ?? Math.max(min, 10),
      step = schema.multipleOf ?? (schema.type === 'integer' ? 1 : 0.5);
    const first = Math.ceil(min / step) * step,
      last = Math.floor(max / step) * step;
    if (step > 0 && first <= last) sample = Number((Math.round((first + last) / 2 / step) * step).toPrecision(12));
  } else if (schema.type === 'string' && !schema.pattern) {
    if (schema.format === 'date') sample = '2026-01-01';
    else if (!schema.format && d.input.component !== 'asset@1') sample = text.slice(0, schema.maxLength ?? text.length);
  }
  return d.value.cardinality === 'many' ? (sample == null ? [] : [sample]) : sample;
}
