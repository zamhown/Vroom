import { describe, expect, it } from 'vitest';
import { activityLayout } from './activity';
import type { TagPackage } from '../tagging/types';
import defaults from '../../../../resources/tagging/core.tagdefs.json';

describe('resource-authored activity sidebar', () => {
  it('uses the selected layout and authored tabs and providers without concrete tag dependencies', () => {
    const pack = structuredClone(defaults) as unknown as TagPackage;
    pack.ui.layouts['unfamiliar.inbox'] = {
      surface: 'workspace.sidebar',
      root: {
        id: 'research',
        type: 'activity-feed',
        title: { en: 'Review desk' },
        activity: { tabs: ['settings'], sources: ['candidates'] },
      },
    };
    pack.ui.surfaceBindings['workspace.sidebar'] = 'unfamiliar.inbox';
    expect(activityLayout(pack, 'settings')).toEqual({
      title: { en: 'Review desk' },
      config: { tabs: ['settings'], sources: ['candidates'] },
    });
    expect(activityLayout(pack, 'library')).toBeUndefined();
    expect(activityLayout(pack, 'player')).toBeUndefined();
  });
  it('does not resurrect defaults after removing the sidebar binding', () => {
    const pack = structuredClone(defaults) as unknown as TagPackage;
    delete pack.ui.surfaceBindings['workspace.sidebar'];
    expect(activityLayout(pack, 'library')).toBeUndefined();
  });
  it('keeps playback out of the default sidebar and supports film, tag and export workflows', () => {
    const pack = defaults as unknown as TagPackage;
    for (const kind of ['library', 'film', 'tags', 'export'] as const) expect(activityLayout(pack, kind)).toBeDefined();
    expect(activityLayout(pack, 'player')).toBeUndefined();
  });
});
