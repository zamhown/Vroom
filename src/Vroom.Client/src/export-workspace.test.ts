import { describe, expect, it } from 'vitest';
import { initialWorkspace, workspaceReducer } from './workspace';

describe('single conversion workspace', () => {
  it('pins the part selected in the player when adding a work to an existing draft', () => {
    let workspace = workspaceReducer(initialWorkspace(), {
      type: 'open',
      tab: { id: 'export', kind: 'export', title: 'Convert', state: { directory: 'D:/out' } },
    });
    workspace = workspaceReducer(workspace, {
      type: 'open',
      tab: {
        id: 'export',
        kind: 'export',
        title: 'Convert',
        params: { filmId: 'unknown-work', partId: 'chosen-clock' },
        state: {},
      },
    });
    const tab = workspace.tabs.find(t => t.kind === 'export')!;
    expect(tab.state).toMatchObject({
      directory: 'D:/out',
      pendingFilmIds: ['unknown-work'],
      pendingParts: { 'unknown-work': 'chosen-clock' },
    });
    expect(tab.params?.filmId).toBeUndefined();
    workspace = workspaceReducer(workspace, {
      type: 'open',
      tab: {
        id: 'export',
        kind: 'export',
        title: 'Convert',
        state: { replaceSources: true, pendingFilmIds: ['other'] },
      },
    });
    expect(workspace.tabs.find(t => t.kind === 'export')!.state.pendingParts).toEqual({});
  });
  it('keeps an explicit batch selection exact while retaining the encoding settings', () => {
    let workspace = workspaceReducer(initialWorkspace(), {
      type: 'open',
      tab: {
        id: 'export',
        kind: 'export',
        title: 'Convert',
        state: { directory: 'D:/out', options: { encoder: 'x265' }, sources: [{ key: 'a', filmId: 'a' }] },
      },
    });
    workspace = workspaceReducer(workspace, {
      type: 'open',
      tab: {
        id: 'export',
        kind: 'export',
        title: 'Convert',
        state: { replaceSources: true, pendingFilmIds: ['b', 'c'] },
      },
    });
    expect(workspace.tabs.find(t => t.kind === 'export')?.state).toMatchObject({
      directory: 'D:/out',
      options: { encoder: 'x265' },
      sources: [],
      pendingFilmIds: ['b', 'c'],
    });
  });
  it('opens from different films into one tab without replacing the encoding draft', () => {
    let workspace = workspaceReducer(initialWorkspace(), {
      type: 'open',
      tab: {
        id: 'export',
        kind: 'export',
        title: 'Convert',
        state: { directory: 'D:/out', options: { encoder: 'x265' }, sources: [{ key: 'a', filmId: 'a' }] },
      },
    });
    for (const filmId of ['a', 'b', 'b'])
      workspace = workspaceReducer(workspace, {
        type: 'open',
        tab: { id: 'export:' + filmId, kind: 'export', title: 'Convert', params: { filmId }, state: {} },
      });
    const tabs = workspace.tabs.filter(t => t.kind === 'export');
    expect(tabs).toHaveLength(1);
    expect(workspace.activeId).toBe('export');
    expect(tabs[0].state).toMatchObject({
      directory: 'D:/out',
      options: { encoder: 'x265' },
      sources: [{ key: 'a', filmId: 'a' }],
      pendingFilmIds: ['b'],
    });
  });
});
