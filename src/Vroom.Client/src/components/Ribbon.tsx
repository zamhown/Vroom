import { useId, useLayoutEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActionButton, DialogTrigger, Popover, Text } from '@react-spectrum/s2';
import { Tab, TabList, TabPanel, Tabs, Toolbar } from 'react-aria-components';
import { IconChevronDown, IconChevronUp } from '../icons';
import { t } from '../i18n';
import { RibbonCommandContext } from './ribbon-context';
import { PageToolbar } from './page-toolbar-context';

export interface RibbonState {
  selected?: string;
  collapsed?: boolean;
}
export interface RibbonGroup {
  id: string;
  label: string;
  disabled?: boolean;
  content: ReactNode;
}
export interface RibbonTab {
  id: string;
  label: string;
  disabled?: boolean;
  groups: RibbonGroup[];
}

/** Resource-authored tasks; React Aria owns keyboard navigation and Spectrum owns commands and overlays. */
export function Ribbon({
  label,
  heading,
  context,
  tabs,
  state,
  onChange,
}: {
  label: string;
  heading?: ReactNode;
  context?: ReactNode;
  tabs: RibbonTab[];
  state?: RibbonState;
  onChange?(state: RibbonState): void;
}) {
  const [local, setLocal] = useState<RibbonState>({});
  const value = state ?? local;
  const selected =
    tabs.find(tab => tab.id === value.selected && !tab.disabled)?.id ?? tabs.find(tab => !tab.disabled)?.id;
  const change = (next: RibbonState) => {
    setLocal(next);
    onChange?.(next);
  };
  const panelId = useId();
  const panels = useRef<HTMLDivElement>(null);
  const collapseButton = useRef<ComponentRef<typeof ActionButton>>(null);
  const toggle = () => {
    const element = panels.current;
    if (!value.collapsed && element?.contains(element.ownerDocument.activeElement)) collapseButton.current?.focus();
    change({ selected, collapsed: !value.collapsed });
  };
  if (!tabs.length) return null;
  return (
    <PageToolbar>
      <section
        className="ribbon"
        data-collapsed={!!value.collapsed}
        aria-label={label}
        onKeyDown={event => {
          if (event.ctrlKey && event.key === 'F1') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <Tabs
          className="ribbon-body"
          selectedKey={selected}
          onSelectionChange={key => change({ selected: String(key), collapsed: false })}
        >
          <div className="ribbon-header">
            {heading && <div className="ribbon-heading">{heading}</div>}
            <div className="ribbon-tabs">
              <TabList aria-label={label} className="ribbon-tablist">
                {tabs.map(tab => (
                  <Tab key={tab.id} id={tab.id} isDisabled={tab.disabled} className="ribbon-tab">
                    {tab.label}
                  </Tab>
                ))}
              </TabList>
            </div>
            <div className="ribbon-utilities">
              {context && <div className="ribbon-context">{context}</div>}
              <ActionButton
                ref={collapseButton}
                size="S"
                isQuiet
                aria-label={t(value.collapsed ? 'Ribbon.expand' : 'Ribbon.collapse')}
                aria-expanded={!value.collapsed}
                aria-controls={panelId}
                onPress={toggle}
              >
                {value.collapsed ? <IconChevronDown /> : <IconChevronUp />}
              </ActionButton>
            </div>
          </div>
          <div ref={panels} id={panelId} hidden={value.collapsed}>
            {tabs.map(tab => (
              <TabPanel key={tab.id} id={tab.id} className="ribbon-panel">
                <RibbonCommands label={tab.label} groups={tab.groups} />
              </TabPanel>
            ))}
          </div>
        </Tabs>
      </section>
    </PageToolbar>
  );
}

function RibbonCommands({ label, groups }: { label: string; groups: RibbonGroup[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const [overflow, setOverflow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const items = [...element.querySelectorAll<HTMLElement>('.ribbon-group')];
    const measure = () => {
      if (!element.clientWidth) return;
      const style = getComputedStyle(element);
      let total = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const widths = items.map(item => {
        const spacing = getComputedStyle(item);
        total +=
          parseFloat(spacing.marginInlineStart) +
          parseFloat(spacing.paddingInlineStart) +
          parseFloat(spacing.borderInlineStartWidth);
        const inline = item.querySelector<HTMLElement>('.ribbon-inline-content')!.getBoundingClientRect().width;
        const menu = item.querySelector<HTMLElement>('.ribbon-group-compact button')!.getBoundingClientRect().width;
        total += inline;
        return { inline, menu };
      });
      const next: string[] = [];
      // Preserve earlier, more prominent groups while later groups fit into named menus.
      for (let i = items.length - 1; i >= 0 && total > element.clientWidth; i--) {
        if (widths[i].menu >= widths[i].inline) continue;
        total -= widths[i].inline - widths[i].menu;
        next.push(groups[i].id);
      }
      setCompact(previous => (previous.join('\0') === next.join('\0') ? previous : next));
      const needsMenu = total > element.clientWidth;
      setOverflow(needsMenu);
      setOpen(previous => (!needsMenu && previous && next.includes(previous) ? previous : undefined));
      setOverflowOpen(previous => needsMenu && previous);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const item of items) {
      observer.observe(item.querySelector('.ribbon-inline-content')!);
      observer.observe(item.querySelector('.ribbon-group-compact button')!);
    }
    measure();
    return () => observer.disconnect();
  }, [groups]);
  return (
    <Toolbar
      ref={row}
      aria-label={label}
      className="ribbon-groups"
      data-compact-all={overflow || groups.every(group => compact.includes(group.id))}
      data-overflow={overflow}
    >
      {groups.map(group => {
        const collapsed = compact.includes(group.id);
        return (
          <div
            key={group.id}
            className="ribbon-group"
            role="group"
            aria-label={group.label}
            aria-hidden={overflow || undefined}
            inert={overflow}
          >
            <div
              className="ribbon-group-inline"
              data-hidden={collapsed}
              aria-hidden={collapsed || undefined}
              inert={collapsed || group.disabled}
            >
              <div className="ribbon-inline-content">
                <span className="ribbon-group-label">{group.label}</span>
                <RibbonCommandContext.Provider value>
                  <div className="ribbon-commands">{group.content}</div>
                </RibbonCommandContext.Provider>
              </div>
            </div>
            <div
              className="ribbon-group-compact"
              data-hidden={!collapsed}
              aria-hidden={!collapsed || undefined}
              inert={!collapsed}
            >
              <DialogTrigger
                isOpen={collapsed && open === group.id}
                onOpenChange={value => setOpen(value ? group.id : undefined)}
              >
                <ActionButton size="M" isDisabled={group.disabled}>
                  <IconChevronDown />
                  <Text>{group.label}</Text>
                </ActionButton>
                <Popover aria-label={group.label} placement="bottom start" UNSAFE_className="ribbon-popover">
                  <div className="ribbon-popover-heading">{group.label}</div>
                  <RibbonCommandContext.Provider value>
                    <div className="ribbon-commands">{group.content}</div>
                  </RibbonCommandContext.Provider>
                </Popover>
              </DialogTrigger>
            </div>
          </div>
        );
      })}
      {overflow && (
        <DialogTrigger isOpen={overflowOpen} onOpenChange={setOverflowOpen}>
          <ActionButton size="M">
            <IconChevronDown />
            <Text>{t('Ribbon.commands')}</Text>
          </ActionButton>
          <Popover
            aria-label={label}
            placement="bottom start"
            UNSAFE_className="ribbon-popover ribbon-overflow-popover"
          >
            {groups.map(group => (
              <div
                key={group.id}
                className="ribbon-menu-group"
                role="group"
                aria-label={group.label}
                inert={group.disabled}
              >
                <div className="ribbon-popover-heading">{group.label}</div>
                <RibbonCommandContext.Provider value>
                  <div className="ribbon-commands">{group.content}</div>
                </RibbonCommandContext.Provider>
              </div>
            ))}
          </Popover>
        </DialogTrigger>
      )}
    </Toolbar>
  );
}
