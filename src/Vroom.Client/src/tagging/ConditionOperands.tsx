import { t } from '../i18n';
import { Button, Input, InputNumber, Select } from '../ui';
import { IconClose, IconPlus } from '../icons';
import { FormField } from '../components/FormLayout';
import { operandShape } from './operators';
import type { Json } from './types';

/** Shared scalar/range/list editing; each list member is typed, never comma-parsed. */
export function ConditionOperands({
  op,
  type,
  values,
  onChange,
  factor = 1,
  render,
}: {
  op: string;
  type: string;
  values: Json[];
  onChange(v: Json[]): void;
  factor?: number;
  render?: (value: Json, onChange: (v: Json) => void) => React.ReactNode;
}) {
  const shape = operandShape(op);
  if (shape === 'none') return null;
  const items =
    shape === 'list'
      ? Array.isArray(values[0])
        ? values[0]
        : []
      : shape === 'range'
        ? [values[0] ?? null, values[1] ?? null]
        : [values[0] ?? null];
  const write = (next: Json[]) => onChange(shape === 'list' ? [next] : next);
  const control = (v: Json, change: (v: Json) => void) =>
    render ? (
      render(v, change)
    ) : ['number', 'integer'].includes(type) ? (
      <InputNumber
        aria-label={t('Journey.value')}
        value={typeof v === 'number' ? v / factor : null}
        onChange={n => change(Number.isFinite(n) ? n * factor : null)}
      />
    ) : type === 'boolean' ? (
      <Select
        aria-label={t('Journey.value')}
        value={String(v)}
        optionList={['true', 'false'].map(value => ({
          value,
          label: t(value === 'true' ? 'Journey.yes' : 'Journey.no'),
        }))}
        onChange={v => change(v === 'true')}
      />
    ) : (
      <Input aria-label={t('Journey.value')} value={typeof v === 'string' ? v : ''} onChange={change} />
    );
  return (
    <div className={'condition-operands operands-' + shape}>
      {items.map((item, i) => (
        <FormField
          key={i}
          label={t(
            shape === 'range'
              ? i === 0
                ? 'Query.rangeStart'
                : 'Query.rangeEnd'
              : shape === 'list'
                ? 'Query.listValue'
                : 'Query.value',
          )}
          description={
            op.endsWith('like') ? t('Query.likeHelp') : op.endsWith('glob') ? t('Query.globHelp') : undefined
          }
        >
          <div className="condition-operand">
            {control(item, v => write(items.map((x, n) => (n === i ? v : x))))}
            {shape === 'list' && (
              <Button
                theme="borderless"
                icon={<IconClose />}
                aria-label={t('ExpressionEditor.remove')}
                onClick={() => write(items.filter((_, n) => n !== i))}
              />
            )}
          </div>
        </FormField>
      ))}
      {shape === 'list' && (
        <Button size="S" theme="borderless" icon={<IconPlus />} onClick={() => write([...items, null])}>
          {t('Query.addValue')}
        </Button>
      )}
    </div>
  );
}
