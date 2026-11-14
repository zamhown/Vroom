import { describe, expect, it } from 'vitest';
import { displayStyleLabel, displayStylePositions } from './display-style';
import type { Definition, TagPackage } from './types';

const catalog = { i18n: { defaultLocale: 'en', messages: {} } } as TagPackage;
const definition = {
  display: {
    'profile-id': {
      component: 'text-display@1',
      label: { en: 'Brief', 'zh-CN': '摘要' },
    },
  },
  placements: [
    { id: 'a', slot: 'card.bottom', view: 'display.profile-id', mode: 'display' },
    { id: 'b', slot: 'info.main', view: 'input', mode: 'edit' },
  ],
} as unknown as Definition;
describe('named display styles', () => {
  it('uses localized names and keeps references intact on rename', () => {
    expect(displayStyleLabel(definition, 'profile-id', 'zh-CN', catalog)).toBe('摘要');
    const renamed = structuredClone(definition);
    renamed.display!['profile-id'].label = { en: 'Short summary' };
    expect(displayStyleLabel(renamed, 'profile-id', 'en', catalog)).toBe('Short summary');
    expect(displayStylePositions(renamed, 'profile-id')).toEqual([definition.placements[0]]);
    expect(renamed.placements).toEqual(definition.placements);
  });
  it('does not expose an internal key when the optional name is unset', () => {
    const unnamed = { ...definition, display: { 'profile-id': { component: 'text-display@1' } } };
    expect(displayStyleLabel(unnamed, 'profile-id', 'en', catalog)).toBe('Display style 1');
  });
});
