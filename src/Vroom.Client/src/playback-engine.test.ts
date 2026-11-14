import { describe, it, expect } from 'vitest';
import { playbackEngine } from './playback-engine';
describe('mounted playback engine', () => {
  it('retains native playback while an edited runtime path becomes unavailable', () => {
    const mounted = playbackEngine(undefined, 'auto', { available: true, embedded: true });
    expect(playbackEngine(mounted, 'auto', { available: false, embedded: true })).toBe(mounted);
  });
  it('retains browser playback when a runtime is installed during playback', () => {
    const mounted = playbackEngine(undefined, 'auto', { available: false, embedded: true });
    expect(playbackEngine(mounted, 'auto', { available: true, embedded: true })).toBe(mounted);
  });
  it('uses current capabilities after explicit engine changes', () => {
    const first = playbackEngine(undefined, 'auto', { available: true, embedded: true });
    const browser = playbackEngine(first, 'browser', { available: true, embedded: true });
    expect(browser.native).toBe(false);
    expect(playbackEngine(browser, 'auto', { available: false, embedded: true }).native).toBe(false);
    expect(playbackEngine(browser, 'mpv', { available: true, embedded: true }).native).toBe(true);
  });
});
