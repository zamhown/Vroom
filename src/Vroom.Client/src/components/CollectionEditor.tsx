import { type ReactNode } from 'react';
import { Button } from '../ui';
import { IconEdit } from '../icons';
import { FormRemoveAction } from './FormLayout';

export interface CollectionColumn<T> {
  id: string;
  title: string;
  wide?: boolean;
  width?: number | string;
  render(item: T): ReactNode;
}

/** Comparable summaries stay in the collection; full forms belong to an item's editor. */
export function CollectionEditor<T extends { id: string }>({
  label,
  title,
  count,
  items,
  columns,
  actions,
  actionsLabel,
  emptyText,
  editLabel,
  removeLabel,
  onEdit,
  onRemove,
}: {
  label: string;
  title: ReactNode;
  count: string;
  items: T[];
  columns: CollectionColumn<T>[];
  actions?: ReactNode;
  actionsLabel: string;
  emptyText: string;
  editLabel(item: T): string;
  removeLabel?(item: T): string;
  onEdit(item: T): void;
  onRemove?(item: T): void;
}) {
  return (
    <section className="collection-editor" aria-label={label}>
      <header className="collection-editor-toolbar">
        <div className="collection-editor-title">
          <span>{title}</span>
          <small>{count}</small>
        </div>
        {actions && <div className="collection-editor-actions">{actions}</div>}
      </header>
      {items.length ? (
        <div className="collection-editor-content">
          <table className="collection-editor-table" aria-label={label}>
            <thead>
              <tr>
                {columns.map(column => (
                  <th key={column.id} scope="col" style={column.width ? { width: column.width } : undefined}>
                    {column.title}
                  </th>
                ))}
                <th scope="col" className="collection-editor-row-actions">
                  <span className="visually-hidden">{actionsLabel}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  {columns.map((column, index) => (
                    <td
                      key={column.id}
                      data-label={column.title}
                      data-primary={index === 0 || undefined}
                      data-wide={column.wide || undefined}
                    >
                      <span className="collection-editor-cell">{column.render(item)}</span>
                    </td>
                  ))}
                  <td className="collection-editor-row-actions">
                    <div>
                      <Button
                        theme="borderless"
                        size="S"
                        icon={<IconEdit />}
                        aria-label={editLabel(item)}
                        title={editLabel(item)}
                        onClick={() => onEdit(item)}
                      />
                      {onRemove && removeLabel && (
                        <FormRemoveAction label={removeLabel(item)} onRemove={() => onRemove(item)} />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="form-help collection-editor-empty">{emptyText}</p>
      )}
    </section>
  );
}
