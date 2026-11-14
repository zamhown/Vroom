import type { DropEdge } from './workspace';

export type TabGroupBounds = { key: string; left: number; right: number };
export type DropPosition = { key: string; edge: DropEdge };

// Use untransformed layout bounds so animated neighbours cannot change the hit target.
export function projectTabDrag(bounds: TabGroupBounds[], sourceKey: string, pointerX: number) {
  const sourceIndex = bounds.findIndex(group => group.key === sourceKey);
  const offsets: Record<string, number> = {};
  if (sourceIndex < 0) return { target: null as DropPosition | null, offsets };
  const source = bounds[sourceIndex],
    remaining = bounds.filter(group => group !== source);
  let insertion = remaining.findIndex(group => pointerX < (group.left + group.right) / 2);
  if (insertion < 0) insertion = remaining.length;
  if (insertion === sourceIndex) return { target: null as DropPosition | null, offsets };
  const width = source.right - source.left;
  if (insertion < sourceIndex) {
    for (let i = insertion; i < sourceIndex; i++) offsets[bounds[i].key] = width;
  } else {
    for (let i = sourceIndex + 1; i <= insertion; i++) offsets[bounds[i].key] = -width;
  }
  const target: DropPosition =
    insertion < remaining.length
      ? { key: remaining[insertion].key, edge: 'before' }
      : { key: remaining[remaining.length - 1].key, edge: 'after' };
  return { target, offsets };
}
