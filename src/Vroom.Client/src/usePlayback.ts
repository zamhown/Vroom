import { reportError } from './diagnostics';
import { t as appText } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import workerUrl from 'hls.js/dist/hls.worker.js?url';
import { call, sendOnExit, waitJob } from './api';
import { clampTime } from './player-utils';
import { playbackDuration, playbackVolume } from './playback-scrubber';
import type { FilmDetail, PlaybackSource } from './types';

export interface PlaybackStatus {
  readyUntil: number;
  speed: number;
  finished: boolean;
  pipeline: string;
  error?: string;
}
export interface PlaybackMetrics {
  startupMs: number | null;
  stalls: number;
  stalledMs: number;
  bufferSeconds: number;
  droppedFrames: number;
  totalFrames: number | null;
}
export type PlaybackMode = 'auto' | 'direct' | 'compatible' | 'encode';
export function usePlayback({
  filmId,
  partId,
  active,
  mode,
  rate,
  volume,
  muted,
  loopStart,
  loopEnd,
  options,
  preservePitch = true,
  onEnded,
}: {
  filmId: string;
  partId?: string;
  active: boolean;
  mode: PlaybackMode;
  rate: number;
  volume: number;
  muted: boolean;
  options?: { audioStream: number | null; audioDelay: number; channels: string; deinterlace: boolean };
  preservePitch?: boolean;
  loopStart?: number;
  loopEnd?: number;
  onEnded(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [detail, setDetail] = useState<FilmDetail>();
  const [source, setSource] = useState<PlaybackSource>();
  const [position, setPosition] = useState(0);
  const [paused, setPaused] = useState(true);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [status, setStatus] = useState<PlaybackStatus>();
  const [mediaDuration, setMediaDuration] = useState(0);
  const [metrics, setMetrics] = useState<PlaybackMetrics>({
    startupMs: 0,
    stalls: 0,
    stalledMs: 0,
    bufferSeconds: 0,
    droppedFrames: 0,
    totalFrames: 0,
  });
  const live = useRef({
    filmId,
    partId,
    active,
    mode,
    rate,
    volume,
    muted,
    loopStart,
    loopEnd,
    options,
    preservePitch,
    onEnded,
  });
  live.current = {
    filmId,
    partId,
    active,
    mode,
    rate,
    volume,
    muted,
    loopStart,
    loopEnd,
    options,
    preservePitch,
    onEnded,
  };
  const model = useRef<FilmDetail | undefined>(undefined);
  const stream = useRef<PlaybackSource | undefined>(undefined);
  const hls = useRef<Hls | undefined>(undefined);
  const binding = () => ({
    id: model.current?.film.id,
    partId: model.current?.film.partId,
    mediaRevision: model.current?.film.mediaRevision,
  });
  const epoch = useRef(0);
  const pending = useRef('');
  const abort = useRef<AbortController | undefined>(undefined);
  const current = useRef(0);
  const ready = useRef<PlaybackStatus | undefined>(undefined);
  const playWanted = useRef(true);
  const started = useRef(0);
  const hasPlayed = useRef(false);
  const previewing = useRef(false);
  const metricsRef = useRef(metrics);
  const stallStart = useRef(0);
  const finished = useRef(false);
  const didFallback = useRef(false);
  const stop = async (old?: PlaybackSource) => {
    if (old?.sessionId) await call('playback.stop', { sessionId: old.sessionId });
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
  async function open(at: number, transcode: boolean, autoplay = true, forceEncode = false) {
    const token = ++epoch.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const job = pending.current;
    pending.current = '';
    if (job) void call('job.stop', { id: job }).catch(() => {});
    playWanted.current = autoplay;
    video.current?.pause();
    hls.current?.destroy();
    hls.current = undefined;
    setLoading(true);
    setWaiting(false);
    setError('');
    setEnded(false);
    setBuffered([]);
    setStatus(undefined);
    ready.current = undefined;
    finished.current = false;
    hasPlayed.current = false;
    stallStart.current = 0;
    started.current = performance.now();
    metricsRef.current = { startupMs: 0, stalls: 0, stalledMs: 0, bufferSeconds: 0, droppedFrames: 0, totalFrames: 0 };
    setMetrics(metricsRef.current);
    const old = stream.current;
    stream.current = undefined;
    setSource(undefined);
    try {
      await stop(old);
      if (token !== epoch.current) return;
      const response = await call<PlaybackSource | { jobId: string }>('playback.open', {
        ...binding(),
        transcode,
        start: at,
        forceEncode,
        options: live.current.options,
      });
      if (token !== epoch.current) {
        if ('url' in response) await stop(response);
        if (response.jobId) void call('job.stop', { id: response.jobId }).catch(() => {});
        return;
      }
      let next: PlaybackSource;
      if ('url' in response) next = response;
      else {
        pending.current = response.jobId;
        next = await waitJob<PlaybackSource>(response.jobId, true, controller.signal);
      }
      if (token !== epoch.current) {
        await stop(next);
        return;
      }
      pending.current = '';
      stream.current = next;
      setSource(next);
      current.current = at;
      setPosition(at);
      const el = video.current;
      if (!el) {
        await stop(next);
        return;
      }
      const offset = next.transcoded ? next.offset : 0;
      const initialPosition = Math.max(0, at - offset);
      el.preservesPitch = live.current.preservePitch;
      el.playbackRate = live.current.rate;
      el.volume = playbackVolume(live.current.volume);
      el.muted = live.current.muted;
      const loaded = () => {
        if (token !== epoch.current) return;
        if (Math.abs(el.currentTime - initialPosition) > 0.1) el.currentTime = initialPosition;
        setLoading(false);
        if (playWanted.current && live.current.active)
          void el.play().catch(() => {
            setPaused(true);
            setLoading(false);
          });
      };
      el.addEventListener('loadedmetadata', loaded, { once: true, signal: controller.signal });
      if (next.transcoded) {
        const { default: HlsEngine } = await import('hls.js');
        if (token !== epoch.current) return;
        if (HlsEngine.isSupported()) {
          const engine = new HlsEngine({
            enableWorker: true,
            workerPath: workerUrl,
            lowLatencyMode: false,
            startPosition: initialPosition,
            maxBufferLength: 90,
            maxMaxBufferLength: 180,
            backBufferLength: 120,
            maxBufferSize: 128 * 1024 * 1024,
            // Local files are VOD. Never chase the growing EVENT playlist's live edge.
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: Infinity,
            maxBufferHole: 0.3,
            nudgeMaxRetry: 5,
          });
          hls.current = engine;
          let networkRetries = 0;
          let mediaRetries = 0;
          engine.on(HlsEngine.Events.ERROR, (_, data) => {
            if (token !== epoch.current || !data.fatal) return;
            if (data.type === HlsEngine.ErrorTypes.NETWORK_ERROR && networkRetries++ < 2) {
              engine.startLoad(el.currentTime);
              return;
            }
            if (data.type === HlsEngine.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 1) {
              engine.recoverMediaError();
              return;
            }
            if (next.pipeline === 'copy' && !forceEncode) {
              void openRef.current(current.current, true, true, true);
              return;
            }
            setLoading(false);
            setWaiting(false);
            setError(appText('usePlayback.playbackCannotContinueRetryOrChooseRe'));
          });
          engine.loadSource(next.url);
          engine.attachMedia(el);
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = next.url;
          el.load();
        } else throw new Error(appText('usePlayback.thisDeviceCannotPlayThisVideoStream'));
      } else {
        el.src = next.url;
        el.load();
      }
    } catch (e) {
      if (token === epoch.current && !controller.signal.aborted) {
        reportError(e, 'playback.open');
        setLoading(false);
        setWaiting(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }
  const openRef = useRef(open);
  openRef.current = open;
  async function seekTo(at: number, autoplay = !video.current?.paused) {
    const el = video.current;
    const source = stream.current;
    if (!el || !source) return;
    const target = clampTime(
      at,
      source.transcoded
        ? model.current?.film.duration || 0
        : playbackDuration(el.duration, model.current?.film.duration),
    );
    const local = target - (source.transcoded ? source.offset : 0);
    finished.current = false;
    setEnded(false);
    current.current = target;
    setPosition(target);
    playWanted.current = autoplay;
    const ranges = el.seekable;
    const canSeek =
      !source.transcoded ||
      (local >= 0 &&
        ((ready.current && target < ready.current.readyUntil - 0.05) ||
          Array.from(
            { length: ranges.length },
            (_, i) => local >= ranges.start(i) && local <= ranges.end(i) - 0.05,
          ).some(Boolean)));
    if (canSeek) {
      el.currentTime = Math.max(0, local);
      if (autoplay && live.current.active) void el.play().catch(() => {});
      else el.pause();
    } else await openRef.current(target, true, autoplay, live.current.mode === 'encode');
  }
  const seek = (at: number, autoplay?: boolean) => {
    void seekTo(at, autoplay).catch(e => setError(String(e)));
  };
  async function frameReady(signal: AbortSignal, at: number) {
    const deadline = performance.now() + 15000;
    while (true) {
      signal.throwIfAborted();
      const el = video.current;
      if (
        el &&
        !el.seeking &&
        el.readyState >= 2 &&
        stream.current &&
        Math.abs(el.currentTime + (stream.current.transcoded ? stream.current.offset : 0) - at) < 0.25
      )
        return;
      if (performance.now() > deadline) throw new Error(appText('Player.frameTimeout'));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (finished.current) {
      seekRef.current(0, true);
      return;
    }
    if (el.paused) {
      playWanted.current = true;
      void el.play().catch(() => setError(appText('usePlayback.retryToReopenTheVideo')));
    } else {
      playWanted.current = false;
      el.pause();
    }
  };
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const finish = () => {
      if (finished.current || !stream.current || previewing.current) return;
      finished.current = true;
      setEnded(true);
      el.pause();
      current.current = model.current?.film.duration || current.current;
      setPosition(current.current);
      void call('film.position', { ...binding(), position: 0, ended: true });
      live.current.onEnded();
    };
    const update = () => {
      if (!stream.current) return;
      setMediaDuration(
        stream.current.transcoded
          ? playbackDuration(
              model.current?.film.duration,
              ready.current?.finished ? el.duration + stream.current.offset : 0,
            )
          : playbackDuration(el.duration, model.current?.film.duration),
      );
      const at = el.currentTime + (stream.current.transcoded ? stream.current.offset : 0);
      current.current = at;
      if (live.current.loopStart != null && live.current.loopEnd != null && at >= live.current.loopEnd && !el.paused) {
        seekRef.current(live.current.loopStart, true);
        return;
      }
      if (!finished.current) setPosition(at);
      const ranges = Array.from(
        { length: el.buffered.length },
        (_, i) =>
          [
            el.buffered.start(i) + (stream.current!.transcoded ? stream.current!.offset : 0),
            el.buffered.end(i) + (stream.current!.transcoded ? stream.current!.offset : 0),
          ] as [number, number],
      );
      setBuffered(ranges);
      const end = ranges.find(([a, b]) => a <= at + 0.1 && b >= at)?.[1] ?? at;
      const quality = el.getVideoPlaybackQuality?.();
      metricsRef.current = {
        ...metricsRef.current,
        bufferSeconds: Math.max(0, end - at),
        droppedFrames: quality?.droppedVideoFrames || 0,
        totalFrames: quality?.totalVideoFrames || 0,
      };
      setMetrics(metricsRef.current);
    };
    const playing = () => {
      setLoading(false);
      setWaiting(false);
      setPaused(false);
      if (!hasPlayed.current) {
        hasPlayed.current = true;
        if (!metricsRef.current.startupMs) metricsRef.current.startupMs = performance.now() - started.current;
      }
      if (stallStart.current) {
        metricsRef.current.stalledMs += performance.now() - stallStart.current;
        stallStart.current = 0;
      }
      update();
    };
    const wait = () => {
      if (finished.current || el.paused) return;
      const duration = model.current?.film.duration ?? 0;
      if (
        ready.current?.finished &&
        duration - current.current <= 0.3 &&
        duration > 0 &&
        live.current.loopEnd == null
      ) {
        finish();
        return;
      }
      setWaiting(true);
      if (hasPlayed.current && !el.seeking && !stallStart.current) {
        stallStart.current = performance.now();
        metricsRef.current.stalls++;
      }
    };
    const pause = () => {
      setPaused(true);
      setWaiting(false);
      if (stallStart.current) {
        metricsRef.current.stalledMs += performance.now() - stallStart.current;
        stallStart.current = 0;
      }
    };
    const fail = () => {
      if (!stream.current || hls.current) return;
      if (live.current.mode === 'auto' && !didFallback.current) {
        didFallback.current = true;
        void openRef.current(current.current, true);
      } else {
        setLoading(false);
        setWaiting(false);
        setError(appText('usePlayback.thisFormatCannotPlayDirectlySwitchTo'));
      }
    };
    const firstFrame = () => {
      if (!metricsRef.current.startupMs) {
        metricsRef.current.startupMs = performance.now() - started.current;
        setMetrics({ ...metricsRef.current });
      }
    };
    const emitPlayback = (type: string) => {
      const media = model.current?.film;
      if (!previewing.current && media?.id === live.current.filmId && stream.current)
        sendOnExit('film.event', {
          id: media.id,
          partId: media.partId,
          mediaRevision: media.mediaRevision,
          type,
          position: current.current,
          eventId: crypto.randomUUID(),
        });
    };
    const playEvent = () => emitPlayback('playback.started');
    const pauseEvent = () => emitPlayback('playback.paused');
    const seekEvent = () => emitPlayback('playback.seeked');
    el.addEventListener('play', playEvent);
    el.addEventListener('pause', pauseEvent);
    el.addEventListener('seeked', seekEvent);
    el.addEventListener('loadeddata', firstFrame);
    el.addEventListener('durationchange', update);
    el.addEventListener('timeupdate', update);
    el.addEventListener('progress', update);
    el.addEventListener('playing', playing);
    el.addEventListener('waiting', wait);
    el.addEventListener('pause', pause);
    el.addEventListener('ended', finish);
    el.addEventListener('error', fail);
    let statusBusy = false;
    const heartbeat = setInterval(async () => {
      const existing = stream.current;
      if (!existing?.sessionId || statusBusy) return;
      statusBusy = true;
      try {
        const next = await call<PlaybackStatus>('playback.status', { sessionId: existing.sessionId });
        if (stream.current !== existing) return;
        ready.current = next;
        setStatus(next);
        update();
        if (next.error) {
          setError(appText('usePlayback.playbackProcessingFailed') + appText(next.error));
          setWaiting(false);
        }
        const duration = playbackDuration(
          model.current?.film.duration,
          next.finished ? el.duration + existing.offset : 0,
        );
        if (
          next.finished &&
          !el.paused &&
          el.readyState < 3 &&
          duration > 0 &&
          duration - current.current < 0.3 &&
          live.current.loopEnd == null
        )
          finish();
      } catch {
        /* Retry next heartbeat. Playback already has its own network error handling. */
      } finally {
        statusBusy = false;
      }
    }, 2000);
    const persist = () => {
      if (model.current?.film.id === live.current.filmId && !finished.current)
        sendOnExit('film.position', { ...binding(), position: current.current });
    };
    const save = setInterval(persist, 10000);
    const pagehide = () => {
      persist();
      if (pending.current) sendOnExit('job.stop', { id: pending.current });
      if (stream.current?.sessionId) sendOnExit('playback.stop', { sessionId: stream.current.sessionId });
    };
    window.addEventListener('pagehide', pagehide);
    return () => {
      persist();
      ++epoch.current;
      abort.current?.abort();
      clearInterval(heartbeat);
      clearInterval(save);
      window.removeEventListener('pagehide', pagehide);
      el.pause();
      hls.current?.destroy();
      hls.current = undefined;
      el.removeAttribute('src');
      el.load();
      el.removeEventListener('play', playEvent);
      el.removeEventListener('pause', pauseEvent);
      el.removeEventListener('seeked', seekEvent);
      el.removeEventListener('loadeddata', firstFrame);
      for (const [event, listener] of [
        ['durationchange', update],
        ['timeupdate', update],
        ['progress', update],
        ['playing', playing],
        ['waiting', wait],
        ['pause', pause],
        ['ended', finish],
        ['error', fail],
      ] as const)
        el.removeEventListener(event, listener);
      if (pending.current) void call('job.stop', { id: pending.current }).catch(() => {});
      void stop(stream.current).catch(() => {});
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    didFallback.current = false;
    const old = model.current;
    if (old && !finished.current)
      void call('film.position', {
        id: old.film.id,
        partId: old.film.partId,
        mediaRevision: old.film.mediaRevision,
        position: current.current,
      });
    video.current?.pause();
    model.current = undefined;
    setLoading(true);
    setDetail(undefined);
    setMediaDuration(0);
    previewing.current = false;
    void call<FilmDetail>('film.get', { id: filmId, partId })
      .then(next => {
        if (cancelled) return;
        model.current = next;
        setDetail(next);
        const ext = next.film.path.split('.').pop()?.toLowerCase();
        const selected = live.current.mode;
        const compatible =
          selected === 'compatible' ||
          selected === 'encode' ||
          (selected === 'auto' && !['mp4', 'm4v', 'webm', 'mov'].includes(ext || ''));
        void openRef.current(
          next.film.duration > 0 && next.film.position > next.film.duration - 1 ? 0 : next.film.position,
          compatible,
          true,
          selected === 'encode',
        );
      })
      .catch(e => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      ++epoch.current;
      abort.current?.abort();
    };
  }, [filmId, partId]);
  const configuration = JSON.stringify({ mode, options });
  const priorMode = useRef(configuration);
  useEffect(() => {
    if (priorMode.current === configuration) return;
    const timer = setTimeout(() => {
      priorMode.current = configuration;
      if (model.current?.film.id === filmId)
        void openRef.current(
          current.current,
          mode === 'compatible' || mode === 'encode',
          stream.current ? !video.current?.paused : playWanted.current,
          mode === 'encode',
        );
    }, 350);
    return () => clearTimeout(timer);
  }, [configuration, filmId]);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  useEffect(() => {
    if (video.current) {
      video.current.preservesPitch = preservePitch;
      video.current.playbackRate = rate;
      video.current.volume = playbackVolume(volume);
      video.current.muted = muted;
    }
  }, [rate, volume, muted, preservePitch]);
  return {
    video,
    detail,
    reload,
    source,
    duration: playbackDuration(mediaDuration, detail?.film.duration),
    position,
    paused,
    loading,
    waiting,
    error,
    ended,
    buffered,
    metrics,
    status,
    seek,
    toggle,
    pause: async () => {
      previewing.current = true;
      playWanted.current = false;
      video.current?.pause();
    },
    setPlaying: async (playing: boolean) => {
      previewing.current = false;
      playWanted.current = playing && live.current.active;
      if (playWanted.current) await video.current?.play();
      else video.current?.pause();
    },
    cancelPreview: () => {
      previewing.current = false;
    },
    preview: async (at: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (stream.current?.transcoded) {
        const film = model.current!.film;
        const frame = await call<string>('playback.preview', {
          id: film.id,
          partId: film.partId,
          mediaRevision: film.mediaRevision,
          position: clampTime(at, film.duration),
        });
        signal.throwIfAborted();
        return frame;
      }
      const target = clampTime(at, playbackDuration(video.current?.duration, model.current?.film.duration));
      await seekTo(target, false);
      await frameReady(signal, target);
      return undefined;
    },
    commitPreview: async (at: number, playing: boolean, signal: AbortSignal) => {
      signal.throwIfAborted();
      const target = clampTime(at, playbackDuration(mediaDuration, model.current?.film.duration));
      await seekTo(target, false);
      await frameReady(signal, target);
      signal.throwIfAborted();
      const media = model.current?.film;
      if (media)
        sendOnExit('film.event', {
          id: media.id,
          mediaRevision: media.mediaRevision,
          type: 'playback.seeked',
          position: target,
          eventId: crypto.randomUUID(),
        });
      if (playing && live.current.active) {
        playWanted.current = true;
        await video.current?.play();
      }
    },
    retry: () => openRef.current(current.current, mode !== 'direct', true, mode === 'encode'),
    frame: (direction: number) => {
      video.current?.pause();
      seekRef.current(current.current + direction / (model.current?.film.frameRate || 30), false);
    },
  };
}
