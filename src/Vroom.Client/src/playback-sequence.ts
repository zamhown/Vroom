export type PlaybackAdvance =
  { kind: 'part'; id: string } | { kind: 'work'; index: number } | { kind: 'restart' } | { kind: 'stop' };
/** Parts are clocks within one version; repeating a work starts that version again. */
export function playbackAdvance(
  parts: readonly { id: string }[] | undefined,
  partId: string | undefined,
  index: number,
  length: number,
  repeat: string,
): PlaybackAdvance {
  const current = parts?.findIndex(part => part.id === partId) ?? -1;
  if (parts && current >= 0 && current + 1 < parts.length) return { kind: 'part', id: parts[current + 1].id };
  if (repeat === 'one' || (repeat === 'queue' && length === 1)) {
    if (parts?.length && parts[0].id !== partId) return { kind: 'part', id: parts[0].id };
    return { kind: 'restart' };
  }
  if (index + 1 < length) return { kind: 'work', index: index + 1 };
  if (repeat === 'queue' && length > 1) return { kind: 'work', index: 0 };
  return { kind: 'stop' };
}
