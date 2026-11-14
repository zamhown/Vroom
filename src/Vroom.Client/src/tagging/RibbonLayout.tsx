import type { ReactNode } from 'react';
import { Ribbon, type RibbonState } from '../components/Ribbon';
import type { LayoutNode, LocalizedText } from './types';

export function RibbonLayout({
  node,
  text,
  action,
  control,
  heading,
  context,
  state,
  onChange,
  visible = () => true,
  disabled = () => false,
}: {
  node: LayoutNode;
  text(value?: LocalizedText): string;
  action(key: string): ReactNode;
  control?(binding: string): ReactNode;
  heading?: ReactNode;
  context?: ReactNode;
  state?: RibbonState;
  onChange?(state: RibbonState): void;
  visible?(node: LayoutNode): boolean;
  disabled?(node: LayoutNode): boolean;
}) {
  return (
    <Ribbon
      label={text(node.title)}
      heading={heading}
      context={context}
      state={state}
      onChange={onChange}
      tabs={(node.children ?? []).filter(visible).map(tab => ({
        id: tab.id,
        label: text(tab.title),
        disabled: disabled(tab),
        groups: (tab.children ?? []).filter(visible).map(group => ({
          id: group.id,
          label: text(group.title),
          disabled: disabled(group),
          content: (group.children ?? []).filter(visible).map(item => (
            <div key={item.id} className="ribbon-item" inert={disabled(item)}>
              {item.type === 'control' ? control?.(item.binding) : item.actions?.map(action)}
            </div>
          )),
        })),
      }))}
    />
  );
}
