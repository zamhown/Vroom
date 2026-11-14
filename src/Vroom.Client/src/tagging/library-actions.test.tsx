import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { TagPackage } from './types';
import { LibraryActions } from './LibraryActions';

const state = vi.hoisted(() => ({ pack: {} as TagPackage }));
vi.mock('../api', () => ({ call: vi.fn(), nativeComposition: false }));
vi.mock('../ui', () => ({
  Space: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: () => null,
  Modal: () => null,
}));
vi.mock('../components/FormLayout', () => ({ FormLayout: () => null, FormSection: () => null }));
vi.mock('../context', () => ({ useApp: () => ({ locale: 'en', data: { tagging: { package: state.pack } } }) }));
vi.mock('./Surface', () => ({
  SchemaAction: ({ label, disabled }: { label: string; disabled: boolean }) => (
    <button disabled={disabled}>{label}</button>
  ),
}));
vi.mock('./BulkDialog', () => ({ BulkDialog: () => null }));
vi.mock('./AutomationDialog', () => ({ AutomationDialog: () => null }));
vi.mock('../components/Ribbon', () => ({
  Ribbon: ({
    tabs,
    heading,
  }: {
    tabs: { id: string; label: string; groups: { id: string; content: ReactNode }[] }[];
    heading?: ReactNode;
  }) => (
    <section>
      {heading}
      {tabs.map(tab => (
        <div key={tab.id}>
          {tab.label}
          {tab.groups.map(group => (
            <div key={group.id}>{group.content}</div>
          ))}
        </div>
      ))}
    </section>
  ),
}));

beforeEach(() => {
  state.pack = {
    definitions: [],
    ui: {
      layouts: {
        'unfamiliar.workbench': {
          surface: 'library.actions',
          root: { id: 'custom', type: 'action-bar', actions: ['unfamiliar.fetch', 'unfamiliar.edit'] },
        },
      },
      surfaceBindings: { 'library.actions': 'unfamiliar.workbench' },
      actions: {
        'unfamiliar.fetch': { command: 'metadata.enrich', label: { en: 'Fetch supporting records' } },
        'unfamiliar.edit': { command: 'annotations.bulk', label: { en: 'Edit selected annotations' } },
      },
      identity: {},
      agentHints: {},
    },
    catalogPolicy: {},
    i18n: { defaultLocale: 'en', messages: {} },
  };
});

describe('collection action declarations', () => {
  const render = (disabled = false) =>
    renderToStaticMarkup(<LibraryActions query={{ offset: 0, limit: 60 }} disabled={disabled} queued={() => {}} />);
  it('uses unfamiliar declaration identities and allows resources to reorder and remove actions', () => {
    const original = render();
    expect(original.indexOf('Fetch supporting records')).toBeLessThan(original.indexOf('Edit selected annotations'));
    state.pack.ui.layouts['unfamiliar.workbench'].root.actions = ['unfamiliar.edit'];
    expect(render()).not.toContain('Fetch supporting records');
    expect(render()).toContain('Edit selected annotations');
    delete state.pack.ui.surfaceBindings['library.actions'];
    expect(render()).toBe('');
  });
  it('keeps configured actions visible but disabled for an empty or loading target', () => {
    expect(render(true)).toContain('disabled=""');
    expect(render(true)).toContain('Fetch supporting records');
  });
  it('renders resource-authored ribbon tasks, controls and actions with unfamiliar identities', () => {
    state.pack.ui.layouts['unfamiliar.workbench'].root = {
      id: 'workbench',
      type: 'ribbon',
      title: { en: 'Workbench' },
      children: [
        {
          id: 'research',
          type: 'ribbon-tab',
          title: { en: 'Research' },
          children: [
            {
              id: 'records',
              type: 'ribbon-group',
              title: { en: 'Supporting records' },
              children: [
                { id: 'lookup', type: 'control', binding: 'library.search' },
                { id: 'fetch', type: 'action-bar', actions: ['unfamiliar.fetch'] },
              ],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      <LibraryActions
        query={{ offset: 0, limit: 60 }}
        disabled={false}
        queued={() => {}}
        heading={<h1>Archive · 34</h1>}
        controls={{ 'library.search': <input aria-label="Find records" /> }}
      />,
    );
    expect(html).toContain('Archive · 34');
    expect(html).toContain('Research');
    expect(html.indexOf('Find records')).toBeLessThan(html.indexOf('Fetch supporting records'));
    expect(html).not.toContain('Edit selected annotations');
  });
  it('keeps the count heading when a user chooses an action-bar layout', () => {
    expect(
      renderToStaticMarkup(
        <LibraryActions
          query={{ offset: 0, limit: 60 }}
          disabled={false}
          queued={() => {}}
          heading={<h1>Archive · 34</h1>}
        />,
      ),
    ).toContain('Archive · 34');
  });
});
