import { useState } from 'react';
import { t as appText } from '../i18n';
import { Button, Modal, Select, Space, Input, InputNumber, Banner } from '../ui';
import { useApp, useJob, action } from '../context';
import { call } from '../api';
import { JobNotice } from '../components';
import { FormField, FormLayout } from '../components/FormLayout';
import { terminal, type Query } from '../types';
import type { Definition, TagPackage } from './types';
import { localize } from './i18n';
import { TagValue } from './Inputs';
import registry from '../../../../resources/tagging/host-capabilities.json';

function dependencies(value: any): string[] {
  return !value || typeof value !== 'object'
    ? []
    : [
        ...new Set([
          ...(typeof value.fact === 'string' ? [value.fact] : []),
          ...Object.values(value).flatMap(dependencies),
        ]),
      ];
}
function nest(values: Record<string, any>) {
  const result: any = {};
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split('.');
    let node = result;
    for (const part of keys.slice(0, -1)) node = node[part] ??= {};
    node[keys.at(-1)!] = value;
  }
  return result;
}
function get(value: any, path: string) {
  return path.split('.').reduce((v, k) => v?.[k], value);
}

export function AutomationDialog({
  definition,
  catalog,
  changes,
  query,
  subjectIds,
  close,
  queued,
}: {
  definition?: Definition;
  catalog?: TagPackage;
  changes?: any[];
  query?: Query;
  subjectIds?: string[];
  close(): void;
  queued?(jobId: string): void;
}) {
  const app = useApp(),
    pack = catalog ?? app.data.tagging.package;
  const [key, setKey] = useState(definition?.key ?? ''),
    [mode, setMode] = useState(changes ? 'sample' : 'films'),
    [facts, setFacts] = useState<Record<string, any>>({}),
    [units, setUnits] = useState<Record<string, number>>({}),
    [preview, setPreview] = useState<any>(),
    [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const job = useJob(jobId, () => {
    void app.refresh();
  });
  const fields = pack.definitions.filter(
    d => d.enabled && [...(d.initialization ?? []), ...(d.automation ?? [])].some(r => r.executor === 'value.match@1'),
  );
  const d = definition ?? fields.find(d => d.key === key),
    paths = dependencies([...(d?.initialization ?? []), ...(d?.automation ?? [])]).filter((p: string) =>
      Object.hasOwn(registry.facts, p),
    );
  const label = (v: any) => localize(v, app.locale, pack);
  const run = () => {
    setBusy(true);
    action(async () => {
      try {
        const args =
          mode === 'sample'
            ? { samples: [{ title: appText('Journey.sample'), facts: nest(facts) }] }
            : subjectIds
              ? { subjectIds }
              : { query: query ?? { limit: 1 } };
        setPreview(
          await call('automation.preview', {
            expectedGeneration: app.data.tagging.generation,
            tagKey: d?.key,
            ...(changes ? { changes } : {}),
            ...args,
          }),
        );
      } finally {
        setBusy(false);
      }
    });
  };
  return (
    <Modal
      mode="exclusive"
      visible
      width={960}
      title={appText(changes ? 'Journey.tryRules' : 'Journey.recalculate')}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close}>{appText('ManagementPages.close')}</Button>
          <Button disabled={!d || busy} onClick={run}>
            {appText('Journey.calculate')}
          </Button>
          {preview?.committable && (
            <Button
              theme="solid"
              disabled={!preview.changedCount || busy}
              onClick={() => {
                setBusy(true);
                action(async () => {
                  try {
                    const r = await call<{ jobId: string }>('automation.commit', {
                      previewToken: preview.previewToken,
                    });
                    queued?.(r.jobId);
                    close();
                  } finally {
                    setBusy(false);
                  }
                });
              }}
            >
              {appText('Journey.applyCount', { count: preview.changedCount })}
            </Button>
          )}
        </Space>
      }
    >
      <FormLayout>
        {!definition && (
          <FormField layout="row" label={appText('Journey.field')}>
            <Select
              value={key}
              optionList={fields.map(d => ({ value: d.key, label: label(d.label) }))}
              onChange={v => {
                setKey(String(v));
                setPreview(undefined);
              }}
            />
          </FormField>
        )}
        {!!changes && (
          <FormField layout="row" label={appText('Journey.testWith')}>
            <Select
              value={mode}
              optionList={['sample', 'films'].map(value => ({ value, label: appText('Journey.test.' + value) }))}
              onChange={v => {
                setMode(String(v));
                setPreview(undefined);
              }}
            />
          </FormField>
        )}
        {mode === 'sample' &&
          paths.map(path => {
            const meta = (registry.facts as any)[path],
              options = meta.unit?.choices ?? [];
            const factor = units[path] ?? options[0]?.factor ?? 1;
            return (
              <FormField key={path} layout="row" label={label(meta.label)}>
                <Space>
                  {['integer', 'number'].includes(meta.type) ? (
                    <InputNumber
                      value={facts[path] == null ? null : facts[path] / factor}
                      onChange={v => {
                        setFacts({ ...facts, [path]: Number.isFinite(v) ? v * factor : null });
                        setPreview(undefined);
                      }}
                    />
                  ) : (
                    <Input
                      value={facts[path] ?? ''}
                      onChange={v => {
                        setFacts({ ...facts, [path]: v || null });
                        setPreview(undefined);
                      }}
                    />
                  )}
                  {!!options.length && (
                    <Select
                      value={String(factor)}
                      optionList={options.map((u: any) => ({ value: String(u.factor), label: label(u.label) }))}
                      onChange={v => setUnits({ ...units, [path]: Number(v) })}
                    />
                  )}
                </Space>
              </FormField>
            );
          })}
        {preview && (
          <>
            <div className="automation-counts">
              {Object.entries(preview.counts).map(([key, count]) => (
                <span className="chip" key={key}>
                  {appText('Journey.outcome.' + key)} {String(count)}
                </span>
              ))}
            </div>
            {preview.counts.waiting > 0 && (
              <Banner
                description={
                  <Space wrap>
                    <span>{appText('Journey.waitForMedia')}</span>
                    {mode === 'films' && (
                      <Button
                        disabled={!!job && !terminal(job.state)}
                        onClick={() =>
                          action(async () => {
                            const r = await call<{ jobId?: string }>('automation.prepare', {
                              tagKey: d?.key,
                              ...(changes ? { changes } : {}),
                              ...(subjectIds ? { subjectIds } : { query: query ?? {} }),
                            });
                            if (r.jobId) setJobId(r.jobId);
                          })
                        }
                      >
                        {appText('Journey.probeNow')}
                      </Button>
                    )}
                  </Space>
                }
              />
            )}
            <JobNotice job={job} />
            <div className="automation-results">
              {preview.samples.map((row: any, i: number) => (
                <article key={row.id ?? i}>
                  <header>
                    <b>{row.title}</b>
                    <span>{appText('Journey.outcome.' + row.state)}</span>
                  </header>
                  <div className="automation-facts">
                    {paths.map(path => (
                      <span key={path}>
                        {label((registry.facts as any)[path].label)}{' '}
                        <b>{get(row.facts, path) == null ? '—' : String(get(row.facts, path))}</b>{' '}
                        {label((registry.facts as any)[path].unit?.choices?.[0]?.label)}
                      </span>
                    ))}
                  </div>
                  <Space wrap>
                    <span>
                      {row.caseId
                        ? appText('Journey.ruleHit', {
                            number:
                              [...(d?.initialization ?? []), ...(d?.automation ?? [])]
                                .flatMap(r => r.args?.cases ?? [])
                                .findIndex(c => c.id === row.caseId) + 1,
                          })
                        : appText('Journey.ruleNoMatch')}
                    </span>
                    {d && (
                      <>
                        <TagValue definition={d} value={row.before} catalog={pack} />
                        <span aria-hidden="true">→</span>
                        <TagValue definition={d} value={row.after} catalog={pack} />
                      </>
                    )}
                  </Space>
                  {row.matches > 1 && <p className="form-help">{appText('Journey.overlap', { count: row.matches })}</p>}
                </article>
              ))}
            </div>
          </>
        )}
      </FormLayout>
    </Modal>
  );
}
