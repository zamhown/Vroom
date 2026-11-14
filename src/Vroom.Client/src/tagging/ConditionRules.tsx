import { useState } from 'react';
import { t as appText } from '../i18n';
import { Button, Modal, Select } from '../ui';
import { Menu, MenuItem, MenuTrigger } from '@react-spectrum/s2';
import { IconClose, IconPlus, IconChevronDown } from '../icons';
import { useApp } from '../context';
import { CollectionEditor } from '../components/CollectionEditor';
import { FormField, FormLayout } from '../components/FormLayout';
import { ConditionGroup, ConditionBranch, ConditionRow } from '../components/ConditionLayout';
import { conditionOperators, operandShape } from './operators';
import { ConditionOperands } from './ConditionOperands';
import { FormField as ConditionField } from '../components/FormLayout';
import { operatorLabel } from '../components/QueryBuilder';
import { NumericRuleDialog } from './NumericRuleDialog';
import { formatValue, localize, termOptions } from './i18n';
import { TagInput } from './Inputs';
import { ExpressionEditor } from './ExpressionEditor';
import { conditionFacts, emptyCondition, conditionReady } from './rule-condition';
import { initialLiteral } from './expression-editing';
import { AutomationDialog } from './AutomationDialog';
import type { Definition, TagPackage } from './types';
import registry from '../../../../resources/tagging/host-capabilities.json';

export const factPaths = (value: unknown): string[] =>
  !value || typeof value !== 'object'
    ? []
    : [
        ...new Set([
          ...(typeof (value as any).fact === 'string' ? [(value as any).fact] : []),
          ...Object.values(value).flatMap(factPaths),
        ]),
      ];
const newCondition = emptyCondition;

