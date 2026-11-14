import { describe, expect, it } from 'vitest';
import {
  initialWorkspace,
  workspaceReducer as reduce,
  validateWorkspace,
  workspaceGroups,
  workspaceSourceKey,
  workspacePageLabel,
  type Workspace,
  type WorkspaceTab,
} from './workspace';
import { annotationPercent, clampTime, subtitleToVtt } from './player-utils';

describe('kept-alive workspace', () => {
  it('keeps field and configuration drafts in one workspace tab when reopening or restoring it', () => {
    const state = {
      catalogMode: 'configuration',
      kind: 'sources',
      selected: 'user.source.unfamiliar',
      drafts: {
        'definition/user.field.unfamiliar': '{"revision":2}',
        'sources/user.source.unfamiliar': '{"enabled":false}',
      },
    };
    let workspace = reduce(initialWorkspace(), {
      type: 'open',
      tab: { id: 'tags', kind: 'tags', title: 'Tags', state, dirty: true },
    });
    workspace = reduce(workspace, { type: 'open', tab: { id: 'tags', kind: 'tags', title: 'Tags', state: {} } });
    expect(workspace.activeId).toBe('tags');
    expect(workspace.tabs.find(t => t.id === 'tags')?.state).toEqual(state);
    expect(validateWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
    expect(workspaceGroups(workspace.tabs).map(group => group.key)).toEqual(['tab:home', 'tab:tags']);
    // A tab kind that no longer exists is dropped instead of rendering nothing.
    const stale = JSON.parse(JSON.stringify(workspace));
    stale.tabs.push({ id: 'configuration', kind: 'configuration', title: 'Configuration', state: {} });
    expect(validateWorkspace(stale).tabs.some((tab: { id: string }) => tab.id === 'configuration')).toBe(false);
  });
  it('preserves independent filters, scroll, drafts and player queues while switching and reopening tabs', () => {
    let workspace = reduce(initialWorkspace(), {
      type: 'update',
      id: 'home',
      change: { state: { search: 'DEMO', scroll: 400 } },
    });
    workspace = reduce(workspace, {
      type: 'open',
      tab: {
        id: 'detail',
        kind: 'film',
        title: 'Detail',
        params: { filmId: 'a' },
        state: { title: 'unsaved draft' },
        dirty: true,
      },
    });
    workspace = reduce(workspace, {
      type: 'open',
      tab: {
        id: 'player',
        kind: 'player',
        title: 'Player',
        params: { queue: ['a', 'b'] },
        state: { index: 1, rate: 1.5, inPoint: 3 },
      },
    });
    workspace = reduce(workspace, { type: 'activate', id: 'home' });
    workspace = reduce(workspace, {
      type: 'open',
      tab: { id: 'detail', kind: 'film', title: 'Replacement', state: {} },
    });
    expect(workspace.tabs).toHaveLength(3);
    expect(workspace.tabs[0].state).toEqual({ search: 'DEMO', scroll: 400 });
    expect(workspace.tabs[1].state.title).toBe('unsaved draft');
    expect(workspace.tabs[1].dirty).toBe(true);
    expect(workspace.tabs[2].state.index).toBe(1);
    expect(validateWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
  });
  it('closes the active tab into its neighbour and protects the home tab', () => {
    let workspace = reduce(initialWorkspace(), {
      type: 'open',
      tab: { id: 'jobs', kind: 'jobs', title: 'Jobs', state: {} },
    });
    workspace = reduce(workspace, { type: 'close', id: 'jobs' });
    expect(workspace.activeId).toBe('home');
    expect(reduce(workspace, { type: 'close', id: 'home' }).tabs).toHaveLength(1);
  });
  it('recovers a damaged persisted workspace without duplicate or unknown tabs', () => {
    const damaged = {
      version: 3,
      activeId: 'missing',
      tabs: [
        { id: 'x', kind: 'tags', title: 'Tags' },
        { id: 'x', kind: 'tags' },
        { id: 'bad', kind: 'obsolete' },
        null,
      ],
    };
    const restored = validateWorkspace(damaged as unknown as Workspace);
    expect(restored.tabs.map(t => t.id)).toEqual(['home', 'x']);
    expect(restored.activeId).toBe('home');
    expect(restored.tabs[1].state).toEqual({});
  });

  it('retains different filters, positions, drafts, unknown state and deliberately copied views', () => {
    const home = initialWorkspace().tabs[0];
    const browser = (id: string, state: Record<string, unknown>): WorkspaceTab => ({
      id,
      kind: 'library',
      title: '浏览影片',
      state,
    });
    const tabs = [
      home,
      browser('filter', { search: 'DEMO' }),
      browser('position', { scroll: 300 }),
      browser('draft', {}),
      browser('future-state', { custom: 'preserve' }),
      browser('explicit-copy', {}),
    ];
    tabs[3].dirty = true;
    tabs[5].params = { independent: true };
    const restored = validateWorkspace({ version: 3, activeId: 'filter', tabs });
    expect(restored.tabs).toEqual(tabs);
    expect(restored.activeId).toBe('filter');
  });
});

describe('source tab groups', () => {
  const page = (id: string, kind: WorkspaceTab['kind'], params?: WorkspaceTab['params']): WorkspaceTab => ({
    id,
    kind,
    title: id,
    params,
    state: {},
  });
  const ids = (workspace: Workspace) => workspace.tabs.map(tab => tab.id);
  it('shows source groups with a single member while keeping managers standalone', () => {
    const tabs = [
      page('home', 'library'),
      page('film', 'film', { filmId: 'f' }),
      page('player', 'player', { filmId: 'p' }),
      page('saved', 'library', { viewId: 'v' }),
      page('edit', 'libraries', { libraryId: 'l' }),
      page('libraries', 'libraries', { libraryId: 'l' }),
      page('views', 'views', { viewId: 'v' }),
      page('jobs', 'jobs'),
    ];
    const groups = workspaceGroups(tabs);
    expect(groups.map(group => group.grouped)).toEqual([false, true, true, true, true, false, false, false]);
    expect(groups.every(group => group.tabs.length === 1)).toBe(true);
    expect(workspacePageLabel(tabs[0])).toBe('影片列表');
    expect(workspacePageLabel(tabs[1])).toBe('影片信息');
    expect(workspacePageLabel(tabs[2])).toBe('播放影片');
    expect(workspacePageLabel(tabs[4])).toBe('编辑影片库');
  });
  it('never groups generic browsers, built-in queries, managers or temporary playlists', () => {
    const tabs = [
      page('home', 'library'),
      page('browser-a', 'library'),
      page('browser-b', 'library'),
      page('favorites', 'library'),
      page('unwatched', 'library'),
      page('hidden', 'library'),
      page('tag:actor', 'library'),
      page('copy', 'library', { sourceKey: 'tab:home', sourceTitle: '全部影片' }),
      page('queue', 'player', { filmId: 'f', queue: ['f'], sourceKey: 'tab:home' }),
      page('draft-view', 'views'),
      page('draft-library', 'libraries'),
      page('libraries', 'libraries', { libraryId: 'l' }),
      page('views', 'views', { viewId: 'v' }),
      page('tags', 'tags'),
      page('duplicates', 'duplicates'),
      page('jobs', 'jobs'),
      page('settings', 'settings'),
      page('agent', 'agent'),
    ];
    const groups = workspaceGroups(tabs);
    expect(groups).toHaveLength(tabs.length);
    expect(groups.every(group => !group.grouped && group.tabs.length === 1)).toBe(true);
    expect(groups.map(group => group.key)).toEqual(tabs.map(tab => 'tab:' + tab.id));
    expect(groups.find(group => group.key === 'tab:copy')?.title).toBe('copy');
  });
  it('keeps a lone library or saved-view playlist in its concrete source group', () => {
    const libraryQueue = page('queue-l', 'player', { filmId: 'f', queue: ['f'], sourceKey: 'library:l' });
    const viewQueue = page('queue-v', 'player', { filmId: 'f', queue: ['f'], sourceKey: 'view:v' });
    expect(workspaceGroups([libraryQueue, viewQueue]).map(group => [group.key, group.grouped])).toEqual([
      ['library:l', true],
      ['view:v', true],
    ]);
    expect(workspaceSourceKey(page('unrelated-settings', 'settings', { sourceKey: 'library:l' }))).toBe(
      'tab:unrelated-settings',
    );
  });
  it('restores the manager independently without losing its selected library or draft', () => {
    const manager = {
      ...page('libraries', 'libraries', { libraryId: 'l' }),
      state: { name: '尚未保存', roots: 'Z:\\Videos' },
      dirty: true,
    };
    const editor = page('libraries:l', 'libraries', { libraryId: 'l' });
    const restored = validateWorkspace({
      version: 3,
      activeId: 'libraries',
      tabs: [page('browse', 'library', { libraryId: 'l' }), manager, editor],
    });
    expect(workspaceGroups(restored.tabs).map(group => [group.key, group.tabs.map(tab => tab.id)])).toEqual([
      ['tab:home', ['home']],
      ['library:l', ['browse', 'libraries:l']],
      ['tab:libraries', ['libraries']],
    ]);
    const kept = restored.tabs.find(tab => tab.id === 'libraries')!;
    expect(kept.title).toBe('管理影片库');
    expect(kept.state).toEqual(manager.state);
    expect(kept.dirty).toBe(true);
    expect(kept.params?.libraryId).toBe('l');
    expect(restored.activeId).toBe('libraries');
    const saved = reduce(restored, {
      type: 'update',
      id: 'libraries',
      change: { params: { libraryId: 'another' }, dirty: false },
    });
    expect(workspaceSourceKey(saved.tabs.find(tab => tab.id === 'libraries')!)).toBe('tab:libraries');
    expect(saved.tabs.filter(tab => workspaceSourceKey(tab) === 'library:l')).toHaveLength(2);
  });
  it('reuses an entity editor across entry points without overwriting unsaved edits', () => {
    const editor = { ...page('libraries:l', 'libraries', { libraryId: 'l' }), dirty: true, state: { name: 'draft' } };
    let workspace = reduce(initialWorkspace(), { type: 'open', tab: editor });
    workspace = reduce(workspace, { type: 'open', tab: page('libraries', 'libraries', { libraryId: 'l' }) });
    workspace = reduce(workspace, { type: 'open', tab: page('another-entry', 'libraries', { libraryId: 'l' }) });
    expect(ids(workspace)).toEqual(['home', 'libraries:l', 'libraries']);
    expect(workspace.activeId).toBe('libraries:l');
    expect(workspace.tabs[1]).toBe(editor);
  });
  it('inserts film pages in their built-in order even when playback opened first', () => {
    let workspace = reduce(initialWorkspace(), { type: 'open', tab: page('play-a', 'player', { filmId: 'a' }) });
    workspace = reduce(workspace, { type: 'open', tab: page('jobs', 'jobs') });
    workspace = reduce(workspace, { type: 'open', tab: page('info-a', 'film', { filmId: 'a' }) });
    expect(ids(workspace)).toEqual(['home', 'info-a', 'play-a', 'jobs']);
    expect(workspace.activeId).toBe('info-a');
    expect(workspaceGroups(workspace.tabs).map(group => group.tabs.length)).toEqual([1, 2, 1]);
    expect(reduce(workspace, { type: 'close', id: 'info-a' }).activeId).toBe('play-a');
  });
  it('restores old separated members without losing active playback, drafts or group order', () => {
    const draft = { ...page('info-a', 'film', { filmId: 'a' }), state: { title: '未保存', scroll: 320 }, dirty: true };
    const playback = { ...page('play-a', 'player', { filmId: 'a' }), state: { rate: 1.5, time: 86 } };
    const restored = validateWorkspace({
      version: 3,
      activeId: 'play-a',
      tabs: [initialWorkspace().tabs[0], playback, page('jobs', 'jobs'), draft],
    });
    expect(ids(restored)).toEqual(['home', 'info-a', 'play-a', 'jobs']);
    expect(restored.tabs[1]).toEqual(draft);
    expect(restored.tabs[2]).toEqual(playback);
    expect(restored.activeId).toBe('play-a');
  });
  it('groups playlists by their originating view rather than the first film', () => {
    const view = page('view', 'library', { viewId: 'v' });
    const editor = page('edit', 'views', { viewId: 'v' });
    const playlist = page('queue', 'player', { filmId: 'a', queue: ['a', 'b'], sourceKey: workspaceSourceKey(view) });
    const film = page('film-a', 'film', { filmId: 'a' });
    const standalonePlaylist = page('old-queue', 'player', { filmId: 'a', queue: ['a', 'b'] });
    expect(
      workspaceGroups([playlist, film, editor, standalonePlaylist, view]).map(group => group.tabs.map(tab => tab.id)),
    ).toEqual([['view', 'edit', 'queue'], ['film-a'], ['old-queue']]);
    expect(workspaceSourceKey({ ...playlist, params: { ...playlist.params, filmId: 'b' } })).toBe('view:v');
  });
  it('keeps library copies in stable order before editing and playback pages', () => {
    const source = page('library', 'library', { libraryId: 'l' });
    const copy = page('copy', 'library', { libraryId: 'l', sourceKey: workspaceSourceKey(source) });
    const editor = page('edit', 'libraries', { libraryId: 'l' });
    const playlist = page('queue', 'player', { queue: ['a'], sourceKey: workspaceSourceKey(source) });
    expect(workspaceGroups([editor, source, playlist, copy])[0].tabs.map(tab => tab.id)).toEqual([
      'library',
      'copy',
      'edit',
      'queue',
    ]);
  });
  it('moves an entire group past standalone tabs without recreating kept-alive state', () => {
    let workspace = initialWorkspace();
    const draft = { ...page('info', 'film', { filmId: 'a' }), state: { title: 'draft' }, dirty: true };
    const playback = { ...page('play', 'player', { filmId: 'a' }), state: { time: 32, rate: 2 } };
    for (const tab of [draft, playback, page('jobs', 'jobs'), page('settings', 'settings')])
      workspace = reduce(workspace, { type: 'open', tab });
    const moved = reduce(workspace, {
      type: 'moveGroup',
      sourceKey: 'film:a',
      targetKey: 'tab:settings',
      edge: 'after',
    });
    expect(ids(moved)).toEqual(['home', 'jobs', 'settings', 'info', 'play']);
    expect(moved.activeId).toBe(workspace.activeId);
    expect(moved.tabs[3]).toBe(draft);
    expect(moved.tabs[4]).toBe(playback);
    expect(validateWorkspace(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
    const independent = reduce(moved, {
      type: 'moveGroup',
      sourceKey: 'tab:jobs',
      targetKey: 'tab:home',
      edge: 'before',
    });
    expect(ids(independent)).toEqual(['jobs', 'home', 'settings', 'info', 'play']);
    expect(reduce(moved, { type: 'moveGroup', sourceKey: 'film:a', targetKey: 'film:a', edge: 'before' })).toBe(moved);
    expect(reduce(moved, { type: 'moveGroup', sourceKey: 'missing', targetKey: 'tab:home', edge: 'before' })).toBe(
      moved,
    );
  });
  it('retains source relationships when a new view is saved and receives its ID', () => {
    let workspace = reduce(initialWorkspace(), { type: 'open', tab: page('new-view', 'views') });
    workspace = reduce(workspace, { type: 'open', tab: page('preview', 'library', { sourceKey: 'tab:new-view' }) });
    workspace = reduce(workspace, { type: 'update', id: 'new-view', change: { params: { viewId: 'saved' } } });
    expect(workspaceGroups(workspace.tabs).map(group => [group.key, group.tabs.map(tab => tab.id)])).toEqual([
      ['tab:home', ['home']],
      ['view:saved', ['preview', 'new-view']],
    ]);
  });
});

describe('workspace async persistence', () => {
  it('merges async autosave acknowledgements with intervening view state changes', () => {
    let workspace = reduce(initialWorkspace(), {
      type: 'open',
      tab: { id: 'info', kind: 'film', title: 'Info', params: { filmId: 'a' }, state: {} },
    });
    workspace = reduce(workspace, {
      type: 'patchState',
      id: 'info',
      change: state => ({ ...state, annotationNotes: { point: 'new note' } }),
    });
    workspace = reduce(workspace, {
      type: 'patchState',
      id: 'info',
      change: state => ({ ...state, annotationEditors: { a: { pending: {} } } }),
      dirty: false,
    });
    expect(workspace.tabs.find(t => t.id === 'info')?.state).toMatchObject({
      annotationNotes: { point: 'new note' },
      annotationEditors: { a: { pending: {} } },
    });
  });
});
describe('media timeline and captions', () => {
  it('converts SRT timestamps, retains unicode text and accepts existing WebVTT', () => {
    const result = subtitleToVtt('\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\n字幕, test\r\n');
    expect(result).toBe('WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\n字幕, test\n');
    expect(subtitleToVtt(result)).toBe(result);
  });
  it('bounds seek targets and lays out point/range annotations against the full movie', () => {
    expect(clampTime(-1, 20)).toBe(0);
    expect(clampTime(Infinity, 20)).toBe(0);
    expect(clampTime(100, 20)).toBeCloseTo(19.999);
    expect(annotationPercent(5, 10, 20)).toEqual({ left: 25, width: 25 });
    expect(annotationPercent(5, undefined, 20).width).toBeGreaterThan(0);
  });
});
