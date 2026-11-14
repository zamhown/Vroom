import { t as appText } from '../i18n';
import { IconDelete, IconPlus } from '../icons';
import { Button, Input } from '../ui';

/** One editable row per path, with remove and add; replaces newline-separated text areas. */
export function PathListEditor({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder?: string;
  onChange(value: string[]): void;
}) {
  const rows = value.length ? value : [''];
  return (
    <div className="path-list">
      {rows.map((path, index) => (
        <div className="path-list-row" key={index}>
          <Input
            aria-label={appText('PathListEditor.item', { label, index: index + 1 })}
            value={path}
            placeholder={index === 0 ? placeholder : undefined}
            onChange={next => onChange(rows.map((item, i) => (i === index ? next : item)))}
          />
          <Button
            theme="borderless"
            icon={<IconDelete />}
            aria-label={appText('PathListEditor.remove', { path: path || index + 1 })}
            disabled={rows.length === 1 && !path}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button size="S" theme="borderless" icon={<IconPlus />} onClick={() => onChange([...rows, ''])}>
        {appText('PathListEditor.add')}
      </Button>
    </div>
  );
}
