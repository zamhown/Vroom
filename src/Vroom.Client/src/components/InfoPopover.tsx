import { useState, type ReactNode } from 'react';
import { ActionButton } from '@react-spectrum/s2';
import { Popover, PreviewTrigger } from 'react-aria-components';
import { IconInfo } from '../icons';

/** The same quiet information surface on hover, keyboard focus and click. */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <PreviewTrigger isOpen={open} onOpenChange={setOpen} delay={350} closeDelay={200}>
      <ActionButton
        size="S"
        isQuiet
        onPress={() => setOpen(true)}
        aria-label={label}
        UNSAFE_className="schema-field-info"
      >
        <IconInfo size="small" />
      </ActionButton>
      <Popover placement="bottom start" aria-label={label} className="schema-field-popover">
        {children}
      </Popover>
    </PreviewTrigger>
  );
}
