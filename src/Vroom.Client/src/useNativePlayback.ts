import { useEffect, useRef, useState } from 'react';
import { call, sendOnExit } from './api';
import { notifyError } from './context';
import { t } from './i18n';
import type { FilmDetail, PlaybackSource } from './types';
import type { usePlayback } from './usePlayback';
import { dispatchNativeInput, type NativeInput } from './native-input';
import { playbackVolume, playbackDuration } from './playback-scrubber';

export type NativeValues = Record<string, string | number | boolean>;
export type NativeStatus = {
  'mpv-version'?: string;
  'time-pos'?: number;
  duration?: number;
  pause?: boolean;
  fullscreen?: boolean;
  seeking?: boolean;
  'eof-reached'?: boolean;
  'paused-for-cache'?: boolean;
  failure?: string;
  exited?: boolean;
  'track-list'?: {
    id: number;
    type: string;
    title?: string;
    lang?: string;
    codec?: string;
    selected?: boolean;
    external?: boolean;
  }[];
  'chapter-list'?: { title?: string; time: number }[];
  chapter?: number;
  aid?: number | string;
  sid?: number | string;
  'secondary-sid'?: number | string;
  vid?: number | string;
  'audio-device-list'?: { name: string; description: string }[];
  'audio-device'?: string;
  'hwdec-current'?: string;
  'estimated-vf-fps'?: number;
  'frame-drop-count'?: number;
  avsync?: number;
  'demuxer-cache-duration'?: number;
  'video-params'?: Record<string, unknown>;
  'audio-params'?: Record<string, unknown>;
};
export type PlaybackArguments = Parameters<typeof usePlayback>[0] & { nativeSettings?: NativeValues };
export type NativeController = {
  surface: React.RefObject<HTMLDivElement | null>;
  status: NativeStatus;
  sessionId?: string;
  embedded: boolean;
  command<T = unknown>(method: string, args?: Record<string, unknown>): Promise<T>;
  apply(values: NativeValues): Promise<void>;
};
export type PlayerController = ReturnType<typeof usePlayback> & { native?: NativeController };

