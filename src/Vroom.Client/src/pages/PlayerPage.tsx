import { JumpTimeDialog, ShortcutHelpDialog, SnapshotDialog } from '../player/PlayerDialogs';
import { playbackAdvance } from '../playback-sequence';
import { SubtitleSearchDialog } from '../OnlineSubtitles';
import { ExternalPlayerDialog } from '../ExternalPlayerDialog';
import type { MediaStructure } from '../MediaResources';
import { NativePlaybackSettings, EnginePicker } from '../NativePlaybackSettings';
import { usePlayerPresentation } from '../usePlayerPresentation';
import { usePlayerScrubbing } from '../usePlayerScrubbing';
import { PlayerFeedback } from '../PlayerFeedback';
import { playbackVolume } from '../playback-scrubber';
import registry from '../../../../resources/tagging/playback-capabilities.json';
import type { NativeCapabilities } from './EnginePlayerPage';
import type { PlaybackArguments, PlayerController, NativeValues } from '../useNativePlayback';
import { openContextMenu } from '../ContextMenu';
import { PlaybackSettings, playbackDefaults, type PlaybackInfo } from '../PlaybackSettings';
import type { CSSProperties } from 'react';
import { t as appText } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { useEffect, useRef, useState } from 'react';
import {
  Provider,
  Slider,
  ActionMenu,
  MenuItem,
  Text,
  FileTrigger,
  ActionButton,
  SegmentedControl,
  SegmentedControlItem,
} from '@react-spectrum/s2';
import { Button, Modal, Select, Space, Spin } from '../ui';
import {
  IconPlay,
  IconPause,
  IconChevronRight,
  IconCamera,
  IconList,
  IconTag,
  IconInfo,
  IconVolume,
  IconMuted,
  IconFullscreen,
  IconCaptions,
  IconSkipBack,
  IconSkipForward,
} from '../icons';
import { call, nativeComposition } from '../api';
import { action, notifyError, useApp, useTabState } from '../context';
import { annotationPercent, shiftedSubtitle, subtitleToVtt, parseTimecode } from '../player-utils';
import { usePlayback, type PlaybackMode } from '../usePlayback';
import { timecode, type FilmDetail } from '../types';
import { Surface, Slot } from '../tagging/Surface';
import { localize } from '../tagging/i18n';
import type { WorkspaceTab } from '../workspace';
function PipIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}
export function PlayerPage({
  tab,
  capabilities,
  useEngine = usePlayback,
}: {
  tab: WorkspaceTab;
  capabilities?: NativeCapabilities;
  useEngine?: (args: PlaybackArguments) => PlayerController;
}) {
  const app = useApp();
  const inspectorTitle =
    localize(
      app.data.tagging.package.ui.layouts[app.data.tagging.package.ui.surfaceBindings['player.inspector']]?.title,
      app.locale,
      app.data.tagging.package,
    ) || appText('PlayerPage.annotations');
  const active = app.workspace.activeId === tab.id;
  const [state, set] = useTabState(tab, {
    ...playbackDefaults,
    engine: 'auto',
    partFilm: '',
    partId: undefined as string | undefined,
    nativeSettings: {} as NativeValues,
    index: 0,
    mode: 'auto',
    rate: 1,
    volume: 0.8,
    muted: false,
    tagName: '',
    inPoint: 0,
    outPoint: null as number | null,
    note: '',
    loop: false,
    sidebar: '',
    queuePage: 1,
    subtitleText: '',
    subtitleName: '',
    captions: true,
    seekRequest: null as { filmId: string; partId?: string; seconds: number } | null,
  });
  const queue = tab.params?.queue?.length ? tab.params.queue : [tab.params!.filmId!];
  const filmId = queue[state.index] ?? queue[0];
  const partId =
    state.partFilm === filmId ? state.partId : tab.params?.filmId === filmId ? tab.params.partId : undefined;
  const [structure, setStructure] = useState<MediaStructure>();
  useEffect(() => {
    let cancelled = false;
    setStructure(undefined);
    void call<MediaStructure>('media.resources.get', { filmId })
      .then(value => {
        if (!cancelled) setStructure(value);
      })
      .catch(notifyError);
    return () => {
      cancelled = true;
    };
  }, [filmId, app.filmRevision(filmId)]);
  const selectPart = (id: string) =>
    set({
      partFilm: filmId,
      partId: id,
      inPoint: 0,
      outPoint: null,
      loop: false,
      subtitleText: '',
      subtitleName: '',
      audioFilm: '',
      audioStream: -1,
    });
  const mode: PlaybackMode = ['auto', 'direct', 'compatible', 'encode'].includes(state.mode)
    ? (state.mode as PlaybackMode)
    : 'compatible';
  const player = useEngine({
    nativeSettings: state.nativeSettings,
    filmId,
    partId,
    active,
    mode,
    rate: state.rate,
    volume: state.volume,
    muted: state.muted,
    preservePitch: state.preservePitch,
    options: {
      audioStream: state.audioFilm === filmId && state.audioStream >= 0 ? state.audioStream : null,
      audioDelay: state.audioDelay,
      channels: state.channels,
      deinterlace: state.deinterlace,
    },
    loopStart: state.loop ? state.inPoint : undefined,
    loopEnd: state.loop ? (state.outPoint ?? undefined) : undefined,
    onEnded: () => {
      const current = player.detail?.film.partId;
      const parts = structure?.versions.find(v => v.parts.some(p => p.id === current))?.parts;
      const next = playbackAdvance(parts, current, state.index, queue.length, state.repeat);
      if (next.kind === 'part') {
        selectPart(next.id);
        set({ seekRequest: { filmId, partId: next.id, seconds: 0 } });
      } else if (next.kind === 'restart') player.seek(0, true);
      else if (next.kind === 'work')
        set({
          index: next.index,
          partFilm: '',
          partId: undefined,
          inPoint: 0,
          outPoint: null,
          loop: false,
          subtitleText: '',
          subtitleName: '',
          audioFilm: '',
          audioStream: -1,
          seekRequest: { filmId: queue[next.index], seconds: 0 },
        });
    },
  });
  const native = player.native;
  const [info, setInfo] = useState<PlaybackInfo>();
  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    void call<PlaybackInfo>('playback.info', { id: filmId, partId })
      .then(value => {
        if (!cancelled) setInfo(value);
      })
      .catch(notifyError);
    return () => {
      cancelled = true;
    };
  }, [filmId, partId]);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let disposed = false;
    setOffline(false);
    if (player.error)
      void call<{ available: boolean }>('film.availability', { id: filmId, partId })
        .then(r => {
          if (!disposed) setOffline(!r.available);
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [player.error, filmId, partId]);
  const [snapshot, setSnapshot] = useState('');
  const [help, setHelp] = useState(false);
  const [jump, setJump] = useState<string>();
  const scrubbing = usePlayerScrubbing(player, filmId + ':' + (partId ?? ''), active);
  const scrub = scrubbing.position;
  const [externalOpen, setExternalOpen] = useState(false);
  const [subtitleSearchOpen, setSubtitleSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [subtitleUrl, setSubtitleUrl] = useState('');
  const [queueDetails, setQueueDetails] = useState<Record<string, FilmDetail>>({});
  const presentation = usePlayerPresentation(
    player,
    active,
    tab.id,
    settingsOpen || help || !!snapshot || jump !== undefined || scrub !== undefined || !!state.sidebar,
  );
  const track = useRef<HTMLTrackElement>(null);
  const latest = useRef({ player, state, set, active });
  latest.current = { player, state, set, active };
  useEffect(() => {
    if (player.detail) void player.reload().catch(notifyError);
  }, [app.filmRevision(filmId)]);
  const duration = player.duration;
  const film = player.detail?.film;
  const jumpAt = jump === undefined ? undefined : parseTimecode(jump);
  const validJump = jumpAt !== undefined && jumpAt <= duration;
  const jumpTo = () => {
    if (validJump) {
      scrubbing.commit(jumpAt!);
      setJump(undefined);
    }
  };
  useEffect(() => {
    const request = state.seekRequest;
    if (
      !request ||
      !active ||
      player.loading ||
      !player.source ||
      film?.id !== request.filmId ||
      (request.partId && film?.partId !== request.partId)
    )
      return;
    player.seek(request.seconds, true);
    set({ seekRequest: null });
  }, [state.seekRequest, active, player.loading, player.source, film?.id, film?.partId]);
  // Keep Spectrum's portalled menus/dialogs inside the fullscreen element.
  const full = () => presentation.full();
  const interaction = useRef({ presentation, scrubbing });
  interaction.current = { presentation, scrubbing };
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const videoClick = () => {
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      if (latest.current.active) latest.current.player.toggle();
    }, 310);
  };
  const videoDoubleClick = () => {
    clearTimeout(clickTimer.current);
    void full().catch(notifyError);
  };
  const videoStyle: CSSProperties = {
    objectFit: state.fit as CSSProperties['objectFit'],
    transform: `rotate(${state.rotation}deg) scale(${state.mirror ? -state.zoom : state.zoom}, ${state.zoom})`,
    filter: `brightness(${state.brightness}) contrast(${state.contrast}) saturate(${state.saturation})`,
  };
  const picture = async () => {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await player.video.current?.requestPictureInPicture();
  };
  const shot = () => {
    if (native) {
      void native.command<string>('screenshot', { subtitles: true }).then(setSnapshot).catch(notifyError);
      return;
    }
    const video = player.video.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    setSnapshot(canvas.toDataURL('image/png'));
  };
  useEffect(() => {
    const vtt = state.subtitleText
      ? shiftedSubtitle(
          state.subtitleText,
          (player.source?.transcoded ? player.source.offset : 0) - state.subtitleDelay,
        )
      : '';
    if (!vtt) {
      setSubtitleUrl('');
      return;
    }
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    setSubtitleUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state.subtitleText, state.subtitleDelay, player.source?.offset, player.source?.transcoded]);
  useEffect(() => {
    if (track.current?.track) track.current.track.mode = state.captions ? 'showing' : 'disabled';
  }, [state.captions, subtitleUrl]);
  useEffect(() => {
    if (state.sidebar !== 'queue') return;
    let disposed = false;
    void Promise.all(
      queue.slice((state.queuePage - 1) * 20, state.queuePage * 20).map(id => call<FilmDetail>('film.get', { id })),
    )
      .then(items => {
        if (!disposed) setQueueDetails(Object.fromEntries(items.map(d => [d.film.id, d])));
      })
      .catch(notifyError);
    return () => {
      disposed = true;
    };
  }, [state.sidebar, state.queuePage, queue.join(',')]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !latest.current.active || document.querySelector('[role=menu],[role=dialog]'))
        return;
      const view = interaction.current.presentation;
      if (!view.fullscreen && !view.focus) return;
      // A tooltip or slider may consume Escape during bubbling. Open menus and
      // dialogs still own their dismissal; otherwise presentation exits first.
      event.preventDefault();
      event.stopPropagation();
      if (view.fullscreen) void view.full(false).catch(notifyError);
      else view.leaveFocus();
    };
    const keydown = (event: KeyboardEvent) => {
      const live = latest.current;
      if (!live.active || event.defaultPrevented) return;
      const view = interaction.current.presentation;
      if (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        (event.target instanceof Element &&
          event.target.closest(
            'input,textarea,select,button,[role=tab],[role=tablist],[role=menuitem],[role=slider],[role=combobox],[role=dialog],[contenteditable=true]',
          ))
      )
        return;
      const p = live.player;
      view.reveal();
      const command = registry.playback.presentation.commands.find(command =>
        (command.keys as string[]).includes(event.key.toLowerCase()),
      )?.id;
      if (command) {
        event.preventDefault();
        if (command === 'fullscreen') void view.full().catch(notifyError);
        if (command === 'focus') view.toggleFocus();
        if (command === 'jumpBack') p.seek(p.position - live.state.seekStep);
        if (command === 'jumpForward') p.seek(p.position + live.state.seekStep);
        return;
      }
      switch (event.key.toLowerCase()) {
        case ' ':
        case 'k':
          event.preventDefault();
          p.toggle();
          break;
        case 'arrowup':
          event.preventDefault();
          live.set({
            volume: Math.min(
              live.player.native ? 2 : 1,
              playbackVolume(live.state.volume, live.player.native ? 2 : 1) + 0.05,
            ),
            muted: false,
          });
          break;
        case 'arrowdown':
          event.preventDefault();
          live.set({ volume: Math.max(0, playbackVolume(live.state.volume, live.player.native ? 2 : 1) - 0.05) });
          break;
        case ',':
          p.frame(-1);
          break;
        case '.':
          p.frame(1);
          break;
        case 'm':
          live.set({ muted: !live.state.muted });
          break;
        case 'i':
          live.set({ inPoint: p.position, sidebar: 'notes' });
          break;
        case 'o':
          live.set({ outPoint: p.position, sidebar: 'notes' });
          break;
        case '?':
          setHelp(true);
          break;
      }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('keydown', keydown);
    };
  }, []);
  const queueSlice = queue.slice((state.queuePage - 1) * 20, state.queuePage * 20);
  return (
    <Provider colorScheme="dark" UNSAFE_className="player-provider">
      <div className={'player-page' + (state.sidebar ? ' with-aside' : '')}>
        <div className="player-body">
          <div className="player-view">
            <div
              ref={presentation.stage}
              tabIndex={-1}
              className={'video-stage' + (presentation.visible ? '' : ' controls-hidden')}
              onPointerMove={presentation.reveal}
              onPointerDown={presentation.reveal}
              onFocusCapture={presentation.reveal}
              style={{ '--subtitle-size': state.subtitleSize + '%' } as CSSProperties}
              onContextMenu={event =>
                openContextMenu(event, [
                  {
                    id: 'play',
                    label: appText(player.paused ? 'PlayerPage.play' : 'PlayerPage.pause'),
                    run: player.toggle,
                  },
                  {
                    id: 'back',
                    label: appText(native ? 'PlayerPage.previousFrame' : 'Player.approxPreviousFrame'),
                    run: () => player.frame(-1),
                  },
                  {
                    id: 'next',
                    label: appText(native ? 'PlayerPage.nextFrame' : 'Player.approxNextFrame'),
                    run: () => player.frame(1),
                  },
                  { id: 'shot', label: appText('PlayerPage.captureCurrentFrame'), run: shot },
                  {
                    id: 'start',
                    label: appText('PlayerPage.markSegmentStartI'),
                    run: () => set({ inPoint: player.position, sidebar: 'notes' }),
                  },
                  {
                    id: 'end',
                    label: appText('PlayerPage.markSegmentEndO'),
                    run: () => set({ outPoint: player.position, sidebar: 'notes' }),
                  },
                  {
                    id: 'loop',
                    label: appText(state.loop ? 'PlayerPage.stopSegmentLoop' : 'PlayerPage.loopMarkedSegment'),
                    disabled: state.outPoint == null || state.outPoint <= state.inPoint,
                    run: () => set({ loop: !state.loop }),
                  },
                  { id: 'external', label: appText('ExternalPlayers.title'), run: () => setExternalOpen(true) },
                  { id: 'settings', label: appText('PlayerPage.playbackSettings'), run: () => setSettingsOpen(true) },
                  {
                    id: 'full',
                    label: appText(presentation.fullscreen ? 'Player.exitFullscreen' : 'PlayerPage.fullscreen'),
                    run: full,
                  },
                  {
                    id: 'focus',
                    label: appText(presentation.focus ? 'Player.leaveFocus' : 'Player.focus'),
                    run: presentation.toggleFocus,
                  },
                  {
                    id: 'locate',
                    label: appText('Journey.locateFile'),
                    run: () => call('platform.reveal', { id: filmId, partId: film?.partId }),
                  },
                ])
              }
            >
              {native ? (
                <div
                  ref={native.surface}
                  tabIndex={0}
                  className="native-video-surface"
                  data-composited-video={(nativeComposition && native.embedded && active) || undefined}
                  aria-label={film?.presentation.title || appText('PlayerPage.video')}
                  onClick={videoClick}
                  onDoubleClick={videoDoubleClick}
                  onWheel={event => {
                    if (event.deltaY)
                      set({
                        volume: Math.max(0, Math.min(2, state.volume + (event.deltaY < 0 ? 0.05 : -0.05))),
                        muted: false,
                      });
                  }}
                >
                  {!native.embedded && <span>{appText('Mpv.detached')}</span>}
                </div>
              ) : (
                <video
                  style={videoStyle}
                  ref={player.video}
                  controls={false}
                  playsInline
                  preload="auto"
                  crossOrigin="anonymous"
                  aria-label={film?.presentation.title || appText('PlayerPage.video')}
                  onClick={videoClick}
                  onDoubleClick={videoDoubleClick}
                  data-stalls={player.metrics.stalls}
                  data-buffer-seconds={player.metrics.bufferSeconds.toFixed(1)}
                  data-startup-ms={player.metrics.startupMs == null ? undefined : Math.round(player.metrics.startupMs)}
                >
                  {subtitleUrl && (
                    <track
                      key={subtitleUrl}
                      ref={track}
                      kind="subtitles"
                      src={subtitleUrl}
                      srcLang="und"
                      label={state.subtitleName || appText('PlayerPage.subtitles')}
                      default
                      onLoad={() => {
                        if (track.current) track.current.track.mode = state.captions ? 'showing' : 'disabled';
                      }}
                    />
                  )}
                </video>
              )}
              {scrubbing.image && (
                <img
                  style={videoStyle}
                  className="scrub-preview"
                  src={scrubbing.image}
                  alt={appText('Player.previewFrame')}
                />
              )}
              {scrub !== undefined && <div className="seek-feedback">{timecode(scrub, true)}</div>}
              <PlayerFeedback
                active={active}
                ready={!player.loading && scrub === undefined}
                paused={player.paused}
                volume={playbackVolume(state.volume, native ? 2 : 1)}
                muted={state.muted}
                rate={state.rate}
              />
              {(player.loading || player.waiting) && !player.error && (
                <div className="video-status" role="status">
                  <Spin />
                  <span>
                    {player.loading ? appText('PlayerPage.preparingPlayback') : appText('PlayerPage.buffering')}
                  </span>
                </div>
              )}
              {player.error && (
                <div className="video-status video-error" role="alert">
                  <IconInfo />
                  <p>{offline ? appText('host.Journey.mediaOffline') : player.error}</p>
                  <Button theme="solid" onClick={player.retry}>
                    {appText('PlayerPage.retry')}
                  </Button>
                  <Button
                    onClick={() =>
                      offline
                        ? action(() => call('platform.reveal', { id: filmId }))
                        : set(native ? { engine: 'browser' } : { mode: 'compatible' })
                    }
                  >
                    {appText(offline ? 'Journey.locateFile' : native ? 'Mpv.browser' : 'PlayerPage.smoothPlayback')}
                  </Button>
                </div>
              )}
              <div
                className="player-controls"
                onPointerLeave={presentation.reveal}
                role="toolbar"
                aria-label={appText('PlayerPage.playbackControls')}
              >
                <div className="seek-row">
                  <div className="buffer-layer">
                    {player.buffered.map(([a, b], i) => (
                      <i
                        key={i}
                        style={{
                          left: `${(a / Math.max(1, duration)) * 100}%`,
                          width: `${((b - a) / Math.max(1, duration)) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                  <Slider
                    aria-label={appText('PlayerPage.playbackPosition')}
                    minValue={0}
                    maxValue={duration || 1}
                    step={0.01}
                    value={scrub ?? Math.min(duration, player.position)}
                    onChange={scrubbing.preview}
                    onChangeEnd={scrubbing.commit}
                    formatOptions={{ maximumFractionDigits: 2 }}
                    isDisabled={!film || duration <= 0 || (player.loading && scrub === undefined)}
                    UNSAFE_className="seek-slider"
                  />
                  <div className="annotation-markers">
                    {player.detail?.annotations
                      .filter(a => a.scope.startUs != null)
                      .map(a => {
                        const rect = annotationPercent(
                          Number(a.scope.startUs) / 1e6,
                          a.scope.endUs ? Number(a.scope.endUs) / 1e6 : undefined,
                          duration,
                        );
                        return (
                          <i
                            key={a.id}
                            title={timecode(Number(a.scope.startUs) / 1e6)}
                            style={{ left: rect.left + '%', width: rect.width + '%' }}
                          />
                        );
                      })}
                  </div>
                </div>
                <div className="control-row">
                  <Button
                    theme="borderless"
                    icon={<IconSkipBack seconds={state.seekStep} />}
                    title={appText('Player.jumpBack', { seconds: state.seekStep })}
                    aria-label={appText('Player.jumpBack', { seconds: state.seekStep })}
                    onClick={() => player.seek(player.position - state.seekStep)}
                  />
                  <Button
                    className="play-toggle"
                    theme="borderless"
                    icon={player.paused ? <IconPlay /> : <IconPause />}
                    aria-label={
                      player.ended
                        ? appText('PlayerPage.replay')
                        : player.paused
                          ? appText('PlayerPage.play')
                          : appText('PlayerPage.pause')
                    }
                    title={appText('PlayerPage.playPauseSpace')}
                    onClick={player.toggle}
                    disabled={player.loading}
                  />
                  <Button
                    theme="borderless"
                    icon={<IconSkipForward seconds={state.seekStep} />}
                    title={appText('Player.jumpForward', { seconds: state.seekStep })}
                    aria-label={appText('Player.jumpForward', { seconds: state.seekStep })}
                    onClick={() => player.seek(player.position + state.seekStep)}
                  />
                  {queue.length > 1 && (
                    <Button
                      theme="borderless"
                      icon={<IconChevronRight />}
                      aria-label={appText('PlayerPage.nextFilm')}
                      title={appText('PlayerPage.nextFilm')}
                      disabled={state.index + 1 >= queue.length}
                      onClick={() =>
                        set({ index: state.index + 1, inPoint: 0, outPoint: null, loop: false, subtitleText: '' })
                      }
                    />
                  )}
                  <Button
                    className="player-time"
                    theme="borderless"
                    aria-label={appText('Player.jumpTime')}
                    title={appText('Player.jumpTime')}
                    disabled={!duration}
                    onClick={() => setJump(timecode(player.position))}
                  >
                    <b>{timecode(scrub ?? player.position).replace(/^00:/, '')}</b>
                    <span> / {timecode(duration).replace(/^00:/, '')}</span>
                  </Button>
                  <div className="volume-control">
                    <Button
                      theme="borderless"
                      icon={state.muted || state.volume === 0 ? <IconMuted /> : <IconVolume />}
                      aria-label={state.muted ? appText('PlayerPage.unmute') : appText('PlayerPage.mute')}
                      title={appText('PlayerPage.muteM')}
                      onClick={() => set({ muted: !state.muted })}
                    />
                    <Slider
                      size="S"
                      aria-label={appText('PlayerPage.volume')}
                      minValue={0}
                      maxValue={native ? 2 : 1}
                      step={0.01}
                      value={state.muted ? 0 : playbackVolume(state.volume, native ? 2 : 1)}
                      onChange={volume => set({ volume, muted: false })}
                      formatOptions={{ style: 'percent' }}
                      UNSAFE_className="volume-slider"
                    />
                  </div>
                  <span className="player-now-playing" title={film?.presentation.title}>
                    {film?.presentation.title || appText('PlayerPage.openingFilm')}
                  </span>
                  <div className="control-spacer" />
                  {film && (
                    <Slot film={film} region="player.toolbar.extensions" onChanged={() => void player.reload()} />
                  )}
                  {state.loop && <span className="loop-badge">A–B</span>}
                  <Select
                    aria-label={appText('PlayerPage.playbackSpeed')}
                    value={state.rate}
                    onChange={v => set({ rate: Number(v) })}
                    optionList={[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(value => ({ value, label: value + '×' }))}
                    size="small"
                  />
                  <Button
                    theme="borderless"
                    icon={<IconTag />}
                    aria-label={inspectorTitle}
                    title={inspectorTitle}
                    aria-pressed={state.sidebar === 'notes'}
                    onClick={() => set({ sidebar: state.sidebar === 'notes' ? '' : 'notes' })}
                  />
                  {queue.length > 1 && (
                    <Button
                      theme="borderless"
                      icon={<IconList />}
                      aria-label={appText('PlayerPage.playlist')}
                      title={appText('PlayerPage.playlist')}
                      aria-pressed={state.sidebar === 'queue'}
                      onClick={() => set({ sidebar: state.sidebar === 'queue' ? '' : 'queue' })}
                    />
                  )}
                  <Button
                    theme="borderless"
                    icon={<IconInfo />}
                    aria-label={appText('PlayerPage.filmDetails')}
                    title={appText('PlayerPage.filmDetails')}
                    aria-pressed={state.sidebar === 'info'}
                    onClick={() => set({ sidebar: state.sidebar === 'info' ? '' : 'info' })}
                  />
                  <Button
                    theme="borderless"
                    icon={<IconCaptions />}
                    aria-label={appText('PlayerPage.subtitlesAndPlaybackSettings')}
                    title={appText('PlayerPage.subtitlesAndPlaybackSettings')}
                    onClick={() => setSettingsOpen(true)}
                  />
                  <ActionMenu
                    aria-label={appText('PlayerPage.morePlaybackActions')}
                    isQuiet
                    onAction={id => {
                      if (id === 'previous') player.frame(-1);
                      if (id === 'next') player.frame(1);
                      if (id === 'shot') shot();
                      if (id === 'in') set({ inPoint: player.position, sidebar: 'notes' });
                      if (id === 'out') set({ outPoint: player.position, sidebar: 'notes' });
                      if (id === 'loop') set({ loop: !state.loop });
                      if (id === 'help') setHelp(true);
                      if (id === 'focus') presentation.toggleFocus();
                    }}
                  >
                    <MenuItem id="previous">
                      {appText(native ? 'PlayerPage.previousFrame' : 'Player.approxPreviousFrame')}
                    </MenuItem>
                    <MenuItem id="next">{appText(native ? 'PlayerPage.nextFrame' : 'Player.approxNextFrame')}</MenuItem>
                    <MenuItem id="shot">
                      <IconCamera />
                      <Text>{appText('PlayerPage.captureCurrentFrame')}</Text>
                    </MenuItem>
                    <MenuItem id="in">{appText('PlayerPage.markSegmentStartI')}</MenuItem>
                    <MenuItem id="out">{appText('PlayerPage.markSegmentEndO')}</MenuItem>
                    <MenuItem id="loop" isDisabled={state.outPoint == null || state.outPoint <= state.inPoint}>
                      {state.loop ? appText('PlayerPage.stopSegmentLoop') : appText('PlayerPage.loopMarkedSegment')}
                    </MenuItem>
                    <MenuItem id="focus">{appText(presentation.focus ? 'Player.leaveFocus' : 'Player.focus')}</MenuItem>
                    <MenuItem id="help">{appText('PlayerPage.keyboardShortcuts')}</MenuItem>
                  </ActionMenu>
                  {!native && document.pictureInPictureEnabled && (
                    <Button
                      theme="borderless"
                      icon={<PipIcon />}
                      aria-label={appText('PlayerPage.pictureInPicture')}
                      title={appText('PlayerPage.pictureInPicture')}
                      onClick={() => void picture().catch(notifyError)}
                    />
                  )}
                  <Button
                    theme="borderless"
                    icon={<IconFullscreen />}
                    aria-label={appText(presentation.fullscreen ? 'Player.exitFullscreen' : 'PlayerPage.fullscreen')}
                    title={appText(presentation.fullscreen ? 'Player.exitFullscreen' : 'PlayerPage.fullscreenF')}
                    onClick={() => void full().catch(notifyError)}
                  />
                </div>
              </div>
            </div>
          </div>
          {state.sidebar && (
            <aside className="player-aside">
              <header>
                <h2>
                  {state.sidebar === 'notes'
                    ? inspectorTitle
                    : state.sidebar === 'queue'
                      ? appText('PlayerPage.playlist')
                      : appText('PlayerPage.filmDetails')}
                </h2>
                <Button
                  theme="borderless"
                  icon={<IconChevronRight />}
                  aria-label={appText('PlayerPage.collapseSidebar')}
                  title={appText('PlayerPage.collapseSidebar')}
                  size="S"
                  onClick={() => set({ sidebar: '' })}
                />
              </header>
              {state.sidebar === 'notes' && player.detail && (
                <Surface
                  surface="player.inspector"
                  detail={player.detail}
                  tab={tab}
                  reload={player.reload}
                  position={player.position}
                  seek={seconds => player.seek(seconds, true)}
                  inPoint={state.inPoint}
                  outPoint={state.outPoint}
                />
              )}
              {state.sidebar === 'queue' && (
                <div className="queue-list">
                  {queueSlice.map((id, i) => {
                    const index = (state.queuePage - 1) * 20 + i;
                    return (
                      <div data-context-resource="" className="schema-queue-entry" key={id + index}>
                        <Button
                          block
                          theme={index === state.index ? 'solid' : 'borderless'}
                          onClick={() => set({ index, inPoint: 0, outPoint: null, loop: false, subtitleText: '' })}
                        >
                          {index + 1}. {queueDetails[id]?.film.presentation.title || appText('PlayerPage.loading')}
                        </Button>
                        {queueDetails[id]?.film && (
                          <Slot film={queueDetails[id].film} region="player.queue.item.trailing" />
                        )}
                      </div>
                    );
                  })}
                  <Space>
                    <Button disabled={state.queuePage <= 1} onClick={() => set({ queuePage: state.queuePage - 1 })}>
                      {appText('PlayerPage.previousPage')}
                    </Button>
                    <span>{state.queuePage}</span>
                    <Button
                      disabled={state.queuePage * 20 >= queue.length}
                      onClick={() => set({ queuePage: state.queuePage + 1 })}
                    >
                      {appText('PlayerPage.nextPage')}
                    </Button>
                  </Space>
                </div>
              )}
              {state.sidebar === 'info' && film && (
                <div className="form-stack">
                  <Slot film={film} region="film.details.facts" />
                  <Button
                    onClick={() =>
                      app.open({
                        id: 'film:' + film.id,
                        kind: 'film',
                        title: film.presentation.tabTitle,
                        params: { filmId: film.id },
                      })
                    }
                  >
                    {appText('PlayerPage.editFilmDetails')}
                  </Button>
                </div>
              )}
            </aside>
          )}
        </div>
        <SubtitleSearchDialog
          filmId={filmId}
          partId={film?.partId}
          title={film?.presentation.title ?? ''}
          visible={subtitleSearchOpen}
          onClose={() => setSubtitleSearchOpen(false)}
          onLoad={async file => {
            if (native) {
              const bytes = new TextEncoder().encode(file.text);
              let data = '';
              for (let i = 0; i < bytes.length; i += 8192) data += String.fromCharCode(...bytes.subarray(i, i + 8192));
              await native.command('subtitle', {
                name: file.name.endsWith('.srt') ? file.name : file.name + '.srt',
                data: btoa(data),
              });
            } else set({ subtitleText: subtitleToVtt(file.text), subtitleName: file.name, captions: true });
          }}
        />
        <ExternalPlayerDialog
          filmId={filmId}
          partId={film?.partId}
          visible={externalOpen}
          onClose={() => setExternalOpen(false)}
        />
        <Modal
          mode="modeless"
          width={720}
          title={appText('PlayerPage.playbackSettings')}
          visible={settingsOpen}
          onCancel={() => setSettingsOpen(false)}
          footer={<Button onClick={() => setSettingsOpen(false)}>{appText('PlayerPage.done')}</Button>}
        >
          {structure && structure.versions.some(v => v.parts.length > 0) && (
            <FormLayout>
              <FormField label={appText('MediaResources.playPart')}>
                <Select
                  value={film?.partId ?? ''}
                  onChange={value => selectPart(String(value))}
                  optionList={structure.versions.flatMap(v =>
                    v.parts.map((p, index) => ({
                      value: p.id,
                      label:
                        (v.name || appText('MediaResources.defaultVersion')) +
                        ' · ' +
                        appText('MediaResources.part', { number: index + 1 }),
                    })),
                  )}
                />
              </FormField>
            </FormLayout>
          )}
          <FormLayout>
            <FormField label={appText('Subtitles.search')}>
              <Button onClick={() => setSubtitleSearchOpen(true)}>{appText('Subtitles.search')}</Button>
            </FormField>
          </FormLayout>
          <EnginePicker
            value={state.engine}
            capabilities={capabilities}
            change={engine => {
              void (async () => {
                await call('film.position', {
                  id: filmId,
                  partId: film?.partId,
                  mediaRevision: film?.mediaRevision,
                  position: player.ended ? 0 : player.position,
                });
                if (native) await native.command('stop');
                set({ engine });
              })().catch(notifyError);
            }}
          />
          {native ? (
            <NativePlaybackSettings
              native={native}
              values={{
                ...state.nativeSettings,
                speed: state.rate,
                volume: state.volume * 100,
                'audio-pitch-correction': state.preservePitch,
              }}
              change={values => {
                const settings = { ...state.nativeSettings, ...values };
                const patch: Partial<typeof state> = {};
                if (typeof values.speed === 'number') patch.rate = values.speed;
                if (typeof values.volume === 'number') {
                  patch.volume = values.volume / 100;
                  patch.muted = false;
                }
                if (typeof values['audio-pitch-correction'] === 'boolean')
                  patch.preservePitch = values['audio-pitch-correction'];
                delete settings.speed;
                delete settings.volume;
                delete settings['audio-pitch-correction'];
                set({ ...patch, nativeSettings: settings });
              }}
              position={player.position}
              duration={duration}
              seek={player.seek}
              repeat={state.repeat}
              seekStep={state.seekStep}
              navigation={set}
            />
          ) : (
            <FormLayout>
              <FormField
                layout="row"
                label={appText('PlayerPage.playbackMode')}
                description={appText('PlayerPage.smoothPlaybackBuffersAheadAndPreservesThe')}
              >
                <Select
                  aria-label={appText('PlayerPage.playbackMode')}
                  value={mode}
                  onChange={v => set({ mode: String(v) })}
                  optionList={[
                    { value: 'auto', label: appText('PlayerPage.automaticRecommended') },
                    { value: 'direct', label: appText('PlayerPage.originalFile') },
                    { value: 'compatible', label: appText('PlayerPage.smoothPlayback') },
                    { value: 'encode', label: appText('PlayerPage.reEncode') },
                  ]}
                />
              </FormField>
              <FormField layout="row" label={appText('PlayerPage.subtitles')}>
                <FileTrigger
                  acceptedFileTypes={['.srt', '.vtt']}
                  onSelect={files => {
                    const file = files?.[0];
                    if (file && file.size > 400000) {
                      notifyError(new Error(appText('PlayerPage.subtitleFileIsTooLarge')));
                      return;
                    }
                    if (file)
                      void file
                        .text()
                        .then(text => {
                          if (text.length > 100000) throw new Error(appText('PlayerPage.subtitleFileIsTooLarge'));
                          set({ subtitleText: subtitleToVtt(text), subtitleName: file.name, captions: true });
                        })
                        .catch(notifyError);
                  }}
                >
                  <ActionButton>
                    <IconCaptions />
                    <Text>{state.subtitleName || appText('PlayerPage.loadSrtVttSubtitles')}</Text>
                  </ActionButton>
                </FileTrigger>
                {state.subtitleText && (
                  <SegmentedControl
                    aria-label={appText('PlayerPage.subtitleVisibility')}
                    selectedKey={state.captions ? 'on' : 'off'}
                    onSelectionChange={key => set({ captions: key === 'on' })}
                  >
                    <SegmentedControlItem id="on">{appText('PlayerPage.showSubtitles')}</SegmentedControlItem>
                    <SegmentedControlItem id="off">{appText('PlayerPage.hideSubtitles')}</SegmentedControlItem>
                  </SegmentedControl>
                )}
              </FormField>
              <PlaybackSettings
                value={state}
                change={patch => set(patch)}
                info={info}
                filmId={filmId}
                position={player.position}
                duration={duration}
                seek={at => player.seek(at)}
              />
              <details className="form-disclosure">
                <summary>{appText('PlayerPage.playbackDiagnostics')}</summary>
                <dl className="description-list">
                  <dt>{appText('PlayerPage.processingMode')}</dt>
                  <dd>{player.source?.pipeline || appText('PlayerPage.preparing')}</dd>
                  <dt>{appText('PlayerPage.timeToFirstFrame')}</dt>
                  <dd>
                    {player.metrics.startupMs == null
                      ? appText('Player.notMeasured')
                      : (player.metrics.startupMs / 1000).toFixed(2)}{' '}
                    {appText('PlayerPage.seconds')}
                  </dd>
                  <dt>{appText('PlayerPage.playableBuffer')}</dt>
                  <dd>
                    {player.metrics.bufferSeconds.toFixed(1)} {appText('PlayerPage.seconds')}
                  </dd>
                  <dt>{appText('PlayerPage.rebuffering')}</dt>
                  <dd>
                    {player.metrics.stalls} {appText('PlayerPage.times')}
                    {(player.metrics.stalledMs / 1000).toFixed(1)} {appText('PlayerPage.seconds')}
                  </dd>
                  <dt>{appText('PlayerPage.droppedTotalFrames')}</dt>
                  <dd>
                    {player.metrics.droppedFrames} / {player.metrics.totalFrames}
                  </dd>
                  <dt>{appText('PlayerPage.preparedThrough')}</dt>
                  <dd>{timecode(player.status?.readyUntil || 0)}</dd>
                </dl>
              </details>
            </FormLayout>
          )}
        </Modal>
        <SnapshotDialog
          image={snapshot}
          name={film?.presentation.snapshotName || 'frame'}
          onClose={() => setSnapshot('')}
        />
        <ShortcutHelpDialog visible={help} seekStep={state.seekStep} onClose={() => setHelp(false)} />
        <JumpTimeDialog
          value={jump}
          valid={validJump}
          onChange={setJump}
          onSubmit={jumpTo}
          onClose={() => setJump(undefined)}
        />
      </div>
    </Provider>
  );
}
