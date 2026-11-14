import { t as appText } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActionButton, DialogTrigger, Text, Tooltip, TooltipTrigger } from '@react-spectrum/s2';
import { Dialog, Popover } from 'react-aria-components';
import { IconChevronLeft, IconChevronRight, IconClose } from './icons';
import { Button } from './ui';

export type NavigationItem = {
  id: string;
  label: string;
  icon: ReactNode;
  onPress(): void;
  selected?: boolean;
  count?: number;
  render?: (close: () => void) => ReactNode;
};

export type NavigationSection = {
  id: string;
  label: string;
  icon: ReactNode;
  items: NavigationItem[];
  actions?: NavigationItem[];
};

function NavigationRow({ item, close }: { item: NavigationItem; close(): void }) {
  if (item.render)
    return (
      <div data-context-resource="" className="nav-custom-item">
        {item.render(close)}
      </div>
    );
  return (
    <ActionButton
      data-context-resource=""
      aria-label={item.label}
      aria-current={item.selected ? 'page' : undefined}
      isQuiet
      size="S"
      UNSAFE_className={'nav-item' + (item.selected ? ' is-current' : '')}
      onPress={() => {
        close();
        item.onPress();
      }}
    >
      {item.icon}
      <Text>{item.label}</Text>
      {item.count != null && <span className="nav-count">{item.count}</span>}
    </ActionButton>
  );
}

// Navigation is presentation-only: callers supply all entries, grouping and commands.
export function WorkspaceNavigation({ sections, tools }: { sections: NavigationSection[]; tools: NavigationItem[] }) {
  const [compact, setCompact] = useState(() => localStorage.getItem('vroom.navigation') === 'compact');
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggleCompact = () => {
    const next = !compact;
    setCompact(next);
    setExpanded(null);
    localStorage.setItem('vroom.navigation', next ? 'compact' : 'labeled');
  };
  const rail = useRef<HTMLElement>(null),
    panel = useRef<HTMLElement>(null);
  // Non-modal panels leave the rail interactive; also dismiss on presses in the workspace.
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rail.current?.contains(target) && !panel.current?.contains(target))
        setExpanded(null);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [expanded]);
  return (
    <aside className={'sidebar' + (compact ? ' is-compact' : ' is-labeled')} ref={rail}>
      <nav className="nav-rail-main" aria-label={appText('WorkspaceNavigation.mainNavigation')}>
        {sections.map(section => {
          const active = [...section.items, ...(section.actions ?? [])].some(item => item.selected);
          return (
            <DialogTrigger
              key={section.id}
              isOpen={expanded === section.id}
              onOpenChange={open => setExpanded(open ? section.id : null)}
            >
              <TooltipTrigger delay={400} placement="right" isDisabled={!compact || expanded === section.id}>
                <ActionButton
                  aria-label={section.label}
                  aria-current={active ? true : undefined}
                  isQuiet
                  UNSAFE_className={'rail-item' + (active || expanded === section.id ? ' is-current' : '')}
                >
                  {section.icon}
                  {!compact && <Text>{section.label}</Text>}
                </ActionButton>
                <Tooltip>{section.label}</Tooltip>
              </TooltipTrigger>
              <Popover
                ref={panel}
                placement="right top"
                offset={12}
                containerPadding={8}
                isNonModal
                className="nav-popover"
              >
                <Dialog aria-label={section.label} className="nav-panel">
                  {({ close }) => (
                    <>
                      <div className="nav-panel-heading">
                        <h2>{section.label}</h2>
                        <Button
                          theme="borderless"
                          icon={<IconClose />}
                          aria-label={appText('WorkspaceNavigation.collapseNavigation')}
                          onClick={close}
                        />
                      </div>
                      {section.items.length > 0 && (
                        <div className="nav-panel-list">
                          {section.items.map(item => (
                            <NavigationRow key={item.id} item={item} close={close} />
                          ))}
                        </div>
                      )}
                      {!!section.actions?.length && (
                        <div className="nav-panel-actions">
                          {section.actions.map(item => (
                            <NavigationRow key={item.id} item={item} close={close} />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </Dialog>
              </Popover>
            </DialogTrigger>
          );
        })}
      </nav>
      <nav className="nav-rail-tools" aria-label={appText('WorkspaceNavigation.tools')}>
        {tools.map(item => (
          <TooltipTrigger key={item.id} delay={400} placement="right" isDisabled={!compact}>
            <ActionButton
              data-context-resource=""
              aria-label={item.label}
              aria-current={item.selected ? 'page' : undefined}
              isQuiet
              UNSAFE_className={'rail-item' + (item.selected ? ' is-current' : '')}
              onPress={() => {
                setExpanded(null);
                item.onPress();
              }}
            >
              {item.icon}
              {!compact && <Text>{item.label}</Text>}
              {item.count != null && <span className="rail-count">{item.count > 99 ? '99+' : item.count}</span>}
            </ActionButton>
            <Tooltip>{item.label}</Tooltip>
          </TooltipTrigger>
        ))}
        <TooltipTrigger delay={400} placement="right" isDisabled={!compact}>
          <ActionButton
            aria-label={appText(compact ? 'Journey.expandNavigation' : 'Journey.collapseNavigation')}
            aria-expanded={!compact}
            isQuiet
            UNSAFE_className="rail-item rail-collapse"
            onPress={toggleCompact}
          >
            {compact ? <IconChevronRight /> : <IconChevronLeft />}
            {!compact && <Text>{appText('Journey.collapseNavigation')}</Text>}
          </ActionButton>
          <Tooltip>{appText('Journey.expandNavigation')}</Tooltip>
        </TooltipTrigger>
      </nav>
    </aside>
  );
}