export function useNativePlayback(args: PlaybackArguments): PlayerController {
  const surface = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const live = useRef(args);
  live.current = args;
  const session = useRef<string | undefined>(undefined),
    model = useRef<FilmDetail | undefined>(undefined),
    snapshot = useRef<NativeStatus>({});
  const [detail, setDetail] = useState<FilmDetail>(),
    [source, setSource] = useState<PlaybackSource>(),
    [status, setStatus] = useState<NativeStatus>({});
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [embedded, setEmbedded] = useState(false),
    [attempt, setAttempt] = useState(0);
  const binding = () => ({
    id: model.current?.film.id,
    partId: model.current?.film.partId,
    mediaRevision: model.current?.film.mediaRevision,
  });
  const applied = useRef('');
  const previewing = useRef(false);
  const stalls = useRef({ count: 0, milliseconds: 0, since: 0 });
  useEffect(() => {
    let click: ReturnType<typeof setTimeout> | undefined;
    const input = (event: Event) => {
      const value = (event as CustomEvent<NativeInput>).detail;
      if (value.sessionId !== session.current || !live.current.active || !surface.current || document.hidden) return;
      clearTimeout(click);
      const dispatch = () => {
        if (value.sessionId === session.current && live.current.active && surface.current)
          dispatchNativeInput(surface.current, value);
      };
      // mpv emits the first click before recognizing a double click. Keep playback unchanged on double click.
      if (value.kind === 'click') click = setTimeout(dispatch, 310);
      else dispatch();
    };
    window.addEventListener('native-playback-input', input);
    return () => {
      clearTimeout(click);
      window.removeEventListener('native-playback-input', input);
    };
  }, []);
  const signature = (values: NativeValues) =>
    JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
  const configuration = () => ({
    ...live.current.nativeSettings,
    speed: live.current.rate,
    volume: live.current.muted ? 0 : playbackVolume(live.current.volume, 2) * 100,
    'audio-pitch-correction': live.current.preservePitch ?? true,
  });
  const command = async <T = unknown>(method: string, values: Record<string, unknown> = {}): Promise<T> => {
    const id = session.current;
    if (!id) throw new Error(t('host.Mpv.sessionClosed'));
    return call<T>(`native.${method}`, { ...values, sessionId: id });
  };
  const emit = (type: string) => {
    const film = model.current?.film;
    if (film)
      sendOnExit('film.event', {
        id: film.id,
        partId: film.partId,
        type,
        position: snapshot.current['time-pos'] ?? 0,
        mediaRevision: film.mediaRevision,
        eventId: crypto.randomUUID(),
      });
  };
  const reload = async () => {
    const requested = model.current;
    if (!requested) return;
    const next = await call<FilmDetail>('film.get', { id: requested.film.id, partId: requested.film.partId });
    if (requested === model.current) {
      model.current = next;
      setDetail(next);
    }
  };
  useEffect(() => {
    let cancelled = false,
      owned: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      finished = false,
      previousPause = true,
      lastSave = Date.now();
    setLoading(true);
    setError('');
    setSource(undefined);
    setDetail(undefined);
    setStatus({});
    snapshot.current = {};
    previewing.current = false;
    stalls.current = { count: 0, milliseconds: 0, since: 0 };
    const poll = async () => {
      if (cancelled || !owned) return;
      try {
        const next = await call<NativeStatus>('native.status', { sessionId: owned });
        if (cancelled) return;
        snapshot.current = next;
        setStatus(next);
        if (next['paused-for-cache'] && !next.pause && !previewing.current) {
          if (!stalls.current.since) {
            stalls.current.since = performance.now();
            stalls.current.count++;
          }
        } else if (stalls.current.since) {
          stalls.current.milliseconds += performance.now() - stalls.current.since;
          stalls.current.since = 0;
        }
        if (next.failure || next.exited) {
          setError(t(next.failure || 'host.Mpv.disconnected'));
          return;
        }
        if (next.pause !== previousPause) {
          emit(next.pause ? 'playback.paused' : 'playback.started');
          previousPause = !!next.pause;
        }
        if (next['eof-reached'] && !finished && !previewing.current) {
          finished = true;
          sendOnExit('film.position', { ...binding(), position: 0, ended: true, eventId: crypto.randomUUID() });
          live.current.onEnded();
        }
        if (!next['eof-reached']) finished = false;
        if (Date.now() - lastSave > 10000) {
          lastSave = Date.now();
          sendOnExit('film.position', { ...binding(), position: finished ? 0 : (next['time-pos'] ?? 0) });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), live.current.active ? 250 : 2000);
    };
    void (async () => {
      const next = await call<FilmDetail>('film.get', { id: args.filmId, partId: args.partId });
      if (cancelled) return;
      model.current = next;
      setDetail(next);
      const values = configuration();
      const opened = await call<{ sessionId: string; embedded: boolean }>('native.open', {
        filmId: args.filmId,
        partId: next.film.partId,
        position: next.film.duration > 0 && next.film.position >= next.film.duration - 1 ? 0 : next.film.position,
        settings: values,
      });
      owned = opened.sessionId;
      if (cancelled) {
        await call('native.stop', { sessionId: owned });
        return;
      }
      session.current = owned;
      applied.current = signature(values);
      setEmbedded(opened.embedded);
      setSource({ sessionId: owned, pipeline: 'mpv', url: '', offset: 0, transcoded: false } as PlaybackSource);
      setLoading(false);
      await command('pause', { paused: !live.current.active });
      await poll();
    })().catch(e => {
      if (!cancelled) {
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    const close = () => {
      if (owned) {
        if (model.current)
          sendOnExit('film.position', { ...binding(), position: finished ? 0 : (snapshot.current['time-pos'] ?? 0) });
        sendOnExit('native.stop', { sessionId: owned });
      }
    };
    window.addEventListener('pagehide', close);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', close);
      if (session.current === owned) session.current = undefined;
      close();
    };
  }, [args.filmId, args.partId, attempt]);
  const key = signature(configuration());
  useEffect(() => {
    if (!source?.sessionId || applied.current === key) return;
    const timer = setTimeout(() => {
      const id = session.current;
      void call('native.settings', { sessionId: id, values: JSON.parse(key) })
        .then(() => {
          if (id === session.current) applied.current = key;
        })
        .catch(notifyError);
    }, 120);
    return () => clearTimeout(timer);
  }, [key, source?.sessionId]);
  useEffect(() => {
    if (!args.active && source?.sessionId) void command('pause', { paused: true }).catch(notifyError);
  }, [args.active, source?.sessionId]);
  useEffect(() => {
    if (source?.sessionId)
      void command('loop', {
        enabled: args.loopStart != null && args.loopEnd != null,
        start: args.loopStart ?? 0,
        end: args.loopEnd ?? 0,
      }).catch(notifyError);
  }, [source?.sessionId, args.loopStart, args.loopEnd]);
  useEffect(() => {
    const id = source?.sessionId;
    if (!id || !embedded || error || !args.active) return;
    let last = '',
      busy = false,
      closed = false;
    const update = async () => {
      if (closed || busy) return;
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      const bounds = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        scale: devicePixelRatio,
        visible: live.current.active && !document.hidden && rect.width > 0 && rect.height > 0,
      };
      const key = JSON.stringify(bounds);
      if (key === last) return;
      busy = true;
      try {
        await call('native.surface', { sessionId: id, bounds });
        last = key;
      } catch (e) {
        if (!closed) {
          setError(e instanceof Error ? e.message : String(e));
          void command('pause', { paused: true }).catch(() => {});
        }
      } finally {
        busy = false;
      }
    };
    const changed = () => void update();
    const observer = new ResizeObserver(changed);
    if (surface.current) observer.observe(surface.current);
    window.addEventListener('resize', changed);
    document.addEventListener('scroll', changed, true);
    document.addEventListener('visibilitychange', changed);
    const timer = setInterval(() => void update(), 100);
    void update();
    return () => {
      closed = true;
      observer.disconnect();
      clearInterval(timer);
      window.removeEventListener('resize', changed);
      document.removeEventListener('scroll', changed, true);
      document.removeEventListener('visibilitychange', changed);
      sendOnExit('native.surface', {
        sessionId: id,
        bounds: { left: 0, top: 0, width: 0, height: 0, scale: 1, visible: false },
      });
    };
  }, [source?.sessionId, embedded, args.active, error]);
  const seek = (position: number, autoplay?: boolean) => {
    void (async () => {
      await command('seek', { position: Math.max(0, position) });
      if (autoplay != null) await command('pause', { paused: !autoplay || !live.current.active });
      emit('playback.seeked');
    })().catch(notifyError);
  };
  return {
    video,
    detail,
    reload,
    source,
    duration: playbackDuration(status.duration, detail?.film.duration),
    position: status['time-pos'] ?? 0,
    paused: status.pause ?? true,
    loading,
    waiting: !!status['paused-for-cache'],
    error,
    ended: !!status['eof-reached'],
    buffered: [],
    metrics: {
      startupMs: null,
      stalls: stalls.current.count,
      stalledMs: stalls.current.milliseconds,
      bufferSeconds: status['demuxer-cache-duration'] ?? 0,
      droppedFrames: status['frame-drop-count'] ?? 0,
      totalFrames: null,
    },
    status: undefined,
    pause: async () => {
      previewing.current = true;
      await command('pause', { paused: true });
    },
    setPlaying: async (playing: boolean) => {
      previewing.current = false;
      await command('pause', { paused: !playing || !live.current.active });
    },
    cancelPreview: () => {
      previewing.current = false;
    },
    preview: async (position: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      await command('seek', { position: Math.max(0, position), precision: 'keyframe' });
      signal.throwIfAborted();
      return undefined;
    },
    commitPreview: async (position: number, playing: boolean, signal: AbortSignal) => {
      const id = session.current;
      signal.throwIfAborted();
      const at = Math.max(0, Math.min(position, (snapshot.current.duration || Infinity) - 0.001));
      await call('native.seek', { sessionId: id, position: at, precision: 'exact' });
      const deadline = performance.now() + 5000;
      while (true) {
        signal.throwIfAborted();
        if (session.current !== id) return;
        const next = await call<NativeStatus>('native.status', { sessionId: id });
        signal.throwIfAborted();
        if (session.current !== id) return;
        if (next.failure || next.exited) throw new Error(t(next.failure || 'host.Mpv.disconnected'));
        if (!next.seeking && Math.abs((next['time-pos'] ?? 0) - at) < 0.25) {
          snapshot.current = next;
          setStatus(next);
          break;
        }
        if (performance.now() > deadline) throw new Error(t('Player.frameTimeout'));
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      signal.throwIfAborted();
      previewing.current = false;
      await call('native.pause', { sessionId: id, paused: !playing || !live.current.active });
      emit('playback.seeked');
    },
    seek,
    toggle: () => {
      if (status['eof-reached']) seek(0, true);
      else void command('pause', { paused: !(snapshot.current.pause ?? true) }).catch(notifyError);
    },
    retry: async () => {
      try {
        await call('film.position', { ...binding(), position: snapshot.current['time-pos'] ?? 0 });
        setAttempt(n => n + 1);
      } catch (e) {
        notifyError(e);
      }
    },
    frame: direction => {
      void command('frame', { direction }).catch(notifyError);
    },
    native: {
      surface,
      status,
      sessionId: source?.sessionId,
      embedded,
      command,
      apply: async values => {
        await command('settings', { values });
        applied.current = signature({ ...configuration(), ...values });
      },
    },
  };
}
