import { useEffect, useRef, useState } from 'react';
import registry from '../../../resources/tagging/playback-capabilities.json';
import { createScrubber } from './playback-scrubber';
import { notifyError } from './context';
import type { PlayerController } from './useNativePlayback';

export function usePlayerScrubbing(player: PlayerController, filmId: string, active: boolean) {
  const live = useRef(player);
  live.current = player;
  const [position, setPosition] = useState<number>(),
    [image, setImage] = useState<string>();
  const controller = useRef<ReturnType<typeof createScrubber> | undefined>(undefined);
  useEffect(() => {
    const scrubber = createScrubber(
      {
        isPlaying: () => !live.current.paused && !live.current.ended,
        pause: () => live.current.pause(),
        preview: (at, signal) => live.current.preview(at, signal),
        commit: (at, playing, signal) => live.current.commitPreview(at, playing, signal),
        resume: playing => live.current.setPlaying(playing),
        changed: (at, frame) => {
          setPosition(at);
          setImage(frame);
        },
        failed: error => {
          live.current.cancelPreview();
          notifyError(error);
        },
      },
      registry.playback.presentation.scrubIntervalMs,
    );
    controller.current = scrubber;
    return () => {
      scrubber.cancel();
      live.current.cancelPreview();
      controller.current = undefined;
    };
  }, [filmId]);
  useEffect(() => {
    if (!active || player.error) {
      controller.current?.cancel();
      live.current.cancelPreview();
    }
  }, [active, player.error]);
  return {
    position,
    image,
    preview: (at: number) => controller.current?.preview(at),
    commit: (at: number) => controller.current?.commit(at),
    cancel: () => {
      controller.current?.cancel();
      live.current.cancelPreview();
    },
  };
}