export function MediaCondition({
  value,
  onChange,
  depth = 0,
  onRemove,
  event,
}: {
  value: any;
  onChange(v: any): void;
  depth?: number;
  onRemove?(): void;
  event?: string;
}) {
  const app = useApp(),
    pack = app.data.tagging.package;
  const facts = conditionFacts(event);
  const [unit, setUnit] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const remove = onRemove ? (
    <Button
      theme="borderless"
      icon={<IconClose />}
      aria-label={appText('Journey.removeCondition')}
      onClick={onRemove}
    />
  ) : undefined;
  // A single predicate gets the same shell without rewriting its expression on open.
  if (depth === 0 || value?.op === 'and' || value?.op === 'or') {
    const grouped = value?.op === 'and' || value?.op === 'or';
    const op = grouped ? value.op : 'and',
      children = grouped ? value.args : [value];
    const write = (args: any[], operation = op) => onChange({ op: operation, args });
    return (
      <ConditionGroup
        root={depth === 0}
        title={appText(depth === 0 ? 'ExpressionEditor.whenMatches' : 'Query.conditionGroup')}
        controls={
          <Select
            size="S"
            aria-label={appText('Journey.combineConditions')}
            value={op}
            optionList={['and', 'or'].map(value => ({ value, label: operatorLabel(value) }))}
            onChange={v => write(children, String(v))}
          />
        }
        actions={remove}
        footer={
          <>
            <Button
              size="S"
              theme="borderless"
              icon={<IconPlus />}
              onClick={() => write([...children, newCondition()])}
            >
              {appText('Journey.addCondition')}
            </Button>
            {depth < 8 && (
              <>
                <Button
                  size="S"
                  theme="borderless"
                  icon={<IconPlus />}
                  onClick={() => write([...children, { op: 'or', args: [newCondition()] }])}
                >
                  {appText('Query.addConditionGroup')}
                </Button>
                <MenuTrigger align="start">
                  <Button size="S" theme="borderless" icon={<IconChevronDown />}>
                    {appText('Query.moreConditions')}
                  </Button>
                  <Menu
                    size="S"
                    onAction={() => write([...children, { op: 'not', args: [{ op: 'and', args: [newCondition()] }] }])}
                  >
                    <MenuItem id="exclude">{appText('Journey.exclude')}</MenuItem>
                  </Menu>
                </MenuTrigger>
              </>
            )}
          </>
        }
      >
        {children.map((child: any, i: number) => (
          <ConditionBranch key={i} connector={i > 0 ? appText('Query.connector.' + op) : undefined}>
            <MediaCondition
              value={child}
              event={event}
              depth={depth + 1}
              onChange={next =>
                grouped ? write(children.map((v: any, n: number) => (n === i ? next : v))) : onChange(next)
              }
              onRemove={() => write(children.filter((_: any, n: number) => n !== i))}
            />
          </ConditionBranch>
        ))}
        {!children.length && (
          <p className="form-help">{appText(op === 'and' ? 'Query.matchAll' : 'Query.matchNone')}</p>
        )}
      </ConditionGroup>
    );
  }
  if (value?.op === 'not')
    return (
      <ConditionGroup title={appText('Query.excludeGroup')} actions={remove}>
        <MediaCondition
          value={value.args[0]}
          event={event}
          depth={depth + 1}
          onChange={next => onChange({ ...value, args: [next] })}
        />
      </ConditionGroup>
    );
  if (
    (value?.tag && !value.op && pack.definitions.find(d => d.key === value.tag)?.value.schema.type === 'boolean') ||
    (value?.fact && !value.op && facts[value.fact]?.type === 'boolean')
  )
    return (
      <MediaCondition
        value={{ op: 'eq', args: [value, { literal: true }] }}
        event={event}
        depth={depth}
        onChange={onChange}
        onRemove={onRemove}
      />
    );
  // A bare non-boolean source is not a predicate. Show what is missing without
  // rewriting its meaning until the user explicitly chooses a comparison.
  const pendingSource = !value?.op && (Object.hasOwn(value ?? {}, 'fact') || Object.hasOwn(value ?? {}, 'tag'));
  const source = pendingSource ? value : value?.args?.[0];
  const fact = source?.fact,
    fieldKey = source?.tag;
  const field = pack.definitions.find(d => d.key === fieldKey);
  const metadata = facts[fact],
    type = metadata?.type ?? field?.value.schema.type;
  const availableOperators = conditionOperators(type ?? 'object', field?.value.cardinality === 'many');
  const units: any[] = metadata?.unit?.choices ?? [];
  const selectedUnit = units.find(u => u.key === unit) ?? units[0];
  const multiplier = selectedUnit?.factor ?? 1;
  const recognized =
    pendingSource ||
    ((Object.hasOwn(source ?? {}, 'fact') || Object.hasOwn(source ?? {}, 'tag')) &&
      availableOperators.includes(value.op) &&
      value.args.slice(1).every((a: any) => Object.hasOwn(a, 'literal')));
  if (advanced || !recognized)
    return (
      <div className="rule-expression-mode">
        <header>
          {recognized && (
            <Button size="S" theme="borderless" onClick={() => setAdvanced(false)}>
              {appText('ExpressionEditor.simpleCondition')}
            </Button>
          )}
          <span className="grow" />
          {remove}
        </header>
        <ExpressionEditor
          label={appText('Journey.condition')}
          value={value}
          onChange={onChange}
          event={event}
          expectedType="boolean"
        />
      </div>
    );
  const shape = pendingSource ? 'none' : operandShape(value.op),
    operands = (value.args ?? []).slice(1).map((a: any) => a.literal);
  const scalar = field
    ? {
        ...field,
        value: {
          ...field.value,
          cardinality: 'one' as const,
          schema: field.value.schema,
        },
        input: { component: field.value.vocabulary ? 'select@1' : field.input.component },
      }
    : undefined;
  return (
    <ConditionRow
      actions={remove}
      details={
        <div className="condition-row-details">
          <Button size="S" theme="borderless" onClick={() => setAdvanced(true)}>
            {appText('ExpressionEditor.combineValues')}
          </Button>
        </div>
      }
    >
      <ConditionField label={appText('Journey.readProperty')}>
        <Select
          filter
          aria-label={appText('Journey.readProperty')}
          placeholder={appText('RuleFlow.chooseProperty')}
          value={fact ? 'fact:' + fact : fieldKey ? 'tag:' + fieldKey : undefined}
          optionList={[
            ...Object.entries(facts)
              .filter(([, f]) => f.type !== 'object')
              .map(([key, f]) => ({ value: 'fact:' + key, label: localize(f.label, app.locale, pack) })),
            ...pack.definitions
              .filter(d => d.enabled)
              .map(d => ({ value: 'tag:' + d.key, label: localize(d.label, app.locale, pack) })),
          ]}
          onChange={v => {
            const text = String(v),
              kind = text.slice(0, text.indexOf(':')),
              key = text.slice(text.indexOf(':') + 1);
            setUnit('');
            onChange({ op: 'exists', args: [{ [kind]: key }] });
          }}
        />
      </ConditionField>
      <ConditionField label={appText('ExpressionEditor.judge')}>
        <Select
          disabled={!type}
          aria-label={appText('ExpressionEditor.judge')}
          value={value.op}
          optionList={availableOperators.map(value => ({ value, label: operatorLabel(value) }))}
          onChange={op => {
            const next = String(op),
              shape = operandShape(next),
              initial = field?.value?.vocabulary ? null : initialLiteral(type);
            onChange({
              op: next,
              args: [
                source,
                ...(shape === 'none'
                  ? []
                  : shape === 'range'
                    ? [{ literal: initial }, { literal: initial }]
                    : [{ literal: shape === 'list' ? [] : initial }]),
              ],
            });
          }}
        />
      </ConditionField>
      {shape !== 'none' && (
        <div className={'rule-comparison-value' + (units.length ? ' has-unit' : '')}>
          <ConditionOperands
            op={value.op}
            type={type}
            values={operands}
            factor={multiplier}
            onChange={args => onChange({ ...value, args: [value.args[0], ...args.map(literal => ({ literal }))] })}
            render={
              field?.value?.vocabulary
                ? (v, change) => (
                    <TagInput
                      definition={value.op === 'has' || shape === 'list' ? scalar! : field}
                      value={v}
                      onChange={change}
                      allowCreate={false}
                    />
                  )
                : undefined
            }
          />
          {!!units.length && shape !== 'none' && (
            <ConditionField className="condition-unit" label={appText('Journey.unit')}>
              <Select
                aria-label={appText('Journey.unit')}
                value={selectedUnit?.key}
                optionList={units.map(u => ({ value: u.key, label: localize(u.label, app.locale, pack) }))}
                onChange={v => setUnit(String(v))}
              />
            </ConditionField>
          )}
        </div>
      )}
    </ConditionRow>
  );
}

