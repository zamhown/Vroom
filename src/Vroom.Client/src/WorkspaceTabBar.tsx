import { openContextMenu } from './ContextMenu';
import { t as appText } from './i18n';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { CollectionRendererContext, DefaultCollectionRenderer, Tab, TabList } from 'react-aria-components';
import { useApp } from './context';
import { Button } from './ui';
import { IconChevronLeft, IconChevronRight, IconClose } from './icons';
import { WorkspaceGroupIcon, WorkspaceIcon } from './workspace-icons';
import { workspaceGroups, workspacePageLabel, workspaceReducer, workspaceTabTitle } from './workspace';
import { assignGroupColors, type GroupColor } from './tab-group-colors';
import { projectTabDrag, type DropPosition } from './tab-drag';

type PointerSession = {
  pointerId: number;
  key: string;
  tabId?: string;
  element: HTMLElement;
  x: number;
  y: number;
  scrollLeft: number;
};
const groupSelector = '.workspace-tab-unit';
type Landing = { order: string; positions: Map<string, number>; key: string };
const PresentationContext = createContext<{
  offsets: Record<string, number>;
  dragging: string | null;
  drop: DropPosition | null;
  colors: Map<string, GroupColor>;
  landing: Landing | null;
  landed(): void;
}>({ offsets: {}, dragging: null, drop: null, colors: new Map(), landing: null, landed() {} });

// Group captions sit above the real tabs, outside their selectable content.
// The Aria collection still contains only tabs, so arrow navigation skips captions.
const groupedRenderer: typeof DefaultCollectionRenderer = {
  ...DefaultCollectionRenderer,
  CollectionRoot({ collection }) {
    // Aria caches collection nodes. Transient drag presentation must update independently.
    const presentation = useContext(PresentationContext);
    const groups = new Map<string, (typeof collection extends Iterable<infer Node> ? Node : never)[]>();
    for (const node of collection) {
      const key = node.props['data-tab-group'];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node);
    }
    const elements = useRef(new Map<string, HTMLDivElement>());
    const order = JSON.stringify([...groups.keys()]);
    const landing = presentation.landing;
    const ready = landing?.order === order;
    // Measure in the collection's own commit. The parent workspace can render a
    // new order one commit before React Aria updates its cached collection.
    useLayoutEffect(() => {
      if (!landing || !ready) return;
      const animations = [...elements.current].flatMap(([key, element]) => {
        const before = landing.positions.get(key);
        const delta = before == null ? 0 : before - element.getBoundingClientRect().left;
        return Math.abs(delta) < 0.5 || window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? []
          : [
              element.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], {
                duration: 180,
                easing: 'cubic-bezier(.2, 0, 0, 1)',
                fill: 'both',
              }),
            ];
      });
      let cancelled = false;
      void Promise.all(animations.map(a => a.finished.catch(() => {}))).then(() => {
        if (!cancelled) presentation.landed();
      });
      return () => {
        cancelled = true;
        animations.forEach(a => a.cancel());
      };
    }, [landing, ready]);
    return (
      <>
        {[...groups].map(([key, nodes]) => {
          const first = nodes[0],
            grouped = Boolean(first.props['data-grouped']);
          return (
            <div
              key={key}
              className={'workspace-tab-unit' + (grouped ? ' workspace-tab-group' : '')}
              role="presentation"
              ref={element => {
                if (element) elements.current.set(key, element);
                else elements.current.delete(key);
              }}
              style={{
                transform: `translateX(${ready ? 0 : (presentation.offsets[key] ?? 0)}px)`,
                transition: landing ? 'none' : undefined,
              }}
              data-tab-group={key}
              data-group-color={presentation.colors.get(key)}
              data-dragging={(presentation.dragging ?? landing?.key) === key || undefined}
              data-drop-before={(presentation.drop?.key === key && presentation.drop.edge === 'before') || undefined}
              data-drop-after={(presentation.drop?.key === key && presentation.drop.edge === 'after') || undefined}
            >
              {grouped && (
                <div
                  className="workspace-group-heading"
                  aria-hidden="true"
                  data-tab-group={key}
                  title={appText('WorkspaceTabBar.dragGroup', { p0: first.props['data-group-title'] })}
                >
                  <WorkspaceGroupIcon sourceKey={key} />
                  <span>{first.props['data-group-title']}</span>
                </div>
              )}
              {grouped ? (
                <div className="workspace-group-tabs" role="presentation">
                  {nodes.map(node => (
                    <Fragment key={node.key}>{node.render?.(node)}</Fragment>
                  ))}
                </div>
              ) : (
                first.render?.(first)
              )}
            </div>
          );
        })}
      </>
    );
  },
};

