import { openTermProfile } from './field-links';
import { t as appText } from '../i18n';
import { parseDate } from '@internationalized/date';
import { useState } from 'react';
import { Slider, SliderTrack, SliderThumb } from 'react-aria-components';
import { DatePicker, FileTrigger, ActionButton, Slider as SpectrumSlider } from '@react-spectrum/s2';
import { Input, InputNumber, Space, Switch, TextArea } from '../ui';
import { SchemaIcon } from '../icon-catalog';
export { SchemaIcon } from '../icon-catalog';
import { TagSelect } from '../components/TagSelect';
import { call } from '../api';
import { action, useApp } from '../context';
import type { ComponentSpec, Definition, Json, TagPackage } from './types';
import { formatValue, localize, ui, termOptions } from './i18n';

export function Stars({
  value,
  maximum = 10,
  symbols = 5,
  label,
  onChange,
  disabled,
}: {
  value: number;
  maximum?: number;
  symbols?: number;
  label: string;
  onChange?: (value: number) => void;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<number | undefined>();
  const shown = preview ?? value;
  const stars = (
    <span className="rating-stars" aria-hidden="true">
      <span className="rating-stars-empty">{'☆'.repeat(symbols)}</span>
      <span
        className="rating-stars-filled"
        style={{ width: `${Math.min(100, Math.max(0, (shown / maximum) * 100))}%` }}
      >
        {'★'.repeat(symbols)}
      </span>
    </span>
  );
  if (!onChange)
    return (
      <span className="rating-value" aria-label={label} title={label}>
        {stars}
      </span>
    );
  return (
    <Slider
      className="rating-input"
      aria-label={label}
      minValue={1}
      maxValue={maximum}
      step={1}
      value={shown || 1}
      onChange={v => setPreview(Number(v))}
      onChangeEnd={v => {
        setPreview(undefined);
        onChange(Number(v));
      }}
      isDisabled={disabled}
    >
      <SliderTrack>
        {stars}
        <SliderThumb aria-label={label} />
      </SliderTrack>
      <span className="rating-number">
        {shown || '—'} / {maximum}
      </span>
    </Slider>
  );
}
export function TagValue({
  definition: d,
  value,
  spec,
  catalog,
}: {
  definition: Definition;
  value: Json | undefined;
  spec?: ComponentSpec;
  catalog?: TagPackage;
}) {
  const app = useApp();
  const pack = catalog ?? app.data.tagging.package;
  const t = (v: any) => localize(v, app.locale, pack);
  spec ??= d.display?.default;
  const props = spec?.props ?? {};
  const component = spec?.component;
  if (value == null) return <span className="muted">{t(props.emptyText) || '—'}</span>;
  if (component === 'rating-display@1')
    return (
      <span className="rating-output">
        <Stars
          value={Number(value)}
          maximum={Number(d.value.schema.maximum ?? 10)}
          symbols={Number(props.maxSymbols ?? 5)}
          label={`${t(d.label)} ${value}`}
        />
        {props.showValue && (
          <span>
            {String(value)} / {d.value.schema.maximum ?? 10}
          </span>
        )}
      </span>
    );
  if (component === 'boolean-label@1')
    return <span>{t(value ? props.trueLabel : props.falseLabel) || formatValue(d, value, app.locale, pack)}</span>;
  if (component === 'icon-toggle@1')
    return (
      <span title={t(value ? props.trueLabel : props.falseLabel)}>
        <SchemaIcon name={value ? props.trueIcon : props.falseIcon} />
      </span>
    );
  return (
    <span>
      {formatValue(d, value, app.locale, pack)}
      {t(props.suffix)}
    </span>
  );
}
export function TagInput({
  definition: d,
  value,
  onChange,
  disabled = false,
  compact = false,
  allowCreate = true,
  showState = false,
  catalog,
}: {
  definition: Definition;
  value: Json | undefined;
  onChange(value: Json): void;
  disabled?: boolean;
  compact?: boolean;
  allowCreate?: boolean;
  showState?: boolean;
  catalog?: TagPackage;
}) {
  const app = useApp();
  const pack = catalog ?? app.data.tagging.package;
  const t = (v: any) => localize(v, app.locale, pack);
  const label = t(d.label);
  const schema = d.value.schema;
  const props = { ...d.input.props, ...(compact ? d.input.compact : {}) };
  const component = d.input.component;
  const options = termOptions(d, pack);
  if (component === 'date@1') {
    let date = null;
    try {
      if (value) date = parseDate(String(value));
    } catch {
      /* Incomplete values remain invalid until a valid date is entered. */
    }
    return (
      <DatePicker
        aria-label={label}
        value={date}
        onChange={v => onChange(v?.toString() ?? null)}
        isDisabled={disabled}
        granularity="day"
        UNSAFE_className="schema-date-input"
      />
    );
  }
  if (component === 'asset@1')
    return (
      <Space className="schema-asset-input">
        <Input size="M" aria-label={label} value={String(value ?? '')} disabled={disabled} onChange={onChange} />
        <FileTrigger
          acceptedFileTypes={['image/png', 'image/jpeg', 'image/webp', 'image/gif']}
          onSelect={files => {
            const file = files?.[0];
            if (file)
              action(async () => {
                if (file.size > 10 * 1024 * 1024) throw new Error(appText('editor.imageTooLarge'));
                const bytes = new Uint8Array(await file.arrayBuffer());
                let binary = '';
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                const result = await call<{ value: string }>('assets.import', { base64: btoa(binary) });
                onChange(result.value);
              });
          }}
        >
          <ActionButton isDisabled={disabled || !allowCreate}>{ui('import', app.locale)}</ActionButton>
        </FileTrigger>
      </Space>
    );
  if (component === 'rating@1')
    return (
      <Stars
        value={Number(value ?? 0)}
        maximum={Number(schema.maximum ?? 10)}
        symbols={Number(props.maxSymbols ?? (compact ? 5 : 10))}
        label={label}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (component === 'toggle@1')
    return (
      <span className="schema-toggle-state">
        <Switch aria-label={label} checked={Boolean(value)} disabled={disabled} onChange={onChange} />
        {showState && (
          <span>
            {value == null
              ? appText('Inputs.unset')
              : t(value ? props.trueLabel : props.falseLabel) || ui(value ? 'yes' : 'no', app.locale)}
          </span>
        )}
      </span>
    );
  if (component === 'number@1')
    return (
      <InputNumber
        size="M"
        aria-label={label}
        value={value == null ? null : Number(value)}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.multipleOf ?? props.step ?? (schema.type === 'integer' ? 1 : undefined)}
        disabled={disabled}
        onChange={v => onChange(Number.isNaN(v) ? null : v)}
      />
    );
  if (component === 'slider@1')
    return (
      <SpectrumSlider
        aria-label={label}
        minValue={schema.minimum ?? props.min ?? 0}
        maxValue={schema.maximum ?? props.max ?? 100}
        step={schema.multipleOf ?? props.step ?? 1}
        value={Number(value ?? schema.minimum ?? 0)}
        onChange={onChange}
        isDisabled={disabled}
      />
    );
  if (component === 'select@1' || component === 'multi-select@1') {
    const optionId = (v: Json | undefined): string =>
      v && typeof v === 'object' && !Array.isArray(v) ? String(v.term ?? '') : String(v ?? '');
    const selected = (Array.isArray(value) ? value : value == null ? [] : [value]).map(
      v => options.find(o => JSON.stringify(o.value) === JSON.stringify(v))?.id ?? optionId(v),
    );
    return (
      <TagSelect<Json>
        label={label}
        disabled={disabled}
        value={selected}
        multiple={component === 'multi-select@1'}
        onOpenOption={
          !catalog && allowCreate && d.value.vocabulary
            ? id => openTermProfile(app, id, d.value.vocabulary!)
            : undefined
        }
        options={options.map(o => ({ id: o.id, label: t(o.label), value: o.value ?? o.id, keywords: o.keywords }))}
        placeholder={
          t(props.placeholder) ||
          ui(d.writes?.createTerms && allowCreate ? 'selectOrCreate' : 'selectSearch', app.locale)
        }
        emptyText={ui('noOptions', app.locale)}
        createLabel={name => ui('createOption', app.locale, { name })}
        onChange={items =>
          onChange(d.value.cardinality === 'many' ? items.map(item => item.value) : (items[0]?.value ?? null))
        }
        onCreate={
          d.writes?.createTerms && allowCreate
            ? async name => {
                const r = await call<{ key: string; value: Json }>('tag.options.create', {
                  tagKey: d.key,
                  name,
                  expectedGeneration: app.data.tagging.generation,
                });
                await app.refresh();
                return { id: r.key, label: name, value: r.value };
              }
            : undefined
        }
      />
    );
  }
  const inputProps = {
    size: 'M' as const,
    'aria-label': label,
    value: value == null ? '' : String(value),
    disabled,
    onChange: (v: string) => onChange(v),
    placeholder: t(props.placeholder),
  };
  return component === 'textarea@1' ? <TextArea {...inputProps} rows={props.rows ?? 3} /> : <Input {...inputProps} />;
}
