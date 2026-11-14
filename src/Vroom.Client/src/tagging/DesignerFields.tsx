import { IconPicker } from '../components/IconPicker';
import { t as appText, translate } from '../i18n';
import { useState, type ReactNode } from 'react';
import { Checkbox } from '@react-spectrum/s2';
import { Button, Input, InputNumber, Select, TextArea } from '../ui';
import { FormField, FormGroup, FormLayout, FormRemoveAction } from '../components/FormLayout';
import { IconClose, IconPlus } from '../icons';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { useApp } from '../context';
import { configFieldLabel, configEnumLabel } from './config-editor';
import registry from '../../../../resources/tagging/host-capabilities.json';

export function DesignerField({
  label,
  help,
  children,
  wide,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <FormField className={wide ? 'designer-field-wide' : ''} label={label} description={help}>
      {children}
    </FormField>
  );
}
export function PrimitiveValue({
  value,
  onChange,
  label,
  depth = 0,
}: {
  value: any;
  onChange(value: any): void;
  label: string;
  depth?: number;
}) {
  const { locale } = useApp(),
    tr = (key: string) => translate(key, locale);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const compound = kind === 'array' || kind === 'object';
  return (
    <div className="literal-editor">
      <div className="literal-value">
        <FormField label={tr('DesignerFields.type')}>
          <Select
            aria-label={label + ' · ' + tr('DesignerFields.type')}
            value={kind}
            optionList={['string', 'number', 'boolean', 'null', 'array', 'object'].map(value => ({
              value,
              label: configEnumLabel(value, locale),
            }))}
            onChange={v =>
              onChange(
                v === 'number'
                  ? 0
                  : v === 'boolean'
                    ? false
                    : v === 'null'
                      ? null
                      : v === 'array'
                        ? []
                        : v === 'object'
                          ? {}
                          : '',
              )
            }
          />
        </FormField>
        <FormField label={tr('DesignerFields.value')}>
          {kind === 'number' ? (
            <InputNumber aria-label={label} value={value} onChange={n => onChange(Number.isFinite(n) ? n : null)} />
          ) : kind === 'boolean' ? (
            <Checkbox isSelected={value} onChange={onChange}>
              {tr('DesignerFields.yes')}
            </Checkbox>
          ) : kind === 'null' ? (
            <span className="muted">{tr('DesignerFields.null')}</span>
          ) : kind === 'string' ? (
            <Input aria-label={label} value={value} onChange={onChange} />
          ) : (
            <span className="muted">
              {Object.keys(value).length} {tr('DesignerFields.items')}
            </span>
          )}
        </FormField>
      </div>
      {compound && depth < 23 && (
        <div className="expression-arguments">
          {Object.entries(value).map(([key, item]) => (
            <div className="expression-argument" key={key}>
              <div className="parameter-label">
                {kind === 'object' ? (
                  <PropertyName
                    name={key}
                    names={Object.keys(value)}
                    onChange={name =>
                      onChange(Object.fromEntries(Object.entries(value).map(([k, v]) => [k === key ? name : k, v])))
                    }
                  />
                ) : (
                  <span>{Number(key) + 1}</span>
                )}
                <Button
                  theme="borderless"
                  size="S"
                  onClick={() =>
                    onChange(
                      kind === 'array'
                        ? value.filter((_: any, i: number) => i !== Number(key))
                        : Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)),
                    )
                  }
                >
                  {tr('DesignerFields.remove')}
                </Button>
              </div>
              <PrimitiveValue
                value={item}
                onChange={next =>
                  onChange(
                    kind === 'array'
                      ? value.map((v: any, i: number) => (i === Number(key) ? next : v))
                      : { ...value, [key]: next },
                  )
                }
                label={label + ' ' + key}
                depth={depth + 1}
              />
            </div>
          ))}
          <Button
            theme="borderless"
            size="S"
            onClick={() => {
              if (kind === 'array') onChange([...value, '']);
              else {
                let n = 1;
                while (Object.hasOwn(value, 'property' + n)) n++;
                onChange({ ...value, ['property' + n]: '' });
              }
            }}
          >
            {tr('DesignerFields.addItem')}
          </Button>
        </div>
      )}
    </div>
  );
}
/** Registered parameters retain their object groups and align leaf fields with their actions. */
export function ComponentParameters({
  component,
  value = {},
  onChange,
}: {
  component: string;
  value?: Record<string, any>;
  onChange(value: Record<string, any>): void;
}) {
  const { locale } = useApp(),
    tr = (key: string) => translate(key, locale);
  const schema = (registry.$defs as Record<string, any>)['components.' + component];
  return schema ? (
    <ParameterFields schema={schema} value={value} onChange={onChange} label={tr('DesignerFields.controlDetails')} />
  ) : null;
}
/** Input and display controls share one property sheet rather than nesting a second label column. */
export function ComponentSettings({
  label,
  selector,
  description,
  notes,
  component,
  value,
  onChange,
}: {
  label: string;
  selector: ReactNode;
  description?: string;
  notes?: ReactNode;
  component: string;
  value?: Record<string, any>;
  onChange(value: Record<string, any>): void;
}) {
  return (
    <FormLayout compact className="component-settings">
      <FormField layout="row" label={label} description={description} actions={notes}>
        {selector}
      </FormField>
      <ComponentParameters component={component} value={value} onChange={onChange} />
    </FormLayout>
  );
}
function ParameterFields({
  schema,
  value,
  onChange,
  label,
  depth = 0,
}: {
  schema: any;
  value: Record<string, any>;
  onChange(value: Record<string, any>): void;
  label: string;
  depth?: number;
}) {
  const app = useApp(),
    { locale } = app,
    defaultLocale = app.data.tagging.package.i18n.defaultLocale,
    tr = (key: string) => translate(key, locale),
    [adding, setAdding] = useState(false);
  const properties = schema.properties ?? {},
    optional = Object.keys(properties).filter(k => !Object.hasOwn(value, k));
  const orderedKeys = [
    ...Object.keys(properties).filter(k => Object.hasOwn(value, k)),
    ...Object.keys(value).filter(k => !Object.hasOwn(properties, k)),
  ].sort((a, b) => Number(!!properties[a]?.properties) - Number(!!properties[b]?.properties));
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  const remove = (k: string) => {
    const next = { ...value };
    delete next[k];
    onChange(next);
  };
  const initial = (s: any): any =>
    s.default ??
    (s.$ref?.endsWith('/text')
      ? { [defaultLocale]: '' }
      : (s.enum?.[0] ??
        (s.type === 'object'
          ? {}
          : s.type === 'boolean'
            ? false
            : ['integer', 'number'].includes(s.type)
              ? (s.minimum ?? 0)
              : '')));
  return (
    <div className="parameter-fields">
      {orderedKeys.map(k => {
        const v = value[k];
        const s = properties[k] ?? {},
          name = configFieldLabel(k, locale),
          removeLabel = tr('DesignerFields.remove_7') + name;
        const removeAction = <FormRemoveAction label={removeLabel} onRemove={() => remove(k)} />;
        if (s.properties && !s.$ref?.endsWith('/text'))
          return (
            <FormGroup key={k} title={name} depth={depth} actions={removeAction}>
              <ParameterFields schema={s} value={v ?? {}} onChange={v => set(k, v)} label={name} depth={depth + 1} />
            </FormGroup>
          );
        return (
          <FormField key={k} layout="row" label={name} depth={depth} trailingActions={removeAction}>
            {s.$ref?.endsWith('/text') ? (
              <LocalizedTextField value={v} onChange={v => set(k, v)} label={name} locale={locale} />
            ) : s.format === 'icon' ? (
              <IconPicker label={name} value={v} onChange={v => set(k, v)} />
            ) : s.enum ? (
              <Select
                aria-label={name}
                value={v}
                optionList={s.enum.map((v: string) => ({ value: v, label: configEnumLabel(v, locale) }))}
                onChange={v => set(k, v)}
              />
            ) : s.type === 'boolean' ? (
              <Checkbox aria-label={name} isSelected={v} onChange={v => set(k, v)}>
                {v ? appText('DesignerFields.enabled') : appText('DesignerFields.disabled')}
              </Checkbox>
            ) : ['integer', 'number'].includes(s.type) ? (
              <InputNumber
                aria-label={name}
                value={v}
                min={s.minimum}
                max={s.maximum}
                step={s.type === 'integer' ? 1 : undefined}
                onChange={v => set(k, v)}
              />
            ) : (
              <Input aria-label={name} value={String(v ?? '')} onChange={v => set(k, v)} />
            )}
          </FormField>
        );
      })}
      {optional.length > 0 &&
        (adding ? (
          <FormField
            layout="row"
            label={tr('DesignerFields.addSetting')}
            depth={depth}
            trailingActions={
              <Button
                theme="borderless"
                size="S"
                icon={<IconClose />}
                aria-label={tr('DesignerFields.cancelAddingSetting')}
                title={tr('DesignerFields.cancel')}
                onClick={() => setAdding(false)}
              />
            }
          >
            <Select
              aria-label={label + ' · ' + tr('DesignerFields.addSetting')}
              placeholder={tr('DesignerFields.chooseASetting')}
              optionList={optional.map(k => ({ value: k, label: configFieldLabel(k, locale) }))}
              onChange={k => {
                set(String(k), initial(properties[String(k)]));
                setAdding(false);
              }}
            />
          </FormField>
        ) : (
          <div className="form-add-action">
            <Button
              size="S"
              icon={<IconPlus />}
              aria-label={label + ' · ' + tr('DesignerFields.addSetting')}
              onClick={() => setAdding(true)}
            >
              {tr('DesignerFields.addSetting')}
            </Button>
          </div>
        ))}
    </div>
  );
}

export function StringLines({
  value,
  onChange,
  label,
  help,
}: {
  value: string[];
  onChange(v: string[]): void;
  label: string;
  help?: string;
}) {
  return (
    <DesignerField label={label} help={help}>
      <TextArea aria-label={label} rows={2} value={value.join('\n')} onChange={text => onChange(text.split('\n'))} />
    </DesignerField>
  );
}

function PropertyName({ name, names, onChange }: { name: string; names: string[]; onChange(v: string): void }) {
  const [draft, setDraft] = useState(name),
    { locale } = useApp(),
    tr = (key: string) => translate(key, locale);
  return (
    <div className="property-name-editor">
      <Input aria-label={tr('DesignerFields.propertyName')} value={draft} onChange={setDraft} />
      {draft !== name && (
        <Button size="S" disabled={names.includes(draft)} onClick={() => onChange(draft)}>
          {tr('DesignerFields.rename')}
        </Button>
      )}
    </div>
  );
}