function conditionSummary(value: any, locale: string, catalog: TagPackage): string {
  if (!value || typeof value !== 'object') return appText('DefinitionDesigner.complexCondition');
  if (['and', 'or', 'not'].includes(value.op))
    return (
      operatorLabel(value.op) +
      ' (' +
      (value.args ?? []).map((v: any) => conditionSummary(v, locale, catalog)).join('; ') +
      ')'
    );
  const fact = (registry.facts as any)[value.args?.[0]?.fact],
    field = catalog.definitions.find(d => d.key === value.args?.[0]?.tag);
  if (!fact && !field) return appText('DefinitionDesigner.complexCondition');
  const name = localize((fact ?? field).label, locale, catalog),
    literal = value.args?.[1]?.literal;
  if (operandShape(value.op) === 'none') return name + ' ' + operatorLabel(value.op);
  const unit = fact?.unit?.choices?.find((u: any) => u.factor === 1);
  return (
    name +
    ' ' +
    operatorLabel(value.op) +
    ' ' +
    (typeof literal === 'boolean'
      ? appText(literal ? 'Journey.yes' : 'Journey.no')
      : typeof literal === 'string'
        ? JSON.stringify(literal)
        : JSON.stringify(value.args.slice(1).map((a: any) => a.literal)).slice(1, -1)) +
    (unit ? ' ' + localize(unit.label, locale, catalog) : '')
  );
}

