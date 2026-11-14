export interface ScrubBackend {
  isPlaying(): boolean;
  pause(): Promise<void>;
  preview(position: number, signal: AbortSignal): Promise<string | undefined>;
  commit(position: number, playing: boolean, signal: AbortSignal): Promise<void>;
  resume(playing: boolean): Promise<void>;
  changed(position: number | undefined, image?: string): void;
  failed(error: unknown): void;
}

// One decoder request in flight and one replaceable destination. A release is
// always an exact commit, even when a preview for the same position is in flight.
export function createScrubber(backend: ScrubBackend, intervalMs = 90) {
  let session: { abort: AbortController; playing: boolean; paused: Promise<void> } | undefined;
  let pending: { position: number; final: boolean } | undefined;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPreview = 0;
  let image: string | undefined;
  const queued = () => pending;
  function cancel() {
    session?.abort.abort();
    session = undefined;
    pending = undefined;
    clearTimeout(timer);
    timer = undefined;
    image = undefined;
    backend.changed(undefined);
  }
  async function pump() {
    if (busy || !session || !pending) return;
    const owner = session;
    const request = pending;
    pending = undefined;
    busy = true;
    try {
      await owner.paused;
      owner.abort.signal.throwIfAborted();
      if (request.final) {
        await backend.commit(request.position, false, owner.abort.signal);
        if (session === owner && !pending) {
          await backend.resume(owner.playing);
          if (session === owner && !queued()) {
            session = undefined;
            image = undefined;
            backend.changed(undefined);
          } else if (session === owner) await backend.pause();
        }
      } else {
        lastPreview = performance.now();
        const frame = await backend.preview(request.position, owner.abort.signal);
        const next = queued();
        if (session === owner && !next?.final) {
          image = frame;
          backend.changed(next?.position ?? request.position, image);
        }
      }
    } catch (error) {
      if (session === owner && !owner.abort.signal.aborted) {
        cancel();
        backend.failed(error);
      }
    } finally {
      busy = false;
      if (pending && session) schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (busy || !pending) return;
    const delay = pending.final ? 0 : Math.max(0, intervalMs - (performance.now() - lastPreview));
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, delay);
  }
  function request(position: number, final: boolean) {
    if (!Number.isFinite(position)) return;
    if (!session) {
      const playing = backend.isPlaying();
      // Pause is owned by this gesture; later status polls cannot change the
      // playback intention to restore on release.
      session = { playing, abort: new AbortController(), paused: backend.pause() };
      void session.paused.catch(() => {}); // Cancellation may precede the scheduled pump.
    }
    pending = { position: Math.max(0, position), final };
    backend.changed(pending.position, image);
    schedule();
  }
  return {
    preview: (position: number) => request(position, false),
    commit: (position: number) => request(position, true),
    cancel,
  };
}

export function playbackDuration(...values: (number | undefined)[]) {
  return values.find(value => value != null && Number.isFinite(value) && value > 0) ?? 0;
}
export function playbackVolume(value: number, maximum = 1) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : 0.8;
}
