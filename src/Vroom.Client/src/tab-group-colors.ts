// Names resolve to Spectrum visual + subtle-background tokens in theme.ts.
export const groupColors = ['blue', 'purple', 'cyan', 'orange', 'green', 'magenta'] as const;
export type GroupColor = (typeof groupColors)[number];

export function assignGroupColors(keys: string[]): Map<string, GroupColor> {
  const assigned = new Map<string, GroupColor>();
  const counts = new Map(groupColors.map(color => [color, 0]));
  let previous: GroupColor | undefined;
  for (const key of keys) {
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const available = groupColors.filter(color => color !== previous);
    const leastUsed = Math.min(...available.map(color => counts.get(color)!));
    const preferred = groupColors.map((_, offset) => groupColors[(hash + offset) % groupColors.length]);
    const color = preferred.find(color => color !== previous && counts.get(color) === leastUsed)!;
    assigned.set(key, color);
    counts.set(color, counts.get(color)! + 1);
    previous = color;
  }
  return assigned;
}
