import { describe, it, expect } from 'vitest';
import { shiftedSubtitle } from './player-utils';
import { validateWorkspace } from './workspace';
describe('playback state', () => {
  it('supports signed subtitle delay and keeps cue settings after a seek', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:03.000 align:start\nHello';
    expect(shiftedSubtitle(vtt, -2)).toContain('00:00:03.000 --> 00:00:05.000 align:start');
    expect(shiftedSubtitle(vtt, 2)).toContain('00:00:00.000 --> 00:00:01.000 align:start');
    expect(shiftedSubtitle(vtt, NaN)).toBe(vtt);
  });
  it('aligns external subtitles after transcoded seeks without negative or stale cues', () => {
    const vtt =
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nold\n\n2\n00:00:04.000 --> 00:00:06.000\n重叠\n\n3\n00:00:07.500 --> 00:00:09.000\n字幕';
    const shifted = shiftedSubtitle(vtt, 5);
    expect(shifted).not.toContain('old');
    expect(shifted).toContain('00:00:00.000 --> 00:00:01.000\n重叠');
    expect(shifted).toContain('00:00:02.500 --> 00:00:04.000\n字幕');
    expect(shiftedSubtitle(vtt, 0)).toBe(vtt);
  });
  it('does not rewrite user titles on every restore and preserves drafts and the active tab', () => {
    const result = validateWorkspace({
      version: 3,
      activeId: 'duplicates',
      tabs: [
        { id: 'duplicates', kind: 'duplicates', title: '去重复核', state: { selected: { a: ['film1'] } }, dirty: true },
      ],
    });
    expect(result.activeId).toBe('duplicates');
    expect(result.tabs[1].title).toBe('去重复核');
    expect(result.tabs[1].state).toEqual({ selected: { a: ['film1'] } });
    expect(result.tabs[1].dirty).toBe(true);
  });
});
