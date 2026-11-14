import { describe, expect, it, vi } from 'vitest';
import { openConfiguration, openTagSettings, openTermProfile } from './field-links';
import type { useApp } from '../context';

describe('management entry destinations', () => {
  it('routes source, field and value shortcuts to sections of one workspace tab without replacing drafts', () => {
    const tabs = [
      {
        id: 'tags',
        state: {
          drafts: { 'definition/user.sample': 'draft', 'sources/user.provider': 'draft' },
          termProfileDrafts: { value: { label: 'draft' } },
          search: 'old',
        },
      },
    ];
    const app = {
      workspace: { tabs, activeId: 'settings' },
      activate: vi.fn(),
      open: vi.fn(),
      patchState: vi.fn((id: string, change: (value: object) => object) => {
        const tab = tabs.find(t => t.id === id)!;
        Object.assign(tab, { state: change(tab.state) });
      }),
    } as unknown as ReturnType<typeof useApp>;
    openConfiguration(app, 'sources', 'user.provider');
    expect(app.activate).toHaveBeenLastCalledWith('tags');
    expect(tabs[0].state).toMatchObject({
      catalogMode: 'configuration',
      kind: 'sources',
      selected: 'user.provider',
      search: '',
      drafts: { 'definition/user.sample': 'draft', 'sources/user.provider': 'draft' },
    });
    openTagSettings(app, 'user.sample');
    expect(app.activate).toHaveBeenLastCalledWith('tags');
    expect(tabs[0].state).toMatchObject({
      kind: 'definition',
      selected: 'user.sample',
      catalogMode: 'definitions',
      drafts: { 'definition/user.sample': 'draft' },
    });
    openTermProfile(app, 'user.term.sample', 'user.values.sample');
    expect(tabs[0].state).toMatchObject({
      catalogMode: 'values',
      termSelected: 'user.term.sample',
      termVocabulary: 'user.values.sample',
      termProfileDrafts: { value: { label: 'draft' } },
    });
    expect(app.open).not.toHaveBeenCalled();
  });
});
