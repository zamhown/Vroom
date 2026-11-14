import { ConditionOperands } from '../tagging/ConditionOperands';
import { operandShape } from '../tagging/operators';
import { t as appText } from '../i18n';
import { ConditionGroup as QueryGroup, ConditionBranch, ConditionRow } from './ConditionLayout';
import { Menu, MenuItem, MenuTrigger } from '@react-spectrum/s2';
import { Button, InputNumber, Select, Space } from '../ui';
import { FormField } from './FormLayout';
import { IconPlus, IconClose, IconChevronDown } from '../icons';
import { useApp } from '../context';
import type { Query, QueryOrderField } from '../types';
import type { Definition, Json, TagPackage } from '../tagging/types';
import { localize } from '../tagging/i18n';
import { TagInput } from '../tagging/Inputs';
import { supportsTarget } from '../tagging/annotation-targets';
import { comparisons, type Predicate } from '../query';

export const operatorLabel = (op: string) => appText('Journey.op.' + op);

export function QueryBuilder({
  value,
  onChange,
  subject = 'film',
  scope = 'whole',
  withinScope = false,
  depth = 0,
  catalog,
  onlyField,
  preview = false,
}: {
  catalog?: TagPackage;
  onlyField?: string;
  preview?: boolean;
  value?: Predicate | null;
  onChange(value: Predicate | undefined): void;
  subject?: 'film' | 'term';
  scope?: 'whole' | 'point' | 'interval' | 'any';
  withinScope?: boolean;
  depth?: number;
}) {
  const app = useApp(),
    pack = catalog ?? app.data.tagging.package;
  const fields = pack.definitions.filter(
    d =>
      (!onlyField || d.key === onlyField) &&
      d.enabled &&
      d.query?.filter !== false &&
      supportsTarget(d, subject, scope === 'any' ? undefined : scope),
  );
  const title = (d: Definition) => localize(d.label, app.locale, pack);
  const first = (_targetScope = scope): Predicate => ({ op: 'exists', tag: '' });
  const update = (v: Predicate) => onChange(v);
  if (!value)
    return (
      <Button icon={<IconPlus />} onClick={() => update({ op: 'and', args: [first()] })} disabled={!fields.length}>
        {appText('Journey.addCondition')}
      </Button>
    );
  const remove = (
    <Button
      theme="borderless"
      icon={<IconClose />}
      aria-label={appText('Journey.removeCondition')}
      onClick={() => onChange(undefined)}
    />
  );
  if (value.op === 'and' || value.op === 'or')
    return (
      <QueryGroup
        root={depth === 0}
        title={appText(depth === 0 ? 'Query.conditions' : 'Query.conditionGroup')}
        controls={
          <Select
            size="S"
            aria-label={appText('Journey.combineConditions')}
            value={value.op}
            optionList={['and', 'or'].map(value => ({ value, label: operatorLabel(value) }))}
            onChange={v => update({ ...value, op: v as 'and' | 'or' })}
          />
        }
        actions={depth > 0 ? remove : undefined}
        footer={
          <>
            <Button
              size="S"
              theme="borderless"
              icon={<IconPlus />}
              onClick={() => update({ ...value, args: [...value.args, first()] })}
            >
              {appText('Journey.addCondition')}
            </Button>
            {depth < 8 && (
              <>
                <Button
                  size="S"
                  theme="borderless"
                  icon={<IconPlus />}
                  onClick={() => update({ ...value, args: [...value.args, { op: 'or', args: [first()] }] })}
                >
                  {appText('Query.addConditionGroup')}
                </Button>
                <MenuTrigger align="start">
                  <Button size="S" theme="borderless" icon={<IconChevronDown />}>
                    {appText('Query.moreConditions')}
                  </Button>
                  <Menu
                    size="S"
                    onAction={id =>
                      update({
                        ...value,
                        args: [
                          ...value.args,
                          id === 'exclude'
                            ? { op: 'not', arg: { op: 'and', args: [first()] } }
                            : {
                                op: 'scoped',
                                scope: { kind: 'interval', match: 'overlaps' },
                                quantifier: 'any',
                                where: { op: 'and', args: [first('interval')] },
                              },
                        ],
                      })
                    }
                  >
                    <MenuItem id="exclude">{appText('Journey.exclude')}</MenuItem>
                    {!preview && subject === 'film' && !withinScope && (
                      <MenuItem id="scope">{appText('Journey.timeRange')}</MenuItem>
                    )}
                  </Menu>
                </MenuTrigger>
              </>
            )}
          </>
        }
      >
        {value.args.map((child, i) => (
          <ConditionBranch key={i} connector={i > 0 ? appText('Query.connector.' + value.op) : undefined}>
            <QueryBuilder
              preview={preview}
              catalog={catalog}
              onlyField={onlyField}
              value={child}
              subject={subject}
              scope={scope}
              withinScope={withinScope}
              depth={depth + 1}
              onChange={next =>
                update({
                  ...value,
                  args: next ? value.args.map((v, n) => (n === i ? next : v)) : value.args.filter((_, n) => n !== i),
                })
              }
            />
          </ConditionBranch>
        ))}
        {!value.args.length && (
          <p className="form-help">{appText(value.op === 'and' ? 'Query.matchAll' : 'Query.matchNone')}</p>
        )}
      </QueryGroup>
    );
  if (value.op === 'not')
    return (
      <QueryGroup title={appText('Query.excludeGroup')} actions={remove}>
        <QueryBuilder
          preview={preview}
          catalog={catalog}
          onlyField={onlyField}
          value={value.arg}
          subject={subject}
          scope={scope}
          withinScope={withinScope}
          depth={depth + 1}
          onChange={arg => (arg ? update({ ...value, arg }) : onChange(undefined))}
        />
      </QueryGroup>
    );
  if (value.op === 'scoped')
    return (
      <QueryGroup title={appText('Journey.timeRange')} actions={remove}>
        <div className="query-scope-controls">
          <FormField label={appText('Journey.scope')}>
            <Select
              aria-label={appText('Journey.scope')}
              value={value.scope.kind}
              optionList={['whole', 'point', 'interval', 'any'].map(value => ({
                value,
                label: appText('Journey.scope.' + value),
              }))}
              onChange={kind =>
                update({
                  ...value,
                  scope: {
                    ...value.scope,
                    kind: kind as typeof value.scope.kind,
                    ...(kind === 'whole' ? { startUs: undefined, endUs: undefined } : {}),
                  },
                })
              }
            />
          </FormField>
          <FormField label={appText('Journey.quantifier')}>
            <Select
              aria-label={appText('Journey.quantifier')}
              value={value.quantifier}
              optionList={['any', 'all', 'none'].map(value => ({
                value,
                label: appText('Journey.quantifier.' + value),
              }))}
              onChange={v => update({ ...value, quantifier: v as typeof value.quantifier })}
            />
          </FormField>
          {value.scope.kind !== 'whole' && (
            <>
              <FormField label={appText('Journey.fromSeconds')}>
                <InputNumber
                  aria-label={appText('Journey.fromSeconds')}
                  min={0}
                  value={value.scope.startUs == null ? null : Number(value.scope.startUs) / 1e6}
                  onChange={v =>
                    update({
                      ...value,
                      scope: { ...value.scope, startUs: Number.isFinite(v) ? String(Math.round(v * 1e6)) : undefined },
                    })
                  }
                />
              </FormField>
              <FormField label={appText('Journey.toSeconds')}>
                <InputNumber
                  aria-label={appText('Journey.toSeconds')}
                  min={0}
                  value={value.scope.endUs == null ? null : Number(value.scope.endUs) / 1e6}
                  onChange={v =>
                    update({
                      ...value,
                      scope: { ...value.scope, endUs: Number.isFinite(v) ? String(Math.round(v * 1e6)) : undefined },
                    })
                  }
                />
              </FormField>
              <FormField label={appText('Journey.rangeMatch')}>
                <Select
                  aria-label={appText('Journey.rangeMatch')}
                  value={value.scope.match ?? 'overlaps'}
                  optionList={['overlaps', 'contains'].map(value => ({
                    value,
                    label: appText('Journey.range.' + value),
                  }))}
                  onChange={v => update({ ...value, scope: { ...value.scope, match: v as 'overlaps' | 'contains' } })}
                />
              </FormField>
            </>
          )}
        </div>
        <QueryBuilder
          preview={preview}
          catalog={catalog}
          onlyField={onlyField}
          value={value.where}
          depth={depth + 1}
          subject={subject}
          scope={value.scope.kind}
          withinScope
          onChange={where => (where ? update({ ...value, where }) : onChange(undefined))}
        />
      </QueryGroup>
    );
  if (!('tag' in value)) return null;
  const d = fields.find(d => d.key === value.tag),
    many = d?.value.cardinality === 'many';
  const valueSchema: Record<string, any> = d?.value.schema ?? {};
  const ops = d
    ? [
        ...comparisons(d.value.schema.format === 'date' ? 'date' : d.value.schema.type, many),
        'in',
        'not-in',
        'exists',
        'missing',
        ...(!preview && d.value.vocabulary ? ['related'] : []),
        ...(!preview && Object.keys(d.facets ?? {}).length ? ['facet'] : []),
      ]
    : ['exists', 'missing'];
  const changeOp = (op: string) => {
    const tag = value.tag;
    const initial: Json = d?.value?.vocabulary
      ? { term: pack.terms?.find(t => t.enabled && t.vocabularyIds.includes(d.value.vocabulary ?? ''))?.id ?? '' }
      : ['integer', 'number'].includes(valueSchema?.type)
        ? 0
        : valueSchema?.type === 'boolean'
          ? true
          : '';
    update(
      op === 'related'
        ? { op, tag, where: { op: 'and', args: [] } }
        : op === 'exists' || op === 'missing'
          ? { op, tag }
          : op === 'in' || op === 'not-in'
            ? { op, tag, values: [initial] }
            : op === 'facet'
              ? {
                  op,
                  tag,
                  facet: Object.keys(d?.facets ?? {})[0],
                  selection: Object.values(d?.facets ?? {})[0]?.bands?.[0]?.id ?? '',
                }
              : {
                  op: op as 'eq',
                  tag,
                  value:
                    op === 'between' || op === 'not-between'
                      ? [initial, initial]
                      : many && ['eq', 'ne', 'is', 'is-not'].includes(op)
                        ? [initial]
                        : initial,
                },
    );
  };
  const scalar = d
    ? {
        ...d,
        value: {
          ...d.value,
          cardinality: value.op === 'in' || value.op === 'not-in' ? ('many' as const) : ('one' as const),
          schema: valueSchema,
        },
        input: {
          component: d.value.vocabulary
            ? value.op === 'in' || value.op === 'not-in'
              ? 'multi-select@1'
              : 'select@1'
            : valueSchema.format === 'date'
              ? 'date@1'
              : ['integer', 'number'].includes(valueSchema.type)
                ? 'number@1'
                : valueSchema.type === 'boolean'
                  ? 'toggle@1'
                  : 'text@1',
        },
      }
    : undefined;
  return (
    <ConditionRow
      actions={remove}
      details={
        value.op === 'related' && (
          <QueryGroup title={appText('Journey.op.related')}>
            <QueryBuilder
              preview={preview}
              catalog={catalog}
              value={value.where}
              subject="term"
              depth={depth + 1}
              onChange={where => (where ? update({ ...value, where }) : onChange(undefined))}
            />
          </QueryGroup>
        )
      }
    >
      <FormField label={appText('Journey.field')}>
        <Select
          filter
          placeholder={appText('Query.chooseField')}
          aria-label={appText('Journey.field')}
          value={value.tag}
          optionList={fields.map(d => ({ value: d.key, label: title(d) }))}
          onChange={tag => update({ op: 'exists', tag: String(tag) })}
        />
      </FormField>
      <FormField label={appText('Journey.operator')}>
        <Select
          disabled={!d}
          aria-label={appText('Journey.operator')}
          value={value.op}
          optionList={ops.map(value => ({ value, label: operatorLabel(value) }))}
          onChange={v => changeOp(String(v))}
        />
      </FormField>
      {('value' in value || 'values' in value) && scalar && (
        <ConditionOperands
          op={value.op}
          type={scalar.value.schema.type}
          values={
            'values' in value
              ? [value.values]
              : operandShape(value.op) === 'range'
                ? (value.value as Json[])
                : [value.value]
          }
          render={(v, change) => (
            <TagInput
              definition={
                many && ['eq', 'ne', 'is', 'is-not'].includes(value.op)
                  ? d!
                  : {
                      ...scalar,
                      value: { ...scalar.value, cardinality: 'one' },
                      input: { ...scalar.input, component: d?.value?.vocabulary ? 'select@1' : scalar.input.component },
                    }
              }
              value={v}
              onChange={change}
              allowCreate={false}
              catalog={pack}
            />
          )}
          onChange={v =>
            update(
              'values' in value
                ? { ...value, values: v[0] as Json[] }
                : { ...value, value: operandShape(value.op) === 'range' ? v : v[0] },
            )
          }
        />
      )}
      {value.op === 'facet' && (
        <FormField label={appText('Journey.band')}>
          <Select
            aria-label={appText('Journey.band')}
            value={value.facet + '/' + value.selection}
            optionList={Object.entries(d?.facets ?? {}).flatMap(([key, facet]) =>
              [...(facet.bands ?? []), ...(facet.missing ? [facet.missing] : [])].map((b: any) => ({
                value: key + '/' + b.id,
                label: localize(b.label, app.locale, pack),
              })),
            )}
            onChange={v => {
              const [facet, selection] = String(v).split('/');
              update({ ...value, facet, selection });
            }}
          />
        </FormField>
      )}
    </ConditionRow>
  );
}

