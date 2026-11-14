import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

export function PlayerFeedback({
  active,
  ready,
  paused,
  volume,
  muted,
  rate,
}: {
  active: boolean;
  ready: boolean;
  paused: boolean;
  volume: number;
  muted: boolean;
  rate: number;
}) {
  const previous = useRef({ active, ready, paused, volume, muted, rate });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const last = previous.current;
    previous.current = { active, ready, paused, volume, muted, rate };
    if (!active || !ready) {
      setMessage('');
      return;
    }
    if (!last.active || !last.ready) return;
    const next =
      last.volume !== volume || last.muted !== muted
        ? muted
          ? t('Player.muted')
          : t('Player.volume', { value: Math.round(volume * 100) })
        : last.rate !== rate
          ? rate + '×'
          : last.paused !== paused
            ? t(paused ? 'Player.paused' : 'Player.playing')
            : '';
    if (!next) return;
    setMessage(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(''), 1300);
  }, [active, ready, paused, volume, muted, rate]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="player-feedback" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
