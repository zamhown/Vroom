import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Menu, MenuItem } from 'react-aria-components';
import { t } from './i18n';
import { reportError } from './diagnostics';
import { Toast } from './ui';
import { useWindowDocument } from './window-environment';

export type ContextAction = { id: string; label: string; disabled?: boolean; run(): unknown };
type Request = { x: number; y: number; actions: ContextAction[]; focus: HTMLElement | null };
const hosts = new Map<Document, (request: Request) => void>();
const targetElement = (target: EventTarget | null) =>
  target && 'nodeType' in target && target.nodeType === 1 ? (target as Element) : null;
export function isInputTarget(target: EventTarget | null): boolean {
  return !!targetElement(target)?.closest(
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.monaco-editor',
  );
}
export function openContextMenu(event: ReactMouseEvent | MouseEvent, actions: ContextAction[]) {
  if (isInputTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  const target = targetElement(event.target) as HTMLElement | null;
  const doc = target?.ownerDocument ?? document;
  const rect = target?.getBoundingClientRect();
  hosts.get(doc)?.({
    x: event.clientX || rect?.left || 0,
    y: event.clientY || rect?.bottom || 0,
    actions,
    focus: (doc.activeElement as HTMLElement) ?? target,
  });
}

/** Resource containers reuse their existing commands, including confirmations and disabled states. */
export function ContextMenuHost({ fallback = [] }: { fallback?: ContextAction[] }) {
  const document = useWindowDocument(),
    window = document.defaultView!;
  const [request, setRequest] = useState<Request>();
  const menu = useRef<HTMLDivElement>(null),
    live = useRef(fallback);
  live.current = fallback;
  const dismiss = (restore = false) => {
    setRequest(undefined);
    if (restore) request?.focus?.focus();
  };
  useEffect(() => {
    hosts.set(document, setRequest);
    // Capture suppression also covers widgets that stop propagation. Text editors retain their native menu.
    const suppress = (e: MouseEvent) => {
      if (!isInputTarget(e.target)) e.preventDefault();
    };
    const context = (e: MouseEvent) => {
      if (isInputTarget(e.target)) {
        setRequest(undefined);
        return;
      }
      const target = targetElement(e.target);
      const resource = target?.closest('[data-context-resource],[role="row"],.view-row,tbody tr');
      const controls = resource ? [...resource.querySelectorAll<HTMLElement>('button,a[href],[role="button"]')] : [];
      if (resource?.matches('button,[role="button"]')) controls.unshift(resource as HTMLElement);
      const actions: ContextAction[] = controls
        .filter(el => !el.closest('[hidden]') && !el.getAttribute('aria-haspopup') && el.getClientRects().length > 0)
        .map((el, i) => ({
          id: `resource-${i}`,
          label: el.getAttribute('aria-label') || el.textContent?.trim() || '',
          disabled: el.matches(':disabled,[aria-disabled="true"]'),
          run: () => {
            if (el.isConnected && !el.matches(':disabled,[aria-disabled="true"]')) el.click();
          },
        }))
        .filter(a => a.label);
      const selected = window.getSelection()?.toString();
      if (selected)
        actions.push({
          id: 'copy-selection',
          label: t('ContextMenu.copySelection'),
          run: () => navigator.clipboard.writeText(selected),
        });
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (link)
        actions.push({
          id: 'copy-link',
          label: t('ContextMenu.copyLink'),
          run: () => navigator.clipboard.writeText(link.href),
        });
      const rect = target?.getBoundingClientRect();
      setRequest({
        x: e.clientX || rect?.left || 0,
        y: e.clientY || rect?.bottom || 0,
        actions: actions.length ? actions : live.current,
        focus: document.activeElement as HTMLElement,
      });
    };
    document.addEventListener('contextmenu', suppress, true);
    document.addEventListener('contextmenu', context);
    return () => {
      hosts.delete(document);
      document.removeEventListener('contextmenu', suppress, true);
      document.removeEventListener('contextmenu', context);
    };
  }, [document]);
  useLayoutEffect(() => {
    if (!request || !menu.current) return;
    const element = menu.current,
      viewport = window.visualViewport;
    const position = () => {
      const gap = Number.parseFloat(getComputedStyle(element).paddingLeft) || 8;
      const left = (viewport?.offsetLeft ?? 0) + gap,
        top = (viewport?.offsetTop ?? 0) + gap;
      const width = Math.max(0, (viewport?.width ?? document.documentElement.clientWidth) - 2 * gap);
      const height = Math.max(0, (viewport?.height ?? document.documentElement.clientHeight) - 2 * gap);
      element.style.setProperty('--context-menu-max-width', `${width}px`);
      element.style.setProperty('--context-menu-max-height', `${height}px`);
      const rect = element.getBoundingClientRect();
      // Prefer the opposite side of the pointer when the menu would cross an edge, then clamp.
      const x = request.x + rect.width > left + width ? request.x - rect.width : request.x;
      const y = request.y + rect.height > top + height ? request.y - rect.height : request.y;
      element.style.left = `${Math.max(left, Math.min(x, left + width - rect.width))}px`;
      element.style.top = `${Math.max(top, Math.min(y, top + height - rect.height))}px`;
    };
    position();
    // React Aria collections mount after the host's first layout; fonts and labels may also resize it.
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [request]);
  useEffect(() => {
    if (!request) return;
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) dismiss();
    };
    const close = () => dismiss();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', close);
    };
  }, [request]);
  return (
    request &&
    createPortal(
      <div
        ref={menu}
        className="context-menu"
        style={{ left: request.x, top: request.y }}
        onKeyDown={e => {
          if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            dismiss(true);
          }
        }}
      >
        <Menu
          aria-label={t('ContextMenu.actions')}
          autoFocus="first"
          onAction={id => {
            const command = request.actions.find(a => a.id === id);
            dismiss(true);
            if (command && !command.disabled)
              void Promise.resolve()
                .then(command.run)
                .catch(error => {
                  reportError(error);
                  Toast.error(String(error));
                });
          }}
        >
          {request.actions.map(a => (
            <MenuItem key={a.id} id={a.id} isDisabled={a.disabled} textValue={a.label} className="context-menu-item">
              {a.label}
            </MenuItem>
          ))}
        </Menu>
      </div>,
      document.body,
    )
  );
}
