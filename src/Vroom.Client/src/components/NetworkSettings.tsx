import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Input, Select, Space, Switch } from '../ui';
import { FormField, FormLayout } from './FormLayout';
import { call } from '../api';
import { action } from '../context';
import { t } from '../i18n';
import type { NetworkOptions } from '../types';

type Status = { state: 'unknown' | 'online' | 'offline'; checkedAt?: string; mode: string; revision: number };
export function NetworkSettings({
  value,
  change,
  apply,
  feedback,
}: {
  value: NetworkOptions;
  change: (value: NetworkOptions) => void;
  apply: (value: NetworkOptions) => void;
  feedback: ReactNode;
}) {
  const [status, setStatus] = useState<Status>(),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void call<Status>('network.status')
        .then(v => {
          if (alive) setStatus(v);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const check = () =>
    action(async () => {
      setChecking(true);
      try {
        setStatus(await call<Status>('network.check'));
      } finally {
        setChecking(false);
      }
    });
  return (
    <Card title={t('Network.title')}>
      <FormLayout>
        <FormField layout="row" label={t('Network.proxyUrl')} description={t('Network.proxyHelp')}>
          <Input
            aria-label={t('Network.proxyUrl')}
            value={value.proxyUrl}
            onChange={proxyUrl => change({ ...value, proxyUrl })}
            onBlur={e => apply({ ...value, proxyUrl: e.currentTarget.value.trim() })}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
            }}
          />
        </FormField>
        <FormField layout="row" label={t('Network.mode')}>
          <Select
            aria-label={t('Network.mode')}
            value={value.mode}
            onChange={mode => apply({ ...value, mode: String(mode) as NetworkOptions['mode'] })}
            optionList={[
              { value: 'system', label: t('Network.system') },
              { value: 'direct', label: t('Network.direct') },
              { value: 'custom', label: t('Network.custom') },
            ]}
          />
        </FormField>
        <FormField layout="row" label={t('Network.recovery')} description={t('Network.recoveryHelp')}>
          <Switch checked={value.retryOnReconnect} onChange={retryOnReconnect => apply({ ...value, retryOnReconnect })}>
            {t('Network.retryOnReconnect')}
          </Switch>
        </FormField>
        <FormField layout="row" label={t('Network.status')} description={t('Network.checkHelp')}>
          <Space>
            <span role="status">
              {t(
                status?.state === 'online'
                  ? 'Network.online'
                  : status?.state === 'offline'
                    ? 'Network.offline'
                    : 'Network.unknown',
              )}
            </span>
            <Button disabled={checking} onClick={check}>
              {t(checking ? 'Network.checking' : 'Network.check')}
            </Button>
          </Space>
        </FormField>
        {feedback}
      </FormLayout>
    </Card>
  );
}
