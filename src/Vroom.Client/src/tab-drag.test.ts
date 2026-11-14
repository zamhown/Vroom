import { describe, expect, it } from 'vitest';
import { projectTabDrag } from './tab-drag';

describe('tab drag displacement', () => {
  const bounds = [
    { key: 'a', left: 0, right: 120 },
    { key: 'b', left: 120, right: 360 },
    { key: 'c', left: 360, right: 460 },
    { key: 'd', left: 460, right: 600 },
  ];
  it('moves crossed neighbours aside by the whole source group width', () => {
    expect(projectTabDrag(bounds, 'b', 590)).toEqual({
      target: { key: 'd', edge: 'after' },
      offsets: { c: -240, d: -240 },
    });
    expect(projectTabDrag(bounds, 'b', 0)).toEqual({ target: { key: 'a', edge: 'before' }, offsets: { a: 240 } });
  });
  it('clears the preview when the pointer returns to the original slot', () => {
    expect(projectTabDrag(bounds, 'b', 240)).toEqual({ target: null, offsets: {} });
    expect(projectTabDrag([bounds[0]], 'a', 900)).toEqual({ target: null, offsets: {} });
    expect(projectTabDrag(bounds, 'missing', 0)).toEqual({ target: null, offsets: {} });
  });
  it('uses midpoint thresholds and remains stable after horizontal scrolling', () => {
    expect(projectTabDrag(bounds, 'a', 239).offsets).toEqual({});
    expect(projectTabDrag(bounds, 'a', 241)).toEqual({ target: { key: 'c', edge: 'before' }, offsets: { b: -120 } });
    const scrolled = bounds.map(group => ({ ...group, left: group.left - 200, right: group.right - 200 }));
    expect(projectTabDrag(scrolled, 'a', 241 - 200)).toEqual(projectTabDrag(bounds, 'a', 241));
    expect(bounds[1].left).toBe(120);
  });
});
