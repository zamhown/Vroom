import { t as appText } from '../i18n';
import type { useApp } from '../context';

export function openTagSettings(app: ReturnType<typeof useApp>, selected: string) {
  const state = { catalogMode: 'definitions', kind: 'definition', selected, originTab: app.workspace.activeId };
  const existing = app.workspace.tabs.find(t => t.id === 'tags');
  if (existing) {
    app.patchState(existing.id, previous => ({ ...previous, ...state }));
    app.activate(existing.id);
  } else app.open({ id: 'tags', kind: 'tags', title: appText('workspace.tagConfiguration'), state });
}

export function openTermProfile(app: ReturnType<typeof useApp>, termId: string, vocabulary: string) {
  const state = {
    catalogMode: 'values',
    termSelected: termId,
    termVocabulary: vocabulary,
    originTab: app.workspace.activeId,
  };
  const existing = app.workspace.tabs.find(t => t.id === 'tags');
  if (existing) {
    app.patchState(existing.id, previous => ({ ...previous, ...state }));
    app.activate(existing.id);
  } else app.open({ id: 'tags', kind: 'tags', title: appText('workspace.tagConfiguration'), state });
}

export function openConfiguration(app: ReturnType<typeof useApp>, kind: string, selected = '') {
  const state = { catalogMode: 'configuration', kind, selected, search: '' };
  const existing = app.workspace.tabs.find(t => t.id === 'tags');
  if (existing) {
    app.patchState(existing.id, previous => ({ ...previous, ...state }));
    app.activate(existing.id);
  } else app.open({ id: 'tags', kind: 'tags', title: appText('workspace.tagConfiguration'), state });
}
