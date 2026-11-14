import { t as appText } from '../i18n';
import { useState } from 'react';
import { Button, Card, Input, Modal, Space } from '../ui';
import { Page, PageHeading } from '../components';
import { FormField, FormLayout } from '../components/FormLayout';
import { QueryEditor, resolveQueryEditor, type QueryEditorState } from '../components/QueryEditor';
import { defaultOrderBy } from '../components/QueryBuilder';
import { action, useApp, useTabState } from '../context';
import { call } from '../api';
import { defaultQuery, type Query } from '../types';
import { workspaceSourceKey, type WorkspaceTab } from '../workspace';
export function ViewsPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp(),
    current = app.data.views.find(v => v.id === tab.params?.viewId);

  const [state, set] = useTabState(tab, {
    name: current?.name ?? '',
    query: current?.query ?? {
      ...defaultQuery(),
      orderBy: defaultOrderBy(app.data.tagging.package),
    },
    queryEditor: { mode: 'form' } as QueryEditorState,
  });
  const [count, setCount] = useState<number>(),
    [error, setError] = useState('');
  const resolved = resolveQueryEditor(state.query as Query, state.queryEditor, app.data.tagging.package.definitions),
    query = resolved.query;

  return (
    <Page>
      <PageHeading
        title={current?.name ?? appText('ViewsPage.smartLists')}
        meta={count != null ? appText('Journey.resultCount', { count }) : undefined}
      />
      <div className="management-grid">
        {!current && app.data.views.length > 0 && (
          <Card title={appText('ViewsPage.existingSmartLists')}>
            {app.data.views.map(view => (
              <Space key={view.id} className="view-row">
                <Button
                  onClick={() =>
                    app.open({
                      id: 'view:' + view.id,
                      kind: 'library',
                      title: view.name,
                      params: { viewId: view.id, query: view.query },
                    })
                  }
                >
                  {view.name}
                </Button>
                <Button
                  theme="borderless"
                  onClick={() =>
                    app.open({
                      id: 'view-edit:' + view.id,
                      kind: 'views',
                      title: view.name,
                      params: { viewId: view.id },
                    })
                  }
                >
                  {appText('ViewsPage.editSmartList')}
                </Button>
                <Button
                  theme="borderless"
                  onClick={() =>
                    Modal.confirm({
                      title: appText('ViewsPage.deleteConfirm', { name: view.name }),
                      content: appText('ViewsPage.deleteConsequence'),
                      okText: appText('ViewsPage.delete'),
                      onOk: async () => {
                        await call('view.delete', { id: view.id });
                        await app.refresh();
                      },
                    })
                  }
                >
                  {appText('ViewsPage.delete')}
                </Button>
              </Space>
            ))}
          </Card>
        )}
        <Card title={current ? appText('ViewsPage.editSmartList') : appText('ViewsPage.newSmartList')}>
          <FormLayout>
            <FormField layout="row" label={appText('Journey.name')}>
              <Input value={state.name} onChange={name => set({ name }, true)} />
            </FormField>
            <QueryEditor
              modelKey={tab.id}
              query={state.query as Query}
              editor={state.queryEditor}
              onChange={(query, queryEditor) => {
                set({ query, queryEditor }, true);
                setCount(undefined);
                setError('');
              }}
            />
            {error && <p role="alert">{error}</p>}
            <Space wrap>
              <Button
                disabled={!!resolved.error}
                onClick={() =>
                  action(async () => {
                    try {
                      const result = await call<{ total: number }>('films.query', { ...query, offset: 0, limit: 1 });
                      setCount(result.total);
                      setError('');
                    } catch (e) {
                      setError(String(e));
                    }
                  })
                }
              >
                {appText('Query.previewCount')}
              </Button>
              <Button
                theme="solid"
                disabled={!state.name.trim() || !!resolved.error}
                onClick={() =>
                  action(async () => {
                    const id = current?.id ?? crypto.randomUUID();
                    await call('view.save', { id, name: state.name.trim(), query });
                    set({}, false);
                    await app.refresh();
                    // The manager stays a list of lists; a newly saved list opens its own result tab.
                    if (!current) {
                      set({ name: '', query: { ...defaultQuery(), orderBy: [] } }, false);
                      app.open({
                        id: 'view:' + id,
                        kind: 'library',
                        title: state.name.trim(),
                        params: { viewId: id, query },
                      });
                    }
                  })
                }
              >
                {appText('ViewsPage.saveList')}
              </Button>
              <Button
                disabled={!!resolved.error}
                onClick={() => {
                  const id = current ? 'view:' + current.id : crypto.randomUUID();
                  app.open({
                    id,
                    kind: 'library',
                    title: state.name || appText('ViewsPage.listPreview'),
                    params: {
                      query,
                      viewId: current?.id,
                      sourceKey: workspaceSourceKey(tab),
                      sourceTitle: state.name || tab.title,
                    },
                  });
                  app.update(id, {
                    title: state.name || appText('ViewsPage.listPreview'),
                    params: {
                      query,
                      viewId: current?.id,
                      sourceKey: workspaceSourceKey(tab),
                      sourceTitle: state.name || tab.title,
                    },
                  });
                  app.patchState(id, s => ({
                    ...s,
                    ...query,
                    where: query.where ?? null,
                    search: query.search ?? '',
                    groupBy: query.groupBy ?? [],
                    queryDraft: undefined,
                    queryEditor: { mode: 'form' },
                    showAdvanced: false,
                    page: 1,
                  }));
                }}
              >
                {appText('ViewsPage.previewResults')}
              </Button>
            </Space>
          </FormLayout>
        </Card>
      </div>
    </Page>
  );
}
