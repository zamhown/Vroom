import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScrubber, playbackDuration, playbackVolume } from './playback-scrubber';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(playing = true) {
  const backend = {
    isPlaying: () => playing,
    pause: vi.fn(async () => {}),
    preview: vi.fn(async (_at: number, _signal: AbortSignal) => undefined as string | undefined),
    commit: vi.fn(async (_at: number, _playing: boolean, _signal: AbortSignal) => {}),
    resume: vi.fn(async (_playing: boolean) => {}),
    changed: vi.fn(),
    failed: vi.fn(),
  };
  return { backend, scrubber: createScrubber(backend, 90) };
}
afterEach(() => vi.useRealTimers());
describe('interactive seeking', () => {
  it('shows previews before release, bounds work, and commits the latest destination exactly', async () => {
    vi.useFakeTimers();
    const { backend, scrubber } = fixture();
    const first = deferred();
    backend.preview.mockImplementationOnce(async () => {
      await first.promise;
      return 'frame-a';
    });
    scrubber.preview(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.preview).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    for (let i = 11; i <= 90; i++) scrubber.preview(i);
    scrubber.commit(91.125);
    expect(backend.commit).not.toHaveBeenCalled();
    first.resolve();
    await vi.runAllTimersAsync();
    expect(backend.preview).toHaveBeenCalledTimes(1);
    expect(backend.commit).toHaveBeenCalledWith(91.125, false, expect.any(AbortSignal));
    expect(backend.resume).toHaveBeenCalledWith(true);
    expect(backend.changed).toHaveBeenLastCalledWith(undefined);
  });
  it('updates the image during a long drag and preserves pause on release', async () => {
    vi.useFakeTimers();
    const { backend, scrubber } = fixture(false);
    backend.preview.mockResolvedValue('image');
    scrubber.preview(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.changed).toHaveBeenCalledWith(3, 'image');
    scrubber.preview(6);
    await vi.advanceTimersByTimeAsync(100);
    expect(backend.preview).toHaveBeenCalledTimes(2);
    scrubber.commit(6);
    await vi.runAllTimersAsync();
    expect(backend.resume).toHaveBeenCalledWith(false);
  });
  it('cancels a stale session without displaying its image or resuming it', async () => {
    vi.useFakeTimers();
    const { backend, scrubber } = fixture();
    const waiting = deferred();
    backend.preview.mockImplementation(async () => {
      await waiting.promise;
      return 'old-frame';
    });
    scrubber.preview(5);
    await vi.advanceTimersByTimeAsync(100);
    scrubber.commit(8);
    scrubber.cancel();
    waiting.resolve();
    await vi.runAllTimersAsync();
    expect(backend.commit).not.toHaveBeenCalled();
    expect(backend.resume).not.toHaveBeenCalled();
    expect(backend.changed).not.toHaveBeenCalledWith(5, 'old-frame');
    expect(backend.failed).not.toHaveBeenCalled();
  });
  it('does not resume an older commit when another destination arrives', async () => {
    vi.useFakeTimers();
    const { backend, scrubber } = fixture();
    const waiting = deferred();
    backend.commit.mockImplementationOnce(async () => waiting.promise);
    scrubber.commit(5);
    await vi.advanceTimersByTimeAsync(1);
    scrubber.preview(20);
    scrubber.commit(25);
    waiting.resolve();
    await vi.runAllTimersAsync();
    expect(backend.commit.mock.calls.map(args => args[0])).toEqual([5, 25]);
    expect(backend.resume).toHaveBeenCalledTimes(1);
  });
  it('clears failed gestures and permits the next one', async () => {
    vi.useFakeTimers();
    const { backend, scrubber } = fixture(false);
    const failure = new Error('decoder');
    backend.preview.mockRejectedValueOnce(failure);
    scrubber.preview(2);
    await vi.runAllTimersAsync();
    expect(backend.failed).toHaveBeenCalledWith(failure);
    scrubber.commit(4);
    await vi.runAllTimersAsync();
    expect(backend.commit).toHaveBeenCalledWith(4, false, expect.any(AbortSignal));
  });
});
describe('effective media control values', () => {
  it('prefers decoder duration over stale catalog facts and ignores unknown values', () => {
    expect(playbackDuration(123.5, 0)).toBe(123.5);
    expect(playbackDuration(Infinity, NaN, 80)).toBe(80);
    expect(playbackDuration(0, undefined)).toBe(0);
  });
  it('keeps a native gain from overflowing browser volume after engine switching', () => {
    expect(playbackVolume(1.8)).toBe(1);
    expect(playbackVolume(1.8, 2)).toBe(1.8);
    expect(playbackVolume(-0.2)).toBe(0);
    expect(playbackVolume(NaN)).toBe(0.8);
  });
});
