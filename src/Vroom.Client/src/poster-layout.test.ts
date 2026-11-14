import { describe, expect, it } from 'vitest';
import { frameRatio, posterLayout } from './poster-layout';

const disc = (view: string, spine = 0.05) => ({ component: 'disc-case@1', props: { view, spine } });

describe('poster layout', () => {
  it('shows whole images at their own ratio and unknown presentations as whole images', () => {
    expect(posterLayout({ component: 'image@1', props: {} }, 16 / 9)).toEqual({ kind: 'whole', ratio: 16 / 9 });
    expect(posterLayout({ component: 'unregistered@1', props: { view: '3d' } }, 2 / 3)).toEqual({
      kind: 'whole',
      ratio: 2 / 3,
    });
    expect(posterLayout(undefined, Number.NaN)).toEqual({ kind: 'whole', ratio: frameRatio });
  });

  it('crops one flat cover from the unfolded image, leaving the spine out', () => {
    const front = posterLayout(disc('front', 0.1), 1.6);
    expect(front).toMatchObject({ kind: 'cover', side: 'front' });
    // The card shows exactly one cover: (image width − spine) / 2 at the shared height.
    expect(front.ratio).toBeCloseTo((1.6 * (1 - 0.1)) / 2);
    expect(posterLayout(disc('back'), 1.5)).toMatchObject({ kind: 'cover', side: 'back' });
  });

  it('keeps a 3D case inside its fixed frame for any unfolded shape', () => {
    for (const aspect of [1.2, 1.5, 2, 3]) {
      for (const spine of [0.02, 0.05, 0.3]) {
        const layout = posterLayout(disc('3d', spine), aspect);
        if (layout.kind !== 'case') throw new Error('expected a case');
        expect(layout.ratio).toBe(frameRatio);
        // Faces keep the image's proportions: cover and spine come from the same image height.
        expect(layout.width / layout.height).toBeCloseTo((aspect * (1 - spine)) / 2);
        expect(layout.depth / layout.width).toBeCloseTo(spine / ((1 - spine) / 2));
        // Never taller than the frame, and the widest turning outline stays within the frame width.
        expect(layout.height * frameRatio).toBeLessThan(1);
        expect(Math.hypot(layout.width, layout.depth)).toBeLessThanOrEqual(0.9 + 1e-9);
      }
    }
  });
});
