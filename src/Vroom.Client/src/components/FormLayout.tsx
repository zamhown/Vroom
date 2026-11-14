import { useId, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../ui';
import { IconClose } from '../icons';

/** A field owns its control, help and local actions. Controls retain their own accessible names. */
export function FormField({
  label,
  children,
  description,
  actions,
  trailingActions,
  depth = 0,
  layout = 'stack',
  className = '',
}: {
  label: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  trailingActions?: ReactNode;
  depth?: number;
  layout?: 'stack' | 'row';
  className?: string;
}) {
  const id = useId();
  return (
    <div
      className={`form-field form-field-${layout} ${className}`}
      style={depth ? ({ '--form-depth': depth } as CSSProperties) : undefined}
      role="group"
      aria-labelledby={id}
      aria-describedby={description ? id + '-help' : undefined}
    >
      <div className="form-field-label" id={id}>
        {label}
      </div>
      <div className="form-field-body">
        {trailingActions ? (
          <div className="form-field-control-row">
            <div className="form-field-control">{children}</div>
            <div className="form-field-trailing-actions">{trailingActions}</div>
          </div>
        ) : (
          children
        )}
        {description && (
          <p className="form-help" id={id + '-help'}>
            {description}
          </p>
        )}
        {actions && <div className="form-field-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Objects keep the same control column as their siblings; only their labels are indented. */
export function FormGroup({
  title,
  children,
  actions,
  depth = 0,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  depth?: number;
}) {
  const id = useId();
  return (
    <section
      className="form-group"
      role="group"
      aria-labelledby={id}
      style={{ '--form-depth': depth } as CSSProperties}
    >
      <header className="form-group-heading">
        <span id={id}>{title}</span>
        {actions && <div className="form-group-actions">{actions}</div>}
      </header>
      <div className="form-group-body">{children}</div>
    </section>
  );
}

export function FormRemoveAction({ label, onRemove }: { label: string; onRemove(): void }) {
  return (
    <Button theme="borderless" size="S" icon={<IconClose />} aria-label={label} title={label} onClick={onRemove} />
  );
}

export function FormLayout({
  children,
  className = '',
  compact = false,
}: {
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return <div className={'form-layout ' + (compact ? 'form-layout-compact ' : '') + className}>{children}</div>;
}

export function FormSection({
  title,
  children,
  description,
}: {
  title: ReactNode;
  children: ReactNode;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="form-section" aria-labelledby={id}>
      <header className="form-section-heading">
        <h3 id={id}>{title}</h3>
        {description && <p className="form-help">{description}</p>}
      </header>
      <div className="form-section-body">{children}</div>
    </section>
  );
}
