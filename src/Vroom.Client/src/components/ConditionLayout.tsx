import { createContext, useContext, useId, type ReactNode } from 'react';

const ConditionDepth = createContext(0);

/** Shared visual grammar; query predicates and automation expressions keep their own contracts. */
export function ConditionGroup({
  title,
  children,
  controls,
  actions,
  footer,
  root = false,
}: {
  title: string;
  children: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  root?: boolean;
}) {
  const id = useId();
  const inheritedDepth = useContext(ConditionDepth),
    depth = root ? 0 : inheritedDepth;
  return (
    <section
      className={'query-group' + (root ? ' query-root' : '')}
      data-depth={depth}
      data-tone={depth % 2 === 0 ? 'blue' : 'purple'}
      aria-labelledby={id}
    >
      <header className="query-group-heading">
        <span id={id}>{title}</span>
        {controls}
        <span className="grow" />
        {actions}
      </header>
      <ConditionDepth.Provider value={depth + 1}>
        <div className="query-group-body">{children}</div>
      </ConditionDepth.Provider>
      {footer && <footer className="query-group-actions">{footer}</footer>}
    </section>
  );
}

export function ConditionBranch({ connector, children }: { connector?: string; children: ReactNode }) {
  return (
    <div className="query-branch">
      {connector && (
        <div className="query-connector">
          <span>{connector}</span>
        </div>
      )}
      {children}
    </div>
  );
}

export function ConditionRow({
  children,
  actions,
  details,
}: {
  children: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
}) {
  return (
    <div className="query-condition">
      <div className="condition-row">
        {children}
        {actions}
      </div>
      {details}
    </div>
  );
}
