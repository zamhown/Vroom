import registry from '../../../resources/tagging/host-capabilities.json';
import type { ImagePresentation } from './types';

/** Width ÷ height of the fixed frame that holds a 3D case, and of covers whose image size is unknown. */
export const frameRatio = 3 / 4;
// Assumed only for an explicitly chosen case until its image reports a size.
const unfoldedRatio = 3 / 2;
const disc = registry.$defs['imagePresentations.disc-case@1'].properties;

export type PosterLayout =
  | { kind: 'whole'; ratio: number }
  | { kind: 'cover'; ratio: number; side: 'front' | 'back' }
  /** width, height and depth of the case are fractions of the frame width. */
  | { kind: 'case'; ratio: number; width: number; height: number; depth: number };

/**
 * Card geometry for a poster: `ratio` is the card's width ÷ height, all cards sharing one height.
 * @param aspect the image's width ÷ height, when known
 */
export function posterLayout(presentation: ImagePresentation | null | undefined, aspect?: number): PosterLayout {
  const known = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
  if (presentation?.component !== 'disc-case@1') return { kind: 'whole', ratio: known ?? frameRatio };
  const image = known ?? unfoldedRatio;
  const spine = typeof presentation.props.spine === 'number' ? presentation.props.spine : disc.spine.default;
  const cover = (1 - spine) / 2;
  const view = presentation.props.view ?? disc.view.default;
  if (view !== '3d') return { kind: 'cover', side: view === 'back' ? 'back' : 'front', ratio: image * cover };
  // The case fills most of the frame height, and its outline stays inside the frame while it turns.
  const height = Math.min(0.92 / frameRatio, 0.9 / (image * Math.hypot(cover, spine)));
  return { kind: 'case', ratio: frameRatio, height, width: height * image * cover, depth: height * image * spine };
}
