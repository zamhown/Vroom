import { describe, expect, it } from 'vitest';
import { parseTimecode } from './player-utils';

describe('go to time', () => {
  it('accepts seconds, minutes and hours including subsecond positions', () => {
    expect(parseTimecode('83.125')).toBe(83.125);
    expect(parseTimecode(' 1:23.125 ')).toBe(83.125);
    expect(parseTimecode('01:23:45.500')).toBe(5025.5);
    expect(parseTimecode('100:00:00')).toBe(360000);
    expect(parseTimecode('0')).toBe(0);
  });
  it('rejects malformed values and overflowing minute or second fields', () => {
    for (const value of ['', '-1', 'NaN', '1e9', '1:60', '1:00:60', '1:61:00', '1:00:00:00', '1.2345', '1::2'])
      expect(parseTimecode(value)).toBeUndefined();
  });
});
