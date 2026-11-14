import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Provider, ToastContainer, ToastQueue } from '@react-spectrum/s2';
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider';
import { FocusScope } from 'react-aria/FocusScope';
import { getLocale, t } from './i18n';
import { reportError, installErrorHandlers } from './diagnostics';
import { ContextMenuHost } from './ContextMenu';
import { WindowDocumentContext, trackUiWindow, useWindowDocument } from './window-environment';

export type WindowMode = 'exclusive' | 'modeless';
export const nativeDialogWindows = (window as Window & { __vroomWindows?: boolean }).__vroomWindows === true;

/** A same-origin portal preserves drafts, subscriptions and callbacks without mounting another app/player. */
export function DialogWindow({
  title,
  mode,
  width = 640,
  owner,
  onClose,
  children,
}: {
  title: ReactNode;
  mode: WindowMode;
  width?: number;
  owner?: Window;
  onClose(): void;
  children: ReactNode;
}) {
  const parentDocument = useWindowDocument();
  const [view, setView] = useState<Window>();
  const cancel = useRef(onClose);
  cancel.current = onClose;
  const heading = useRef<HTMLHeadingElement>(null);
  const overlayEscape = useRef<Event | undefined>(undefined);
  const locale = getLocale();
  useEffect(() => {
    let alive = true,
      child: Window | null = null,
      cleanup = () => {},
      closed = false;
    const parent = owner ?? parentDocument.defaultView ?? window;
    const focus = parent.document.activeElement as HTMLElement | null;
    const close = () => {
      if (alive && !closed) {
        closed = true;
        cancel.current();
      }
    };
    const id = crypto.randomUUID();
    const fail = (error: unknown) => {
      if (!alive || closed) return;
      reportError(
        new Error(`Dialog ${id} (${mode}): ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        }),
        'client.dialog.open',
      );
      ToastQueue.negative(t('Window.openFailed'));
      close();
    };
    const params = new URLSearchParams({
      id,
      mode,
      width: String(Math.round(Math.max(320, Math.min(1600, width)))),
      height: '640',
    });
    try {
      child = parent.open(new URL(`dialog.html?${params}`, window.location.href).href, '_blank', 'popup');
    } catch (error) {
      fail(error);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (!alive || closed) return;
      if (!child || child.closed) {
        window.clearInterval(timer);
        fail(new Error(child ? 'Window closed before document initialization.' : 'Window.open returned no window.'));
        return;
      }
      try {
        if (child.location.pathname !== '/dialog.html' || child.document.readyState !== 'complete') {
          if (Date.now() - started > 12000) throw new Error(t('Window.openFailed'));
          return;
        }
        window.clearInterval(timer);
        const doc = child.document;
        doc.documentElement.className = document.documentElement.className;
        doc.documentElement.dataset.dialogWindow = mode;
        // Use the same generated styles and font tokens, including styles inserted by lazy editors.
        const copied = new Map<Node, Node>();
        const styles = () => {
          for (const source of document.head.querySelectorAll('style,link[rel="stylesheet"]')) {
            if (!copied.has(source)) {
              const clone = source.cloneNode(true);
              doc.head.append(clone);
              copied.set(source, clone);
            }
          }
          for (const [source, clone] of copied)
            if (!source.isConnected) {
              clone.parentNode?.removeChild(clone);
              copied.delete(source);
            }
        };
        styles();
        const observer = new MutationObserver(styles);
        observer.observe(document.head, { childList: true, subtree: true });
        const untrack = trackUiWindow(child);
        const unlisten = installErrorHandlers(error => ToastQueue.negative(String(error)), child);
        const requestClose = () => cancel.current();
        child.addEventListener('vroom-window-close', requestClose);
        child.addEventListener('pagehide', close);
        const watch = window.setInterval(() => {
          if (child?.closed) close();
        }, 250);
        cleanup = () => {
          observer.disconnect();
          untrack();
          unlisten();
          window.clearInterval(watch);
          child?.removeEventListener('vroom-window-close', requestClose);
          child?.removeEventListener('pagehide', close);
        };
        if (alive) setView(child);
      } catch (error) {
        window.clearInterval(timer);
        fail(error);
      }
    }, 25);
    return () => {
      alive = false;
      window.clearInterval(timer);
      cleanup();
      child?.close();
      // Do not steal focus when a background tab (and its modeless window) is removed.
      parent.setTimeout(() => {
        if (!parent.closed && parent.document.hasFocus() && focus?.isConnected) focus.focus();
      }, 0);
    };
    // A language, content, size preference or callback change must not recreate a native window.
  }, [parentDocument, owner, mode]);

  useLayoutEffect(() => {
    if (!view) return;
    view.document.title = heading.current?.textContent ?? '';
    view.document.documentElement.lang = document.documentElement.lang;
    view.document.documentElement.dir = document.documentElement.dir;
  }, [view, title, locale]);
  useEffect(() => {
    if (!view) return;
    let alive = true,
      frame = 0,
      previousHeight = 0,
      maxHeight = Infinity;
    let observer: ResizeObserver | undefined;
    const web = (
      view as Window & {
        chrome?: {
          webview?: {
            postMessage(value: string): void;
            addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
            removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
          };
        };
      }
    ).chrome?.webview;
    const content = view.document.querySelector<HTMLElement>('.dialog-window-content')!;
    const body = view.document.querySelector<HTMLElement>('.dialog-window-body')!;
    const footer = view.document.querySelector<HTMLElement>('.dialog-window-actions')!;
    const measure = () => {
      if (!alive || view.closed) return;
      const style = view.getComputedStyle(content);
      // Measure natural content, not the allocated scroll viewport, so both growth and shrinkage work.
      const height = Math.max(
        180,
        Math.ceil(
          Math.max(body.scrollHeight, body.getBoundingClientRect().height) +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom) +
            footer.getBoundingClientRect().height,
        ),
      );
      // The viewport may still have the previous height while the host fits this content.
      // Only the host's actual screen/state limit can make vertical scrolling necessary.
      content.dataset.scrollable = String(height > maxHeight);
      if (height === previousHeight) return;
      previousHeight = height;
      web?.postMessage(`dialog-size|${height}`);
    };
    const sizeLimit = ({ data }: MessageEvent) => {
      if (
        data?.type !== 'dialog-size-limit' ||
        typeof data.maxHeight !== 'number' ||
        !Number.isFinite(data.maxHeight) ||
        data.maxHeight <= 0
      )
        return;
      maxHeight = data.maxHeight;
      measure();
    };
    web?.addEventListener('message', sizeLimit);
    const schedule = () => {
      if (alive && !frame)
        frame = view.requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const sheets = [...view.document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')];
    void Promise.all(
      sheets.map(link =>
        link.sheet
          ? Promise.resolve()
          : new Promise<void>(resolve => {
              link.addEventListener('load', () => resolve(), { once: true });
              link.addEventListener('error', () => resolve(), { once: true });
            }),
      ),
    ).then(() => {
      if (!alive || view.closed) return;
      // ResizeObserver is driven by its constructor's document. The opener may not render
      // while only this window changes (and automation focus emulation hides that bug).
      observer = new (view as Window & typeof globalThis).ResizeObserver(schedule);
      observer.observe(body);
      observer.observe(footer);
      observer.observe(content);
      view.addEventListener('resize', schedule);
      // The native window is hidden until its first size arrives; do not wait for its animation frame.
      measure();
    });
    return () => {
      alive = false;
      observer?.disconnect();
      web?.removeEventListener('message', sizeLimit);
      view.removeEventListener('resize', schedule);
      if (frame) view.cancelAnimationFrame(frame);
    };
  }, [view]);
  if (!view) return null;
  return createPortal(
    <WindowDocumentContext.Provider value={view.document}>
      <UNSAFE_PortalProvider getContainer={() => view.document.body}>
        <Provider locale={locale} colorScheme="dark" UNSAFE_className="spectrum-root">
          <FocusScope autoFocus>
            <section
              role="dialog"
              aria-modal={mode === 'exclusive'}
              aria-labelledby="window-title"
              className="dialog-window"
              onKeyDownCapture={e => {
                // A ComboBox may close its popup without preventing the key event. Remember the
                // overlay before child handlers run so the same Escape cannot discard this dialog.
                if (e.key === 'Escape' && view.document.querySelector('[data-placement],.context-menu'))
                  overlayEscape.current = e.nativeEvent;
              }}
              onKeyDown={e => {
                if (e.key === 'Escape' && !e.defaultPrevented && overlayEscape.current !== e.nativeEvent) {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel.current();
                }
              }}
            >
              <h1 ref={heading} id="window-title" className="sr-only">
                {title}
              </h1>
              {children}
            </section>
          </FocusScope>
          <ContextMenuHost fallback={[{ id: 'close-window', label: t('ManagementPages.close'), run: onClose }]} />
          <ToastContainer placement="bottom end" />
        </Provider>
      </UNSAFE_PortalProvider>
    </WindowDocumentContext.Provider>,
    view.document.getElementById('root')!,
  );
}
