import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApp, useTabState } from '../context';
import { Button, Spin } from '../ui';
import { t } from '../i18n';
import { useNativePlayback } from '../useNativePlayback';
import { usePlayback } from '../usePlayback';
import { PlayerPage } from './PlayerPage';
import type { WorkspaceTab } from '../workspace';
import { playbackEngine, type EngineChoice } from '../playback-engine';
export interface NativeCapabilities {
  available: boolean;
  embedded: boolean;
  engine: string;
}
export function EnginePlayerPage({ tab }: { tab: WorkspaceTab }) {
  const [caps, setCaps] = useState<NativeCapabilities>();
  const [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  const [state] = useTabState(tab, { engine: 'auto' });
  const [choice, setChoice] = useState<EngineChoice>();
  const runtime = useApp().data.settings.mpvPath;
  useEffect(() => {
    let stopped = false;
    void call<NativeCapabilities>('native.capabilities')
      .then(c => {
        if (!stopped) setCaps(c);
      })
      .catch(e => {
        if (!stopped) setError(String(e));
      });
    return () => {
      stopped = true;
    };
  }, [attempt, runtime]);
  if (!caps)
    return error ? (
      <div role="alert">
        {error}
        <Button
          onClick={() => {
            setError('');
            setAttempt(n => n + 1);
          }}
        >
          {t('PlayerPage.retry')}
        </Button>
      </div>
    ) : (
      <Spin />
    );
  const selected = playbackEngine(choice, state.engine, caps);
  if (selected !== choice) setChoice(selected);
  const native = selected.native;
  return (
    <PlayerPage
      key={native ? 'mpv' : 'browser'}
      tab={tab}
      capabilities={caps}
      useEngine={native ? useNativePlayback : usePlayback}
    />
  );
}
