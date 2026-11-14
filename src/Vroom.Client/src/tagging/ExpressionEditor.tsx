import { translate } from '../i18n';
import { Checkbox } from '@react-spectrum/s2';
import { FormField } from '../components/FormLayout';
import { Button, Input, InputNumber, Select } from '../ui';
import { useApp } from '../context';
import { localize } from './i18n';
import { PrimitiveValue } from './DesignerFields';
import registry from '../../../../resources/tagging/host-capabilities.json';
import { operations as capabilities } from './operators';
import {
  argumentRole,
  argumentType,
  expressionKind,
  expressionType,
  initialLiteral,
  predicateOperation,
  replaceOperation,
} from './expression-editing';

export const expressionOperations: Record<string, [string, number, number]> = Object.fromEntries(
  Object.entries(capabilities).map(([key, op]) => [key, ['Journey.op.' + key, op.minArgs, op.maxArgs]]),
);
export function ExpressionEditor({
  value,
  onChange,
  label,
  depth = 0,
  event,
  expectedType,
}: {
  value: any;
  onChange(v: any): void;
  label: string;
  depth?: number;
  event?: string;
  expectedType?: string;
}) {
  const app = useApp(),
    { locale } = app,
    pack = app.data.tagging.package,
    tr = (key: string) => translate(key, locale),
    t = (v: any) => localize(v, locale, pack);
  const kind = expressionKind(value),
    arity = expressionOperations[kind],
    leaf = ['literal', 'tag', 'fact'].includes(kind);
  const facts = {
    ...registry.facts,
    ...Object.fromEntries(Object.entries(registry.eventFacts).filter(([, f]) => event && f.events.includes(event))),
  };
  const chooseSource = (k: string) =>
    onChange(
      k === 'tag'
        ? { tag: pack.definitions[0]?.key ?? '' }
        : k === 'fact'
          ? { fact: Object.keys(registry.facts)[0] }
          : k === 'literal'
            ? { literal: initialLiteral(expectedType) }
            : replaceOperation(
                value,
                (expectedType ?? expressionType(value, pack)) === 'string' ? 'concat' : 'add',
                pack,
              ),
    );
  const literal = value?.literal ?? null,
    typed =
      ['string', 'number', 'integer', 'boolean'].includes(expectedType ?? '') &&
      (literal == null || typeof literal === (expectedType === 'integer' ? 'number' : expectedType));
  const readControl =
    kind === 'tag' ? (
      <Select
        filter
        aria-label={tr('ExpressionEditor.readTag')}
        value={value.tag}
        optionList={pack.definitions.map(d => ({ value: d.key, label: t(d.label) }))}
        onChange={tag => onChange({ tag })}
      />
    ) : kind === 'fact' ? (
      <Select
        filter
        aria-label={tr('ExpressionEditor.readFact')}
        value={value.fact}
        optionList={[
          ...Object.entries(facts).map(([value, f]) => ({ value, label: t(f.label) })),
          ...(!Object.hasOwn(facts, value.fact)
            ? [
                {
                  value: value.fact,
                  label: value.fact + tr('ExpressionEditor.unavailableForThisEvent'),
                  disabled: true,
                },
              ]
            : []),
        ]}
        onChange={fact => onChange({ fact })}
      />
    ) : typed ? (
      <div className="expression-literal-control">
        {expectedType === 'string' ? (
          <Input
            aria-label={label}
            disabled={literal === null}
            value={literal ?? ''}
            onChange={literal => onChange({ literal })}
          />
        ) : expectedType === 'boolean' ? (
          <Select
            aria-label={label}
            disabled={literal === null}
            value={String(literal)}
            optionList={['true', 'false'].map(value => ({
              value,
              label: tr(value === 'true' ? 'Journey.yes' : 'Journey.no'),
            }))}
            onChange={v => onChange({ literal: v === 'true' })}
          />
        ) : (
          <InputNumber
            aria-label={label}
            disabled={literal === null}
            value={literal}
            onChange={v => onChange({ literal: Number.isFinite(v) ? v : null })}
          />
        )}
        <Checkbox
          isSelected={literal === null}
          onChange={empty => onChange({ literal: empty ? null : initialLiteral(expectedType) })}
        >
          {tr('DesignerFields.null')}
        </Checkbox>
      </div>
    ) : (
      <PrimitiveValue value={literal} onChange={literal => onChange({ literal })} label={label} />
    );
  return (
    <div className={'expression-editor' + (leaf ? ' expression-source' : ' expression-computation')}>
      {leaf ? (
        <div className="expression-source-fields">
          <FormField label={tr('ExpressionEditor.valueSource')}>
            <Select
              aria-label={label + ' ' + tr('ExpressionEditor.valueSource')}
              value={kind}
              optionList={[
                { value: 'literal', label: tr('ExpressionEditor.literal') },
                {
                  value: 'fact',
                  label: event ? tr('ExpressionEditor.mediaEventData') : tr('ExpressionEditor.mediaFact'),
                },
                { value: 'tag', label: tr('ExpressionEditor.tagValue') },
                { value: 'calculation', label: tr('ExpressionEditor.calculatedValue') },
              ]}
              onChange={v => chooseSource(String(v))}
            />
          </FormField>
          <FormField
            label={tr(
              kind === 'fact'
                ? 'ExpressionEditor.readFact'
                : kind === 'tag'
                  ? 'ExpressionEditor.readTag'
                  : 'DesignerFields.value',
            )}
          >
            {readControl}
          </FormField>
        </div>
      ) : (
        <>
          <FormField
            layout="row"
            label={tr(
              predicateOperation(kind) || ['and', 'or', 'not'].includes(kind)
                ? 'ExpressionEditor.judge'
                : 'ExpressionEditor.calculate',
            )}
          >
            <Select
              filter
              aria-label={
                label +
                ' ' +
                tr(
                  predicateOperation(kind) || ['and', 'or', 'not'].includes(kind)
                    ? 'ExpressionEditor.judge'
                    : 'ExpressionEditor.calculate',
                )
              }
              value={kind}
              optionList={Object.entries(expressionOperations).map(([value, p]) => ({ value, label: tr(p[0]) }))}
              onChange={op => onChange(replaceOperation(value, String(op), pack))}
            />
          </FormField>
          <div className="expression-operands">
            {(value.args ?? []).map((arg: any, i: number) => {
              const role = argumentRole(kind, i, value.args.length),
                roleLabel = tr('ExpressionEditor.role.' + role),
                repeated =
                  ['condition', 'candidate', 'number', 'text', 'when', 'then'].includes(role) && value.args.length > 1;
              const title = roleLabel + (repeated ? ' ' + (kind === 'case' ? Math.floor(i / 2) + 1 : i + 1) : '');
              return (
                <section className="expression-operand" key={i} aria-label={title}>
                  <header>
                    <span>{title}</span>
                    {value.args.length > (arity?.[1] ?? 0) &&
                      (kind !== 'case' || (i < value.args.length - 1 && i % 2 === 0)) && (
                        <Button
                          size="S"
                          theme="borderless"
                          onClick={() =>
                            onChange({
                              ...value,
                              args: value.args.filter(
                                (_: any, j: number) => j !== i && (kind !== 'case' || j !== i + 1),
                              ),
                            })
                          }
                        >
                          {tr('ExpressionEditor.remove')}
                        </Button>
                      )}
                  </header>
                  {depth < 23 ? (
                    <ExpressionEditor
                      value={arg}
                      onChange={next =>
                        onChange({ ...value, args: value.args.map((v: any, j: number) => (j === i ? next : v)) })
                      }
                      label={title}
                      depth={depth + 1}
                      event={event}
                      expectedType={argumentType(kind, i, value, pack)}
                    />
                  ) : (
                    <span>{tr('ExpressionEditor.maximumExpressionDepthReached')}</span>
                  )}
                </section>
              );
            })}
          </div>
          {(value.args?.length ?? 0) < (arity?.[2] ?? 0) && (
            <Button
              size="S"
              theme="borderless"
              onClick={() =>
                onChange({
                  ...value,
                  args:
                    kind === 'case'
                      ? [...value.args.slice(0, -1), { literal: false }, { literal: '' }, value.args.at(-1)]
                      : [
                          ...(value.args ?? []),
                          { literal: initialLiteral(argumentType(kind, value.args?.length ?? 0, value, pack)) },
                        ],
                })
              }
            >
              {tr(kind === 'case' ? 'ExpressionEditor.addBranch' : 'ExpressionEditor.addValue')}
            </Button>
          )}
          {kind === 'concat' && (
            <FormField layout="row" label={tr('ExpressionEditor.separator')}>
              <Input
                aria-label={tr('ExpressionEditor.separator')}
                value={value.separator ?? ''}
                onChange={separator => onChange({ ...value, separator })}
              />
            </FormField>
          )}
          <Button size="S" theme="borderless" onClick={() => onChange(value.args?.[0] ?? { literal: '' })}>
            {tr('ExpressionEditor.useSourceOnly')}
          </Button>
        </>
      )}
    </div>
  );
}