export function QueryOrder({ query, onChange }: { query: Query; onChange(value: Partial<Query>): void }) {
  const { data, locale } = useApp(),
    pack = data.tagging.package;
  const orders = query.orderBy ?? [],
    groups = query.groupBy ?? [];
  const fields = (kind: 'sort' | 'groupBy') =>
    pack.definitions.filter(
      d =>
        d.enabled && supportsTarget(d, 'film', 'whole') && (kind === 'sort' ? d.query?.sort : d.query?.groupBy?.length),
    );
  const options = (kind: 'sort' | 'groupBy') =>
    fields(kind).map(d => ({ value: d.key, label: localize(d.label, locale, pack) }));
  const actions = (kind: 'orderBy' | 'groupBy', index: number) => {
    const list = query[kind] ?? [];
    return (
      <div className="query-row-actions">
        <Button
          size="S"
          theme="borderless"
          disabled={index === 0}
          icon={
            <span className="query-arrow-up">
              <IconChevronDown />
            </span>
          }
          aria-label={appText('Query.moveUp')}
          onClick={() => {
            const next = [...list];
            [next[index - 1], next[index]] = [next[index], next[index - 1]];
            onChange({ [kind]: next });
          }}
        />
        <Button
          size="S"
          theme="borderless"
          disabled={index === list.length - 1}
          icon={<IconChevronDown />}
          aria-label={appText('Query.moveDown')}
          onClick={() => {
            const next = [...list];
            [next[index + 1], next[index]] = [next[index], next[index + 1]];
            onChange({ [kind]: next });
          }}
        />
        <Button
          size="S"
          theme="borderless"
          icon={<IconClose />}
          aria-label={appText('Query.removeField')}
          onClick={() => onChange({ [kind]: list.filter((_, i) => i !== index) })}
        />
      </div>
    );
  };
  return (
    <div className="query-order">
      <section>
        <header>
          <span>{appText('Journey.sort')}</span>
          <small>{appText('Query.priority')}</small>
        </header>
        {orders.map((field, index) => {
          const d = pack.definitions.find(d => d.key === field.tag);
          const update = (change: Partial<typeof field>) =>
            onChange({ orderBy: orders.map((f, i) => (i === index ? { ...f, ...change } : f)) });
          return (
            <div
              className="query-order-row"
              key={index}
              role="group"
              aria-label={appText('Journey.field') + ' ' + (index + 1)}
            >
              <small>{index + 1}</small>
              <FormField label={appText('Journey.field')}>
                <Select
                  filter
                  aria-label={appText('Journey.field')}
                  value={field.tag}
                  optionList={options('sort')}
                  onChange={v => update({ tag: String(v), mode: sortMode(pack.definitions.find(d => d.key === v)) })}
                />
              </FormField>
              <FormField label={appText('Journey.direction')}>
                <Select
                  aria-label={appText('Journey.direction')}
                  value={field.direction ?? 'desc'}
                  optionList={['asc', 'desc'].map(value => ({ value, label: appText('Journey.' + value) }))}
                  onChange={v => update({ direction: v as 'asc' | 'desc' })}
                />
              </FormField>
              {actions('orderBy', index)}
              <details className="query-order-options">
                <summary>{appText('Query.sortOptions')}</summary>
                <Space wrap>
                  {d?.value.cardinality === 'many' && (
                    <FormField label={appText('Journey.sortMembers')}>
                      <Select
                        aria-label={appText('Journey.groupMembers')}
                        value={field.mode ?? 'min'}
                        optionList={['min', 'max'].map(value => ({ value, label: appText('Journey.' + value) }))}
                        onChange={v => update({ mode: v as 'min' | 'max' })}
                      />
                    </FormField>
                  )}
                  {d?.value?.vocabulary && d.value.cardinality === 'one' && (
                    <FormField label={appText('Query.sortReference')}>
                      <Select
                        aria-label={appText('Query.sortReference')}
                        value={field.mode ?? 'value'}
                        optionList={['value', 'label'].map(value => ({
                          value,
                          label: appText('Query.sortMode.' + value),
                        }))}
                        onChange={v => update({ mode: v as 'value' | 'label' })}
                      />
                    </FormField>
                  )}
                  <FormField label={appText('Query.emptyValues')}>
                    <Select
                      aria-label={appText('Query.emptyValues')}
                      value={field.nulls ?? 'last'}
                      optionList={['first', 'last'].map(value => ({ value, label: appText('Query.nulls.' + value) }))}
                      onChange={v => update({ nulls: v as 'first' | 'last' })}
                    />
                  </FormField>
                </Space>
              </details>
            </div>
          );
        })}
        {!orders.length && <p className="form-help">{appText('Query.defaultSort')}</p>}
        <Button
          size="S"
          theme="borderless"
          icon={<IconPlus />}
          disabled={orders.length >= 12 || !fields('sort').some(d => !orders.some(f => f.tag === d.key))}
          onClick={() => {
            const d = fields('sort').find(d => !orders.some(f => f.tag === d.key))!;
            onChange({ orderBy: [...orders, { tag: d.key, direction: 'asc', mode: sortMode(d) }] });
          }}
        >
          {appText('Query.addSort')}
        </Button>
      </section>
      <section>
        <header>
          <span>{appText('Journey.group')}</span>
          <small>{appText('Query.groupTogether')}</small>
        </header>
        {groups.map((field, index) => {
          const d = pack.definitions.find(d => d.key === field.tag);
          const update = (change: Partial<typeof field>) =>
            onChange({ groupBy: groups.map((f, i) => (i === index ? { ...f, ...change } : f)) });
          return (
            <div
              className="query-order-row"
              key={index}
              role="group"
              aria-label={appText('Journey.field') + ' ' + (index + 1)}
            >
              <small>{index + 1}</small>
              <FormField label={appText('Journey.field')}>
                <Select
                  filter
                  aria-label={appText('Journey.field')}
                  value={field.tag}
                  optionList={options('groupBy')}
                  onChange={v => {
                    const d = fields('groupBy').find(d => d.key === v)!;
                    update({ tag: d.key, ...groupMode(groupChoices(d)[0] ?? 'value') });
                  }}
                />
              </FormField>
              <FormField label={appText('Journey.groupMembers')}>
                <Select
                  aria-label={appText('Journey.groupMembers')}
                  value={field.mode === 'facet' ? 'facet:' + field.facet : (field.mode ?? 'value')}
                  optionList={groupChoices(d).map(value => ({
                    value,
                    label: value.startsWith('facet:')
                      ? localize(d?.facets?.[value.slice(6)]?.label, locale, pack)
                      : appText('Journey.group.' + value),
                  }))}
                  onChange={v => update(groupMode(String(v)))}
                />
              </FormField>
              {actions('groupBy', index)}
            </div>
          );
        })}
        {!groups.length && <p className="form-help">{appText('Journey.ungrouped')}</p>}
        <Button
          size="S"
          theme="borderless"
          icon={<IconPlus />}
          disabled={groups.length >= 12 || !fields('groupBy').some(d => !groups.some(f => f.tag === d.key))}
          onClick={() => {
            const d = fields('groupBy').find(d => !groups.some(f => f.tag === d.key))!;
            onChange({ groupBy: [...groups, { tag: d.key, ...groupMode(d.query!.groupBy![0]) }] });
          }}
        >
          {appText('Query.addGroupField')}
        </Button>
      </section>
    </div>
  );
}
export const sortMode = (d?: Definition): 'value' | 'label' | 'min' =>
  d?.value.cardinality === 'many' ? 'min' : d?.value?.vocabulary ? 'label' : 'value';
