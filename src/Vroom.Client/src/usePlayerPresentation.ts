import { useEffect, useRef, useState } from 'react';
import registry from '../../../resources/tagging/playback-capabilities.json';
import { notifyError } from './context';
import type { PlayerController } from './useNativePlayback';

export function usePlayerPresentation(player: PlayerController, active: boolean, owner: string, pinned: boolean) {
  const [fullscreen, setFullscreen] = useState(false),
    [focus, setFocus] = useState(false),
    [visible, setVisible] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  const latest = useRef({ player, active, fullscreen, focus, pinned });
  latest.current = { player, active, fullscreen, focus, pinned };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const keyboard = useRef(false);
  function reveal() {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const live = latest.current;
      // Portalled menus and keyboard focus must remain usable while watching.
      if (
        live.active &&
        !live.pinned &&
        !live.player.paused &&
        !live.player.loading &&
        !live.player.waiting &&
        !live.player.error &&
        !document.querySelector('[role=menu],[role=dialog]') &&
        !stage.current?.querySelector('.player-controls')?.matches(':hover') &&
        !(keyboard.current && stage.current?.querySelector('.player-controls')?.contains(document.activeElement))
      )
        setVisible(false);
    }, registry.playback.presentation.controlsIdleMs);
  }
  async function full(enabled = !latest.current.fullscreen) {
    if (enabled) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const native = latest.current.player.native;
    if (native) setFullscreen(await native.command<boolean>('fullscreen', { enabled }));
    else if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!enabled && document.fullscreenElement) await document.exitFullscreen();
    if (enabled) stage.current?.focus({ preventScroll: true });
    else returnFocus.current?.focus({ preventScroll: true });
    reveal();
  }
  useEffect(() => {
    const changed = () => {
      if (!latest.current.player.native) setFullscreen(!!document.fullscreenElement);
    };
    const nativeChanged = (event: Event) => {
      if (latest.current.active) setFullscreen((event as CustomEvent<boolean>).detail);
    };
    const pointer = () => {
      keyboard.current = false;
    };
    const key = () => {
      keyboard.current = true;
      reveal();
    };
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    document.addEventListener('fullscreenchange', changed);
    window.addEventListener('native-fullscreen', nativeChanged);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      window.removeEventListener('native-fullscreen', nativeChanged);
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  useEffect(() => {
    if (active && typeof player.native?.status.fullscreen === 'boolean') setFullscreen(player.native.status.fullscreen);
  }, [active, player.native?.status.fullscreen]);
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.playerOwner = owner;
    root.dataset.playerPresentation = fullscreen ? 'fullscreen' : focus ? 'focus' : 'workspace';
    return () => {
      if (root.dataset.playerOwner === owner) {
        delete root.dataset.playerPresentation;
        delete root.dataset.playerOwner;
      }
    };
  }, [active, owner, fullscreen, focus]);
  useEffect(() => {
    reveal();
    if (!active && latest.current.fullscreen) void full(false).catch(notifyError);
  }, [active, player.paused, player.loading, player.waiting, player.error, pinned]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (latest.current.fullscreen) {
        if (latest.current.player.native)
          void latest.current.player.native.command('fullscreen', { enabled: false }).catch(() => {});
        else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      }
    },
    [],
  );
  return {
    stage,
    fullscreen,
    focus,
    visible: visible || pinned || player.paused || !!player.error,
    reveal,
    full,
    toggleFocus: () => {
      setFocus(value => !value);
      reveal();
    },
    leaveFocus: () => setFocus(false),
  };
}