export function WorkspaceTabBar() {
  const app = useApp();
  const groups = workspaceGroups(app.workspace.tabs.map(tab => ({ ...tab, title: workspaceTabTitle(tab) })));
  const colors = assignGroupColors(groups.filter(group => group.grouped).map(group => group.key));
  const viewport = useRef<HTMLDivElement>(null);
  const dragKey = useRef<string | null>(null),
    dragX = useRef<number | null>(null);
  const pointer = useRef<PointerSession | null>(null),
    suppressClickUntil = useRef(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPosition | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [landing, setLanding] = useState<Landing | null>(null);
  const isLanding = useRef(false);
  isLanding.current = !!landing;
  const landed = useCallback(() => {
    setLanding(null);
    setOffsets({});
  }, []);
  const [announcement, setAnnouncement] = useState('');
  const [overflow, setOverflow] = useState({ before: false, after: false });
  const measure = () => {
    const el = viewport.current;
    if (el) setOverflow({ before: el.scrollLeft > 1, after: el.scrollWidth - el.clientWidth - el.scrollLeft > 1 });
  };
  const groupElements = () => [...(viewport.current?.querySelectorAll<HTMLElement>(groupSelector) ?? [])];
  const groupBounds = () => {
    const el = viewport.current;
    if (!el) return [];
    const origin = el.getBoundingClientRect().left - el.scrollLeft;
    return groupElements().map(element => ({
      key: element.dataset.tabGroup!,
      left: origin + element.offsetLeft,
      right: origin + element.offsetLeft + element.offsetWidth,
    }));
  };
  const captureLayout = () =>
    new Map(groupElements().map(element => [element.dataset.tabGroup!, element.getBoundingClientRect().left]));
  const revealSelection = () => {
    const el = viewport.current;
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !tab || dragKey.current || isLanding.current) return;
    const outer = el.getBoundingClientRect(),
      member = tab.getBoundingClientRect();
    const group = groupBounds().find(group => group.key === tab.dataset.tabGroup);
    const inner = group && group.right - group.left <= outer.width ? group : member;
    if (inner.left < outer.left) el.scrollLeft -= outer.left - inner.left;
    else if (inner.right > outer.right) el.scrollLeft += inner.right - outer.right;
  };
  const markDrop = (position: DropPosition | null) =>
    setDrop(previous => (previous?.key === position?.key && previous?.edge === position?.edge ? previous : position));
  const previewDrag = (x: number, inside: boolean) => {
    const session = pointer.current;
    if (!session) return;
    const projection = inside ? projectTabDrag(groupBounds(), session.key, x) : { target: null, offsets: {} };
    markDrop(projection.target);
    setOffsets({
      ...projection.offsets,
      [session.key]: x - session.x + (viewport.current?.scrollLeft ?? 0) - session.scrollLeft,
    });
  };
  const endDrag = (moved = false) => {
    const session = pointer.current;
    if (dragKey.current) {
      suppressClickUntil.current = Date.now() + 400;
      if (!moved)
        setLanding({ order: JSON.stringify(groups.map(g => g.key)), positions: captureLayout(), key: dragKey.current });
    }
    pointer.current = null;
    dragKey.current = null;
    dragX.current = null;
    setDragging(null);
    setDrop(null);
    if (session && viewport.current?.hasPointerCapture(session.pointerId))
      viewport.current.releasePointerCapture(session.pointerId);
  };
  const move = (sourceKey: string, target: DropPosition) => {
    const reordered = workspaceReducer(app.workspace, {
      type: 'moveGroup',
      sourceKey,
      targetKey: target.key,
      edge: target.edge,
    });
    setLanding({
      order: JSON.stringify(workspaceGroups(reordered.tabs).map(g => g.key)),
      positions: captureLayout(),
      key: sourceKey,
    });
    app.moveGroup(sourceKey, target.key, target.edge);
    const source = groups.find(group => group.key === sourceKey),
      destination = groups.find(group => group.key === target.key);
    setAnnouncement(
      appText('WorkspaceTabBar.moved', {
        source: source?.title ?? '',
        target: destination?.title ?? '',
        position: target.edge,
      }),
    );
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (isLanding.current || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement>('[role="tab"], .workspace-group-heading');
    if (!element) return;
    // Capture on the stable viewport: collection items may update while a group moves.
    event.preventDefault();
    event.stopPropagation();
    pointer.current = {
      pointerId: event.pointerId,
      key: element.dataset.tabGroup!,
      tabId: element.dataset.tabId,
      element,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = pointer.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!dragKey.current && Math.hypot(event.clientX - session.x, event.clientY - session.y) < 6) return;
    if (!dragKey.current) {
      dragKey.current = session.key;
      setDragging(session.key);
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const inside = event.clientY >= rect.top && event.clientY <= rect.bottom;
    dragX.current = inside ? event.clientX : null;
    previewDrag(event.clientX, inside);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const session = pointer.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickUntil.current = Date.now() + 400;
    let moved = false;
    if (dragKey.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      const target = inside ? projectTabDrag(groupBounds(), session.key, event.clientX).target : null;
      if (target) {
        move(session.key, target);
        moved = true;
      }
    } else if (session.tabId) {
      app.activate(session.tabId);
      session.element.focus({ preventScroll: true });
    }
    endDrag(moved);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && pointer.current) {
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      return;
    }
    if (isLanding.current) return;
    if (!event.altKey || !event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    if (!(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLElement>('[role="tab"]');
    if (!tab) return;
    event.preventDefault();
    event.stopPropagation();
    const index = groups.findIndex(group => group.key === tab.dataset.tabGroup);
    const previous = event.key === 'ArrowLeft',
      target = groups[index + (previous ? -1 : 1)];
    if (target) move(groups[index].key, { key: target.key, edge: previous ? 'before' : 'after' });
  };
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      revealSelection();
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const tabOrder = app.workspace.tabs.map(tab => tab.id).join('|');
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      revealSelection();
      measure();
    });
    return () => cancelAnimationFrame(frame);
  }, [app.workspace.activeId, tabOrder]);
  useEffect(() => {
    if (!dragging) return;
    let frame: number;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        endDrag();
      }
    };
    window.addEventListener('keydown', cancel, true);
    const cancelDrag = () => endDrag();
    window.addEventListener('blur', cancelDrag);
    const scroll = () => {
      const el = viewport.current,
        x = dragX.current;
      if (el && x !== null) {
        const rect = el.getBoundingClientRect();
        const distance = x < rect.left + 32 ? -8 : x > rect.right - 32 ? 8 : 0;
        if (distance) {
          const before = el.scrollLeft;
          el.scrollLeft += distance;
          if (el.scrollLeft !== before) previewDrag(x, true);
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('blur', cancelDrag);
    };
  }, [dragging]);
  return (
    <div className="tab-strip">
      <div
        className="tab-viewport"
        ref={viewport}
        data-reordering={dragging ? true : undefined}
        onScroll={measure}
        onKeyDownCapture={onKeyDown}
        onPointerDownCapture={onPointerDown}
        onPointerMoveCapture={onPointerMove}
        onPointerUpCapture={onPointerUp}
        onPointerCancel={() => endDrag()}
        onLostPointerCapture={() => endDrag()}
        onClickCapture={event => {
          if (Date.now() < suppressClickUntil.current) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <PresentationContext.Provider value={{ offsets, dragging, drop, colors, landing, landed }}>
          <CollectionRendererContext.Provider value={groupedRenderer}>
            <TabList aria-label={appText('WorkspaceTabBar.workspaceTabs')} className="workspace-tab-list">
              {groups.flatMap(group =>
                group.tabs.map((tab, index) => {
                  const grouped = group.grouped;
                  const siblings = group.tabs.filter(member => workspacePageLabel(member) === workspacePageLabel(tab));
                  const label =
                    workspacePageLabel(tab) +
                    (siblings.length > 1 ? appText('WorkspaceTabBar.copy') + (siblings.indexOf(tab) + 1) : '');
                  const name = grouped ? `${group.title} · ${label}` : tab.title;
                  return (
                    <Tab
                      onContextMenu={event =>
                        openContextMenu(event, [
                          { id: 'activate', label: appText('ContextMenu.activate'), run: () => app.activate(tab.id) },
                          {
                            id: 'duplicate',
                            label: appText('LibraryPage.continueInANewTab'),
                            run: () =>
                              app.open({
                                ...tab,
                                id: crypto.randomUUID(),
                                state: { ...tab.state },
                                params: { ...tab.params, independent: true },
                              }),
                          },
                          {
                            id: 'close',
                            label: appText('context.closeTab'),
                            disabled: tab.id === 'home',
                            run: () => app.close(tab.id),
                          },
                          {
                            id: 'close-others',
                            label: appText('WorkspaceTabBar.closeOthers'),
                            run: () =>
                              app.workspace.tabs
                                .filter(t => t.id !== tab.id && t.id !== 'home')
                                .forEach(t => app.close(t.id)),
                          },
                          {
                            id: 'close-right',
                            label: appText('WorkspaceTabBar.closeRight'),
                            run: () =>
                              app.workspace.tabs
                                .slice(app.workspace.tabs.findIndex(t => t.id === tab.id) + 1)
                                .filter(t => t.id !== 'home')
                                .forEach(t => app.close(t.id)),
                          },
                          {
                            id: 'close-all',
                            label: appText('WorkspaceTabBar.closeAll'),
                            run: () => app.workspace.tabs.filter(t => t.id !== 'home').forEach(t => app.close(t.id)),
                          },
                        ])
                      }
                      id={tab.id}
                      key={tab.id}
                      className="workspace-tab"
                      aria-label={name + (tab.dirty ? appText('WorkspaceTabBar.unsaved') : '')}
                      data-tab-id={tab.id}
                      data-tab-group={group.key}
                      data-grouped={grouped || undefined}
                      data-group-start={index === 0 || undefined}
                      data-group-end={index === group.tabs.length - 1 || undefined}
                      data-group-title={grouped ? group.title : undefined}
                      data-group-active={
                        (grouped && group.tabs.some(member => member.id === app.workspace.activeId)) || undefined
                      }
                      data-group-color={colors.get(group.key)}
                    >
                      <span
                        className="workspace-tab-drag"
                        title={appText('WorkspaceTabBar.altShift', { name, dirty: !!tab.dirty, grouped })}
                      >
                        <WorkspaceIcon tab={tab} />
                        <span className="workspace-tab-title">{grouped ? label : tab.title}</span>
                        {tab.dirty && <span className="workspace-tab-dirty" aria-hidden="true" />}
                      </span>
                    </Tab>
                  );
                }),
              )}
            </TabList>
          </CollectionRendererContext.Provider>
        </PresentationContext.Provider>
      </div>
      <div className="tab-actions">
        {(overflow.before || overflow.after) && (
          <>
            <Button
              theme="borderless"
              icon={<IconChevronLeft />}
              aria-label={appText('WorkspaceTabBar.scrollTabsBackward')}
              title={appText('WorkspaceTabBar.scrollTabsBackward')}
              disabled={!overflow.before}
              onClick={() => viewport.current?.scrollBy({ left: -320, behavior: 'smooth' })}
            />
            <Button
              theme="borderless"
              icon={<IconChevronRight />}
              aria-label={appText('WorkspaceTabBar.scrollTabsForward')}
              title={appText('WorkspaceTabBar.scrollTabsForward')}
              disabled={!overflow.after}
              onClick={() => viewport.current?.scrollBy({ left: 320, behavior: 'smooth' })}
            />
          </>
        )}
        <Button
          theme="borderless"
          icon={<IconClose />}
          aria-label={appText('WorkspaceTabBar.closeCurrentTab')}
          title={appText('WorkspaceTabBar.closeCurrentTab')}
          disabled={app.workspace.activeId === 'home'}
          onClick={() => app.close(app.workspace.activeId)}
        />
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
