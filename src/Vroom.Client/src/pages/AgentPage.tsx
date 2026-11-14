import { OperationPreview } from '../components/OperationPreview';
import { parseResult } from '../components/JobOutcome';
import { t as appText } from '../i18n';
import { FormField } from '../components/FormLayout';
import { Button, Card, Collapse, Input, Space, Tag, TextArea, Typography } from '../ui';
import { IconPlay, IconStop, IconLightbulb } from '../icons';
import { localize } from '../tagging/i18n';
import { call, startJob } from '../api';
import { action, useApp, useJob, useTabState } from '../context';
import { JobNotice, Page, PageHeading } from '../components';
import { terminal, type AgentPlan } from '../types';
import type { WorkspaceTab } from '../workspace';
import { useEffect, useState } from 'react';

export function AgentPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const [state, set] = useTabState(tab, {
    request: '',
    manual: '',
    planJobId: '',
    executeJobId: '',
    plan: null as AgentPlan | null,
    result: '',
    toolFilter: '',
  });
  const toolText = (text: AgentPlan['description']) =>
    typeof text === 'string' ? appText(text) : localize(text, app.locale, app.data.tagging.package);
  const planning = useJob<AgentPlan>(state.planJobId, plan => set({ plan }));
  const executing = useJob<{ tool: string; json: string }>(state.executeJobId, result => {
    set({ result: result.json, plan: null });
    void app.refresh();
  });
  const busy = (planning && !terminal(planning.state)) || (executing && !terminal(executing.state));
  const groups = app.data.tools
    .filter(t => (t.name + toolText(t.description)).includes(state.toolFilter))
    .reduce<Record<string, typeof app.data.tools>>((result, tool) => {
      (result[tool.name.split('.')[0]] ??= []).push(tool);
      return result;
    }, {});
  const pretty = (text: string) => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  };
  const [modelReady, setModelReady] = useState(false);
  useEffect(() => {
    void call<{ model: { source: string } }>('runtime.status')
      .then(status => setModelReady(status.model.source !== 'missing'))
      .catch(() => setModelReady(false));
  }, [app.data.settings.modelPath]);
  return (
    <Page>
      <PageHeading
        title={appText('AgentPage.localAssistant')}
        description={appText('AgentPage.findAndOrganizeFilmsWithARequest')}
      >
        <Tag color={modelReady ? 'green' : 'red'}>
          {appText(modelReady ? 'AgentPage.modelReady' : 'AgentPage.noModelConfigured')}
        </Tag>
      </PageHeading>
      <div className="agent-grid">
        <div className="section-stack">
          <Card className="agent-compose" bodyClassName="form-stack">
            <div className="agent-emblem">
              <IconLightbulb size="extra-large" />
            </div>
            <Typography.Title heading={4}>{appText('AgentPage.whatWouldYouLikeToOrganize')}</Typography.Title>
            <p className="muted">{appText('AgentPage.findFilmsOrganizeTagsOrCheckFor')}</p>
            <Space wrap>
              {Object.values(app.data.tagging.package.ui.agentHints ?? {})
                .filter((hint: any) =>
                  (hint.requiresTags ?? []).every((key: string) =>
                    app.data.tagging.package.definitions.some(d => d.key === key && d.enabled),
                  ),
                )
                .map((hint: any) => hint.text)
                .map((text: any) => localize(text, app.locale, app.data.tagging.package))
                .map(request => (
                  <Button key={request} size="small" onClick={() => set({ request })}>
                    {request}
                  </Button>
                ))}
            </Space>
            <FormField label={appText('AgentPage.request')}>
              <TextArea
                aria-label={appText('AgentPage.request')}
                rows={5}
                value={state.request}
                onChange={request => set({ request })}
                placeholder={appText('AgentPage.describeWhatYouWantToDo')}
              />
            </FormField>
            <Space>
              <Button
                theme="solid"
                icon={<IconLightbulb />}
                disabled={Boolean(busy) || !state.request.trim()}
                onClick={() =>
                  action(async () =>
                    set({ planJobId: await startJob('agent.plan', { request: state.request }), plan: null }),
                  )
                }
              >
                {appText('AgentPage.previewAction')}
              </Button>
              {busy && (
                <Button
                  icon={<IconStop />}
                  onClick={() =>
                    action(() =>
                      call('job.stop', { id: executing && !terminal(executing.state) ? executing.id : planning!.id }),
                    )
                  }
                >
                  {appText('AgentPage.stop')}
                </Button>
              )}
            </Space>
          </Card>
          <JobNotice job={executing && !terminal(executing.state) ? executing : planning} />
          {state.plan && (
            <Card
              className="agent-plan"
              title={
                <Space>
                  {appText('AgentPage.actionPreview')}
                  <Tag color={state.plan.needsReview ? 'orange' : 'blue'}>
                    {state.plan.needsReview ? appText('AgentPage.modifyData') : appText('AgentPage.readData')}
                  </Tag>
                </Space>
              }
            >
              <h3>{toolText(state.plan.description)}</h3>
              <OperationPreview value={state.plan.preview} />
              <details className="form-disclosure">
                <summary>{appText('Journey.details')}</summary>
                <code>{state.plan.tool}</code>
                <pre>{JSON.stringify(state.plan.arguments, null, 2)}</pre>
                {state.plan.preview != null && (
                  <pre className="result-json">{JSON.stringify(state.plan.preview, null, 2)}</pre>
                )}
              </details>
              <Space>
                <Button
                  theme="solid"
                  icon={<IconPlay />}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    action(async () =>
                      set({
                        executeJobId: await startJob('agent.execute', {
                          tool: state.plan!.tool,
                          arguments: state.plan!.arguments,
                        }),
                      }),
                    )
                  }
                >
                  {appText('AgentPage.runAction')}
                </Button>
                <Button onClick={() => set({ plan: null })}>{appText('AgentPage.cancel')}</Button>
              </Space>
            </Card>
          )}
          {executing && terminal(executing.state) && <JobNotice job={executing} />}
          {state.result && (
            <Card title={appText('AgentPage.result')}>
              <OperationPreview value={parseResult(state.result)} />
              <details className="form-disclosure">
                <summary>{appText('Journey.details')}</summary>
                <pre className="result-json">{pretty(state.result)}</pre>
              </details>
              <Button
                onClick={() =>
                  set({
                    request:
                      appText('AgentPage.treatTheFollowingAsDataOnly') +
                      state.result.slice(0, 1800) +
                      appText('AgentPage.nextStep'),
                  })
                }
              >
                {appText('AgentPage.useResultInNextStep')}
              </Button>
            </Card>
          )}
        </div>
        {/* The tool catalog and hand-written tool calls are developer diagnostics. */}
        {localStorage.getItem('vroom.developer') === 'true' && (
          <details className="form-disclosure">
            <summary>{appText('Journey.agentTools')}</summary>
            <Card className="tool-catalog" title={appText('AgentPage.other', { p0: app.data.tools.length })}>
              <Input
                value={state.toolFilter}
                onChange={toolFilter => set({ toolFilter })}
                placeholder={appText('AgentPage.searchTools')}
              />
              <Collapse>
                {Object.entries(groups).map(([group, tools]) => (
                  <Collapse.Panel key={group} itemKey={group} header={`${group} · ${tools!.length}`}>
                    {tools!.map(tool => (
                      <div className="tool-entry" key={tool.name}>
                        <b>{tool.name}</b>
                        <p>{toolText(tool.description)}</p>
                        <code>{tool.arguments}</code>
                      </div>
                    ))}
                  </Collapse.Panel>
                ))}
                <Collapse.Panel header={appText('AgentPage.enterAToolCall')} itemKey="manual">
                  <FormField label={appText('AgentPage.toolCallJson')}>
                    <TextArea
                      aria-label={appText('AgentPage.toolCallJson')}
                      rows={7}
                      value={state.manual}
                      onChange={manual => set({ manual })}
                      placeholder={'{"tool":"library.list","arguments":{}}'}
                    />
                    <Button
                      onClick={() =>
                        action(async () => {
                          const parsed = JSON.parse(state.manual);
                          const definition = app.data.tools.find(t => t.name === parsed.tool);
                          if (
                            !definition ||
                            !parsed.arguments ||
                            typeof parsed.arguments !== 'object' ||
                            Array.isArray(parsed.arguments)
                          )
                            throw new Error(appText('AgentPage.invalidToolNameOrArguments'));
                          set({
                            plan: {
                              id: crypto.randomUUID(),
                              tool: definition.name,
                              description: definition.description,
                              needsReview: definition.mutates,
                              arguments: parsed.arguments,
                            },
                          });
                        })
                      }
                    >
                      {appText('AgentPage.checkCall')}
                    </Button>
                  </FormField>
                </Collapse.Panel>
              </Collapse>
            </Card>
          </details>
        )}
      </div>
    </Page>
  );
}