export function ConditionRules({
  definition: d,
  catalog,
  onChange,
  changes,
}: {
  definition: Definition;
  catalog: TagPackage;
  onChange(d: Definition): void;
  changes(): any[];
}) {
  const app = useApp();
  const [preview, setPreview] = useState(false),
    [ranges, setRanges] = useState(false);
  const [editing, setEditing] = useState<{ ruleId?: string; row: any; isNew: boolean }>();
  const rules = [...(d.initialization ?? []), ...(d.automation ?? [])].filter(r => r.executor === 'value.match@1');
  const update = (id: string, next: any) =>
    onChange({
      ...d,
      initialization: d.initialization?.map(r => (r.id === id ? next : r)),
      automation: d.automation?.map(r => (r.id === id ? next : r)),
    });
  const writeCases = (rule: any, cases: any[]) => update(rule.id, { ...rule, args: { ...rule.args, cases } });
  const addCase = () => ({
    id: crypto.randomUUID(),
    when: newCondition(),
    value: d.value.cardinality === 'many' ? [] : null,
  });
  const items = rules.flatMap(rule =>
    rule.args.cases.map((row: any, index: number) => ({ id: rule.id + '/' + row.id, rule, row, index })),
  );
  const save = () => {
    if (!editing) return;
    const rule = rules.find(r => r.id === editing.ruleId);
    if (rule)
      writeCases(
        rule,
        editing.isNew
          ? [...rule.args.cases, editing.row]
          : rule.args.cases.map((row: any) => (row.id === editing.row.id ? editing.row : row)),
      );
    else
      onChange({
        ...d,
        initialization: [
          ...(d.initialization ?? []),
          {
            id: crypto.randomUUID(),
            event: 'film.discovered',
            executor: 'value.match@1',
            args: { cases: [editing.row] },
            apply: 'if-unset',
          },
        ],
      });
    setEditing(undefined);
  };
  return (
    <div className="condition-rules">
      <CollectionEditor
        label={appText('Journey.whenThen')}
        title={appText('Journey.whenThen')}
        count={items.length ? String(items.length) : ''}
        items={items}
        actionsLabel={appText('FacetEditor.actions')}
        emptyText={appText('DefinitionDesigner.noConditionRules')}
        columns={[
          {
            id: 'condition',
            title: appText('Journey.condition'),
            wide: true,
            width: '50%',
            render: item => (
              <span title={conditionSummary(item.row.when, app.locale, catalog)}>
                {conditionSummary(item.row.when, app.locale, catalog)}
              </span>
            ),
          },
          {
            id: 'value',
            title: appText('Journey.fillWith'),
            render: item => formatValue(d, item.row.value, app.locale, catalog),
          },
          {
            id: 'order',
            title: appText('DefinitionDesigner.order'),
            width: 80,
            render: item => (
              <Button
                size="S"
                theme="borderless"
                disabled={item.index === 0}
                onClick={() => {
                  const cases = [...item.rule.args.cases];
                  [cases[item.index - 1], cases[item.index]] = [cases[item.index], cases[item.index - 1]];
                  writeCases(item.rule, cases);
                }}
              >
                {appText('Journey.moveUp')}
              </Button>
            ),
          },
        ]}
        editLabel={item =>
          appText('DefinitionDesigner.editRule', { name: conditionSummary(item.row.when, app.locale, catalog) })
        }
        onEdit={item => setEditing({ ruleId: item.rule.id, row: structuredClone(item.row), isNew: false })}
        removeLabel={() => appText('Journey.removeRule')}
        onRemove={item => {
          const cases = item.rule.args.cases.filter((row: any) => row.id !== item.row.id);
          if (cases.length) writeCases(item.rule, cases);
          else
            onChange({
              ...d,
              initialization: d.initialization?.filter(r => r.id !== item.rule.id),
              automation: d.automation?.filter(r => r.id !== item.rule.id),
            });
        }}
        actions={
          <>
            <Button size="S" disabled={!rules.length} onClick={() => setPreview(true)}>
              {appText('Journey.tryRules')}
            </Button>
            <Button
              size="S"
              icon={<IconPlus />}
              onClick={() => setEditing({ ruleId: rules[0]?.id, row: addCase(), isNew: true })}
            >
              {appText('Journey.addRule')}
            </Button>
          </>
        }
      />
      {d.value.vocabulary && termOptions(d, catalog).length > 1 && (
        <Button size="S" onClick={() => setRanges(true)}>
          {appText('Journey.numericRanges')}
        </Button>
      )}
      {!!rules.length && <p className="form-help">{appText('Journey.firstMatch')}</p>}
      <Modal
        mode="exclusive"
        title={appText('Journey.whenThen')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        width={960}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{appText('FacetEditor.cancel')}</Button>
            <Button theme="solid" disabled={!editing || !conditionReady(editing.row.when, catalog)} onClick={save}>
              {appText('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing && (
          <FormLayout className="rule-composer">
            <div>
              <MediaCondition
                value={editing.row.when}
                onChange={when => setEditing({ ...editing, row: { ...editing.row, when } })}
              />
            </div>
            {!conditionReady(editing.row.when, catalog) && (
              <p className="query-validation" role="status">
                {appText('RuleFlow.finishCondition')}
              </p>
            )}
            <FormField label={appText('ExpressionEditor.thenFill')}>
              <TagInput
                catalog={catalog}
                definition={d}
                allowCreate={false}
                value={editing.row.value}
                onChange={value => setEditing({ ...editing, row: { ...editing.row, value } })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
      {ranges && (
        <NumericRuleDialog
          definition={d}
          catalog={catalog}
          close={() => setRanges(false)}
          apply={cases => {
            if (rules.length) writeCases(rules[0], cases);
            else
              onChange({
                ...d,
                initialization: [
                  ...(d.initialization ?? []),
                  {
                    id: crypto.randomUUID(),
                    event: 'film.discovered',
                    executor: 'value.match@1',
                    args: { cases },
                    apply: 'if-unset',
                  },
                ],
              });
          }}
        />
      )}
      {preview && (
        <AutomationDialog definition={d} catalog={catalog} changes={changes()} close={() => setPreview(false)} />
      )}
    </div>
  );
}
