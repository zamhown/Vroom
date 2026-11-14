import { describe, it, expect } from 'vitest';
import { playbackAdvance } from './playback-sequence';
describe('work and part playback progression', () => {
  const parts = [{ id: 'chapter-a' }, { id: 'chapter-b' }];
  it.each(['one', 'queue'])('repeats an entire multipart work in %s mode', repeat => {
    expect(playbackAdvance(parts, 'chapter-a', 0, 1, repeat)).toEqual({ kind: 'part', id: 'chapter-b' });
    expect(playbackAdvance(parts, 'chapter-b', 0, 1, repeat)).toEqual({ kind: 'part', id: 'chapter-a' });
  });
  it('finishes the selected version before advancing or wrapping the queue', () => {
    expect(playbackAdvance(parts, 'chapter-a', 1, 2, 'queue')).toEqual({ kind: 'part', id: 'chapter-b' });
    expect(playbackAdvance(parts, 'chapter-b', 0, 2, 'off')).toEqual({ kind: 'work', index: 1 });
    expect(playbackAdvance(parts, 'chapter-b', 1, 2, 'queue')).toEqual({ kind: 'work', index: 0 });
    expect(playbackAdvance(parts, 'chapter-b', 1, 2, 'off')).toEqual({ kind: 'stop' });
  });
  it('restarts a single clock without requesting a nonexistent part', () => {
    expect(playbackAdvance([{ id: 'only' }], 'only', 0, 1, 'one')).toEqual({ kind: 'restart' });
    expect(playbackAdvance(undefined, undefined, 0, 1, 'queue')).toEqual({ kind: 'restart' });
  });
});
