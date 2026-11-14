import { Select } from '../ui';
import { useApp } from '../context';
import { SchemaIcon } from '../icon-catalog';
import { localize } from '../tagging/i18n';
import registry from '../../../../resources/tagging/host-capabilities.json';

/** Search accepts localized names and the stable identifier stored in the schema. */
export function IconPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value?: string;
  onChange(value: string): void;
  label: string;
  disabled?: boolean;
}) {
  const { locale, data } = useApp();
  return (
    <div className="icon-picker">
      <span className="icon-picker-selected" aria-hidden="true">
        <SchemaIcon name={value} />
      </span>
      <Select
        filter
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={v => onChange(String(v))}
        optionList={Object.entries(registry.icons).map(([value, text]) => ({
          value,
          label: `${localize(text, locale, data.tagging.package)} (${value})`,
          icon: <SchemaIcon name={value} />,
        }))}
      />
    </div>
  );
}