/** The configured default sort as an orderBy list (catalogPolicy.defaultSort uses the orderBy item shape). */
export const defaultOrderBy = (pack: {
  catalogPolicy?: {
    defaultSort?: { tag?: string; direction?: 'asc' | 'desc'; nulls?: 'first' | 'last'; mode?: string };
  };
  definitions: Definition[];
}): QueryOrderField[] => {
  const sort = pack.catalogPolicy?.defaultSort;
  if (!sort?.tag) return [];
  return [
    {
      tag: sort.tag,
      direction: sort.direction ?? 'desc',
      ...(sort.nulls ? { nulls: sort.nulls } : {}),
      mode: (sort.mode as QueryOrderField['mode']) ?? sortMode(pack.definitions.find(d => d.key === sort.tag)),
    },
  ];
};
// Editor choices: 'facet' expands to one choice per declared band set (encoded only inside this select).
const groupChoices = (d?: Definition) =>
  (d?.query?.groupBy ?? []).flatMap(mode =>
    mode === 'facet' ? Object.keys(d?.facets ?? {}).map(facet => 'facet:' + facet) : [mode],
  );
const groupMode = (mode: string): { mode: 'value' | 'member' | 'facet'; facet?: string } =>
  mode.startsWith('facet:') ? { mode: 'facet', facet: mode.slice(6) } : { mode: mode as 'value' | 'member' };
