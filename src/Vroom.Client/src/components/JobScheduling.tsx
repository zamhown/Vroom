import { useEffect, useState } from 'react';
import { Button, Card, InputNumber, Modal, Space, Switch } from '../ui';
import { FormField, FormLayout } from './FormLayout';
import { action, notifyError, useApp } from '../context';
import { call } from '../api';
import { localize } from '../tagging/i18n';
import type { LocalizedText } from '../tagging/types';
import type { Job, SchedulerPolicy } from '../types';
import { timecode } from '../types';
import contract from '../../../../resources/tagging/media-export.json';
function useWords() {
  const app = useApp();
  return (key: string) =>
    localize((contract.copy as Record<string, LocalizedText>)[key], app.locale, app.data.tagging.package);
}
export function SchedulerControls() {
  const t = useWords();
  const [policy, setPolicy] = useState<SchedulerPolicy>();
  useEffect(() => {
    call<SchedulerPolicy>('job.scheduler').then(setPolicy).catch(notifyError);
  }, []);
  return (
    <Card title={t('scheduler')}>
      {policy && (
        <FormLayout>
          <FormField layout="row" label={t('workers')}>
            <InputNumber
              aria-label={t('workers')}
              min={1}
              max={16}
              value={policy.maxWorkers}
              onChange={maxWorkers =>
                setPolicy({ ...policy, maxWorkers, maxEncoders: Math.min(policy.maxEncoders, maxWorkers) })
              }
            />
          </FormField>
          <FormField layout="row" label={t('encoders')}>
            <InputNumber
              aria-label={t('encoders')}
              min={1}
              max={policy.maxWorkers}
              value={policy.maxEncoders}
              onChange={maxEncoders => setPolicy({ ...policy, maxEncoders })}
            />
          </FormField>
          <FormField layout="row" label={t('queueState')} description={t('schedulerHint')}>
            <Switch checked={policy.paused} onChange={paused => setPolicy({ ...policy, paused })}>
              {t('queuePaused')}
            </Switch>
          </FormField>
          <Space className="form-actions" wrap>
            <Button onClick={() => action(async () => setPolicy(await call<SchedulerPolicy>('job.configure', policy)))}>
              {t('apply')}
            </Button>
          </Space>
        </FormLayout>
      )}
    </Card>
  );
}
export function JobScheduleEditor({ job }: { job: Job }) {
  const t = useWords();
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState(job.priority ?? 0);
  const [notBefore, setNotBefore] = useState('');
  if (!(['queued', 'paused'] as string[]).includes(job.state)) return null;
  const edit = () => {
    setPriority(job.priority ?? 0);
    const date = job.notBefore ? new Date(job.notBefore) : null;
    setNotBefore(date ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    setOpen(true);
  };
  return (
    <>
      <Button size="small" onClick={edit}>
        {t('scheduler')}
      </Button>
      <Modal
        mode="exclusive"
        title={t('scheduler')}
        visible={open}
        onCancel={() => setOpen(false)}
        onOk={() =>
          action(async () => {
            await call('job.schedule', {
              id: job.id,
              schedule: { priority, notBefore: notBefore ? new Date(notBefore).toISOString() : null },
            });
            setOpen(false);
          })
        }
      >
        <FormLayout>
          <FormField layout="row" label={t('priority')} description={t('queueHint')}>
            <InputNumber min={-10} max={10} value={priority} onChange={setPriority} aria-label={t('priority')} />
          </FormField>
          <FormField layout="row" label={t('scheduled')}>
            <input
              type="datetime-local"
              className="datetime-field"
              aria-label={t('scheduled')}
              value={notBefore}
              onChange={e => setNotBefore(e.target.value)}
            />
          </FormField>
        </FormLayout>
      </Modal>
    </>
  );
}
export function JobRuntimeInfo({ job }: { job: Job }) {
  const t = useWords();
  const info = job.telemetry;
  const { locale } = useApp();
  return (
    <small className="muted block">
      {job.workerClass} · {t('priority')} {job.priority ?? 0}
      {job.notBefore && ` · ${new Date(job.notBefore).toLocaleString(locale)}`}
      {info && (
        <>
          <br />
          {info.framesPerSecond != null &&
            `${info.framesPerSecond.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${t('fps')} · `}
          {info.etaSeconds != null && `${t('eta')} ${timecode(info.etaSeconds)} · `}
          {info.pass != null && `${t('pass')} ${info.pass}/${info.passCount ?? 1}`}
        </>
      )}
    </small>
  );
}
export function ExportLog({ job }: { job: Job }) {
  const t = useWords();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await call<{ text: string }>('export.log', { jobId: job.id });
        if (!disposed) setText(result.text);
      } catch (e) {
        if (!disposed) setText(String(e));
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(read, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [job.id, open]);
  return (
    <div className="form-stack">
      {job.state === 'completed' && (
        <Button onClick={() => action(() => call('export.reveal', { jobId: job.id }))}>{t('reveal')}</Button>
      )}
      <details className="form-disclosure" onToggle={e => setOpen(e.currentTarget.open)}>
        <summary>{t('log')}</summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}
