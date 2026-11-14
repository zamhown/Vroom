import { describe, expect, it } from 'vitest';
import { assignGroupColors, groupColors } from './tab-group-colors';

describe('Spectrum tab group colors', () => {
  it('uses distinct colors before reusing the palette and never repeats adjacent colors', () => {
    const keys = Array.from({ length: 48 }, (_, index) => 'film:' + index);
    const colors = [...assignGroupColors(keys).values()];
    expect(new Set(colors.slice(0, groupColors.length)).size).toBe(groupColors.length);
    expect(
      colors.every((color, index) => groupColors.includes(color) && (index === 0 || color !== colors[index - 1])),
    ).toBe(true);
    const restoredKeys: string[] = JSON.parse(JSON.stringify(keys));
    expect(assignGroupColors(restoredKeys)).toEqual(assignGroupColors(keys));
  });
  it('refreshes a repeated color when dragging two equally colored groups together', () => {
    const keys = Array.from({ length: 18 }, (_, index) => 'library:' + index);
    const before = assignGroupColors(keys);
    const first = keys[0],
      repeated = keys.slice(1).find(key => before.get(key) === before.get(first))!;
    const reordered = [first, repeated, ...keys.filter(key => key !== first && key !== repeated)];
    const after = assignGroupColors(reordered);
    expect(before.get(first)).toBe(before.get(repeated));
    expect(after.get(first)).not.toBe(after.get(repeated));
    expect(reordered.every((key, index) => index === 0 || after.get(key) !== after.get(reordered[index - 1]))).toBe(
      true,
    );
  });
});
