export type NativeInput = {
  sessionId: string;
  kind: 'click' | 'dblclick' | 'contextmenu' | 'key';
  key: string;
  x: number;
  y: number;
};

/** Normalized native coordinates remain correct under browser zoom and monitor DPI changes. */
export function dispatchNativeInput(surface: HTMLElement, input: NativeInput) {
  if (document.querySelector('[role=dialog][aria-modal=true],[role=alertdialog][aria-modal=true]')) return;
  surface.focus({ preventScroll: true });
  if (input.kind === 'key') {
    if (input.key === 'Tab') {
      surface.closest('.video-stage')?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      return;
    }
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: input.key, bubbles: true, cancelable: true }));
    return;
  }
  const rect = surface.getBoundingClientRect();
  const init = {
    clientX: rect.left + input.x * rect.width,
    clientY: rect.top + input.y * rect.height,
    bubbles: true,
    cancelable: true,
    button: input.kind === 'contextmenu' ? 2 : 0,
  };
  surface.dispatchEvent(new PointerEvent('pointerdown', init));
  surface.dispatchEvent(new MouseEvent(input.kind, init));
}
