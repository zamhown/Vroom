import { t as appText, translate } from '../i18n';
import { useState } from 'react';
import { Checkbox } from '@react-spectrum/s2';
import { Button, Input, InputNumber, Modal, Select, Space } from '../ui';
import { CollectionEditor } from '../components/CollectionEditor';
import { IconPlus } from '../icons';
import { useApp } from '../context';
import { configEnumLabel } from './config-editor';
import { localize, formatValue } from './i18n';
import { TagInput } from './Inputs';
import { DesignerField, StringLines } from './DesignerFields';
import { ExpressionEditor } from './ExpressionEditor';
import { FacetSelector } from './FacetSelector';
import { RunConditionEditor } from './RunConditionEditor';
import { conditionReady } from './rule-condition';
import { WritePolicyField, WriteProtectionNote } from './WritePolicyField';
import { FormLayout, FormField } from '../components/FormLayout';
import type { Definition } from './types';
import registry from '../../../../resources/tagging/host-capabilities.json';

export function RuleList({
  definition: d,
  kind,
  onChange,
}: {
  definition: Definition;
  kind: 'initialization' | 'automation';
  onChange(d: Definition): void;
}) {
  const app = useApp(),
    { locale } = app,
    pack = app.data.tagging.package,
    tr = (key: string) => translate(key, locale),
    t = (v: any) => localize(v, locale, pack);
  const [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<Definition>();
  const rules = d[kind] ?? [],
    visible = rules.filter(r => r.executor !== 'value.match@1');
  const facts = Object.entries(registry.facts)
    .filter(
      ([, f]) =>
        !d.value.vocabulary &&
        d.value.cardinality === 'one' &&
        (f.type === d.value.schema.type || (f.type === 'integer' && d.value.schema.type === 'number')),
    )
    .map(([value, f]) => ({ value, label: t(f.label) }));
  const executors = Object.entries(registry.executors)
    .filter(([id, executor]) => id !== 'value.match@1' && executor.targets.some(target => d.targets.includes(target)))
    .filter(([id]) =>
      id === 'fact.copy@1'
        ? facts.length
        : id === 'dictionary.match@1'
          ? !!d.value.vocabulary
          : id === 'path.facet-alias-match@1'
            ? ['integer', 'number'].includes(d.value.schema.type)
            : id === 'regex.extract@1'
              ? d.value.schema.type === 'string' || !!d.writes?.createTerms
              : true,
    );
  const create = (executor: string) => {
    const args =
      executor === 'fact.copy@1'
        ? { path: facts[0]?.value }
        : executor === 'value.constant@1'
          ? {
              value:
                d.value.cardinality === 'many'
                  ? []
                  : d.value.schema.type === 'boolean'
                    ? false
                    : d.value.schema.type === 'integer' || d.value.schema.type === 'number'
                      ? (d.value.schema.minimum ?? 0)
                      : d.value.schema.type === 'array'
                        ? []
                        : d.value.schema.type === 'object'
                          ? null
                          : '',
            }
          : executor === 'expression@1'
            ? { expression: { literal: '' } }
            : executor === 'dictionary.match@1'
              ? { inputs: ['file.relativePath'], vocabulary: d.value.vocabulary }
              : executor === 'path.facet-alias-match@1'
                ? { inputs: ['file.relativePath'], facet: Object.keys(d.facets ?? {})[0] }
                : {
                    inputs: ['file.baseName'],
                    patterns: [{ pattern: '', template: '{0}' }],
                    ...(d.value.vocabulary ? { createOptions: true } : {}),
                  };
    return {
      id: crypto.randomUUID(),
      event: kind === 'initialization' ? 'film.discovered' : 'annotation.changed',
      executor,
      args,
      apply: d.value.vocabulary && executor === 'regex.extract@1' ? 'suggest-only' : 'if-unset',
    };
  };
  const title = tr(kind === 'initialization' ? 'DefinitionDesigner.parseRules' : 'DefinitionDesigner.updateRules');
  const ruleName = (r: any) => t((registry.executors as any)[r.executor]?.label) || r.executor;
  const open = (rule: any) => setEditing({ ...structuredClone(d), [kind]: [structuredClone(rule)] });
  return (
    <>
      <CollectionEditor
        label={title}
        title={title}
        count={visible.length ? String(visible.length) : ''}
        items={visible}
        actionsLabel={tr('FacetEditor.actions')}
        columns={[
          { id: 'method', title: tr('DefinitionRulesEditor.automaticValueMethod'), render: ruleName },
          {
            id: 'event',
            title: tr('DefinitionRulesEditor.whenToRun'),
            render: r => t((registry.eventLabels as any)[r.event]) || r.event,
          },
          {
            id: 'policy',
            title: tr('DefinitionRulesEditor.writePolicy'),
            render: r => configEnumLabel(r.apply, locale),
          },
          {
            id: 'order',
            title: tr('DefinitionDesigner.order'),
            render: r => (
              <Button
                theme="borderless"
                size="S"
                disabled={rules.indexOf(r) === 0}
                onClick={() => {
                  const next = [...rules],
                    i = next.indexOf(r);
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  onChange({ ...d, [kind]: next });
                }}
              >
                {tr('DefinitionRulesEditor.moveUp')}
              </Button>
            ),
          },
        ]}
        emptyText={tr('DefinitionDesigner.noParsingRules')}
        editLabel={r => appText('DefinitionDesigner.editRule', { name: ruleName(r) })}
        onEdit={open}
        removeLabel={r => appText('DefinitionDesigner.removeRule', { name: ruleName(r) })}
        onRemove={r => onChange({ ...d, [kind]: rules.filter(item => item.id !== r.id) })}
        actions={
          <Button size="S" icon={<IconPlus />} onClick={() => setAdding(true)}>
            {tr('DefinitionRulesEditor.addRule')}
          </Button>
        }
      />
      <Modal
        mode="exclusive"
        width={760}
        title={title}
        visible={adding || !!editing}
        onCancel={() => {
          setAdding(false);
          setEditing(undefined);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setAdding(false);
                setEditing(undefined);
              }}
            >
              {tr('FacetEditor.cancel')}
            </Button>
            <Button
              theme="solid"
              disabled={!editing || !conditionReady(editing[kind]?.[0]?.when, pack, editing[kind]?.[0]?.event)}
              onClick={() => {
                const rule = editing![kind]![0];
                onChange({
                  ...d,
                  writes: editing!.writes,
                  ...(editing!.facets ? { facets: editing!.facets } : {}),
                  [kind]: rules.some(r => r.id === rule.id)
                    ? rules.map(r => (r.id === rule.id ? rule : r))
                    : [...rules, rule],
                });
                setEditing(undefined);
                setAdding(false);
              }}
            >
              {tr('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing ? (
          <RuleDetails definition={editing} kind={kind} onChange={setEditing} />
        ) : (
          <DesignerField label={tr('RuleFlow.action')}>
            <Select
              aria-label={tr('RuleFlow.action')}
              placeholder={tr('DefinitionRulesEditor.chooseAMethod')}
              optionList={executors.map(([value, p]) => ({ value, label: t(p.label) }))}
              onChange={v => {
                open(create(String(v)));
                setAdding(false);
              }}
            />
          </DesignerField>
        )}
      </Modal>
    </>
  );
}

function RuleDetails({
  definition: d,
  kind,
  onChange,
}: {
  definition: Definition;
  kind: 'initialization' | 'automation';
  onChange(d: Definition): void;
}) {
  const app = useApp(),
    { locale } = app,
    pack = app.data.tagging.package,
    tr = (key: string) => translate(key, locale),
    t = (v: any) => localize(v, locale, pack);
  const rules = d[kind] ?? [],
    set = (i: number, v: any) => onChange({ ...d, [kind]: rules.map((r, j) => (i === j ? v : r)) });
  const facts = Object.entries(registry.facts)
    .filter(
      ([, f]) =>
        !d.value.vocabulary &&
        d.value.cardinality === 'one' &&
        (f.type === d.value.schema.type || (f.type === 'integer' && d.value.schema.type === 'number')),
    )
    .map(([value, f]) => ({ value, label: t(f.label) }));
  return (
    <div className="rule-list">
      {rules.map((r, i) => {
        if (r.executor === 'value.match@1') return null;
        const args = (v: any) => set(i, { ...r, args: { ...r.args, ...v } }),
          eventOptions = [
            ...new Set([
              ...(d.targets.includes('film-whole') ? registry.events.film : []),
              ...(d.targets.includes('term-whole') ? registry.events.term : []),
            ]),
          ].map(value => ({ value, label: t((registry.eventLabels as any)[value]) || value }));
        return (
          <section className="rule-editor" key={r.id}>
            <FormLayout compact>
              <FormField layout="row" label={tr('RuleFlow.when')}>
                <Select
                  aria-label={tr('RuleFlow.when')}
                  value={r.event}
                  optionList={eventOptions}
                  onChange={event => set(i, { ...r, event })}
                />
              </FormField>
              <FormField layout="row" label={tr('RuleFlow.action')}>
                <span className="form-field-value">{t((registry.executors as any)[r.executor]?.label)}</span>
              </FormField>
              {r.executor === 'value.constant@1' && (
                <FormField layout="row" label={tr('RuleFlow.setValue')}>
                  <TagInput
                    definition={d}
                    value={r.args.value}
                    onChange={value => args({ value })}
                    allowCreate={false}
                    showState
                  />
                </FormField>
              )}
              {r.executor === 'fact.copy@1' && (
                <FormField layout="row" label={tr('DefinitionRulesEditor.readProperty')}>
                  <Select
                    filter
                    aria-label={tr('DefinitionRulesEditor.readProperty')}
                    value={r.args.path}
                    optionList={facts}
                    onChange={path => args({ path })}
                  />
                </FormField>
              )}
              {r.args.inputs && (
                <FormField layout="row" label={tr('DefinitionRulesEditor.searchTheseFields')}>
                  <Select
                    multiple
                    aria-label={tr('DefinitionRulesEditor.searchTextInputs')}
                    value={r.args.inputs}
                    optionList={Object.keys(registry.facts)
                      .filter(
                        p => p.startsWith('file.') && (registry.facts as Record<string, any>)[p].type === 'string',
                      )
                      .map(value => ({ value, label: t((registry.facts as any)[value].label) }))}
                    onChange={inputs => args({ inputs })}
                  />
                </FormField>
              )}
              {r.executor === 'dictionary.match@1' && (
                <FormField
                  layout="row"
                  label={tr('DefinitionRulesEditor.matchCollection')}
                  description={tr('DefinitionRulesEditor.matchesExistingNamesAndAliasesAndWrites')}
                >
                  <Select
                    aria-label={tr('DefinitionRulesEditor.matchCollection')}
                    value={r.args.vocabulary}
                    optionList={Object.entries(pack.vocabularies ?? {})
                      .filter(([k]) => k === d.value.vocabulary)
                      .map(([value, v]) => ({ value, label: t(v.label) }))}
                    onChange={vocabulary => args({ vocabulary })}
                  />
                </FormField>
              )}
              {r.executor === 'path.facet-alias-match@1' && (
                <FacetSelector
                  definition={d}
                  selected={r.args.facet ?? ''}
                  onChange={(facets, facet) =>
                    onChange({
                      ...d,
                      facets,
                      [kind]: rules.map((item, index) => (index === i ? { ...r, args: { ...r.args, facet } } : item)),
                    })
                  }
                />
              )}
              {r.executor === 'regex.extract@1' && (
                <DesignerField label={tr('DefinitionRulesEditor.extractionRules')}>
                  <div className="form-stack">
                    <DesignerField label={tr('DefinitionRulesEditor.ruleSource')}>
                      <Select
                        aria-label={tr('DefinitionRulesEditor.ruleSource')}
                        value={r.args.rule ?? ''}
                        optionList={[
                          { value: '', label: tr('DefinitionRulesEditor.rulesForThisTag') },
                          ...Object.entries(pack.rules ?? {}).map(([value, p]: any) => ({
                            value,
                            label: t(p.label) || value,
                          })),
                        ]}
                        onChange={rule => {
                          const { patterns: _patterns, normalize: _normalize, rule: _rule, ...rest } = r.args;
                          set(i, {
                            ...r,
                            args: { ...rest, ...(rule ? { rule } : { patterns: [{ pattern: '', template: '{0}' }] }) },
                          });
                        }}
                      />
                    </DesignerField>
                    {r.args.rule ? (
                      <>
                        <p className="designer-help">
                          {tr('DefinitionRulesEditor.thisReferencesSharedRulesCopyThemHere')}
                        </p>
                        <Button
                          onClick={() => {
                            const { rule, ...rest } = r.args;
                            const shared = pack.rules[rule];
                            set(i, {
                              ...r,
                              args: {
                                ...rest,
                                patterns: structuredClone(shared?.patterns ?? []),
                                ...(shared?.normalize ? { normalize: shared.normalize } : {}),
                              },
                            });
                          }}
                        >
                          {tr('DefinitionRulesEditor.copyAndEditHere')}
                        </Button>
                      </>
                    ) : (
                      <PatternEditor value={r.args} onChange={value => set(i, { ...r, args: value })} />
                    )}
                    {d.writes?.createTerms && (
                      <Checkbox
                        isSelected={r.args.createOptions === true}
                        onChange={createOptions =>
                          set(i, {
                            ...r,
                            args: { ...r.args, createOptions },
                            ...(createOptions ? { apply: 'suggest-only' } : {}),
                          })
                        }
                      >
                        {tr('DefinitionRulesEditor.suggestNewOptionsForExtractedNames')}
                      </Checkbox>
                    )}
                  </div>
                </DesignerField>
              )}
              {r.executor === 'expression@1' && (
                <DesignerField label={tr('DefinitionRulesEditor.computedValue')}>
                  <ExpressionEditor
                    value={r.args.expression}
                    onChange={expression => args({ expression })}
                    event={r.event}
                    label={tr('DefinitionRulesEditor.resultExpression')}
                  />
                </DesignerField>
              )}
              <WritePolicyField
                definition={d}
                value={r.apply}
                suggestionsOnly={r.args.createOptions}
                onPriorityChange={sourcePriority => onChange({ ...d, writes: { ...d.writes, sourcePriority } })}
                onChange={apply => set(i, { ...r, apply })}
              />
              <output className="rule-outcome" aria-live="polite">
                {translate('RuleFlow.outcome', locale, {
                  event: t((registry.eventLabels as any)[r.event]) || r.event,
                  tag: t(d.label),
                  action:
                    r.executor === 'value.constant@1'
                      ? translate('RuleFlow.writeValue', locale, { value: formatValue(d, r.args.value, locale, pack) })
                      : r.executor === 'fact.copy@1'
                        ? translate('RuleFlow.readFact', locale, {
                            fact: t((registry.facts as any)[r.args.path]?.label),
                          })
                        : t((registry.executors as any)[r.executor]?.label),
                  policy: configEnumLabel(r.apply, locale),
                })}
              </output>
              <RunConditionEditor
                value={r.when}
                event={r.event}
                onChange={when => {
                  const next = { ...r };
                  if (when === undefined) delete next.when;
                  else next.when = when;
                  set(i, next);
                }}
              />
              <WriteProtectionNote />
            </FormLayout>
          </section>
        );
      })}
    </div>
  );
}
export function PatternEditor({ value, onChange }: { value: any; onChange(v: any): void }) {
  const { locale } = useApp(),
    tr = (key: string) => translate(key, locale);
  const [newGroup, setNewGroup] = useState(1);
  const patterns = value.patterns ?? [],
    set = (i: number, p: any) =>
      onChange({ ...value, patterns: patterns.map((v: any, j: number) => (i === j ? p : v)) });
  return (
    <div className="pattern-editor">
      <DesignerField label={tr('DefinitionRulesEditor.beforeMatching')}>
        <Select
          aria-label={tr('DefinitionRulesEditor.beforeMatching')}
          value={value.normalize ?? ''}
          optionList={[
            { value: '', label: tr('DefinitionRulesEditor.keepText') },
            { value: 'nfkc-upper', label: tr('DefinitionRulesEditor.normalizeWidthAndUppercase') },
          ]}
          onChange={normalize => {
            const next = { ...value };
            if (normalize) next.normalize = normalize;
            else delete next.normalize;
            onChange(next);
          }}
        />
      </DesignerField>
      {patterns.map((p: any, i: number) => (
        <div className="pattern-item" key={i}>
          <header className="parameter-label">
            <strong>
              {tr('DefinitionRulesEditor.pattern')} {i + 1}
            </strong>
            <Button
              size="S"
              theme="borderless"
              onClick={() => onChange({ ...value, patterns: patterns.filter((_: any, j: number) => j !== i) })}
            >
              {tr('DefinitionRulesEditor.remove')}
            </Button>
          </header>
          <DesignerField label={tr('DefinitionRulesEditor.regularExpression')}>
            <Input
              aria-label={tr('DefinitionRulesEditor.regularExpression')}
              value={p.pattern ?? ''}
              onChange={pattern => set(i, { ...p, pattern })}
            />
          </DesignerField>
          <DesignerField
            label={tr('DefinitionRulesEditor.resultTemplate')}
            help={tr('DefinitionRulesEditor.isTheFullMatchIsTheFirst')}
          >
            <Input
              aria-label={tr('DefinitionRulesEditor.resultTemplate')}
              value={p.template ?? '{0}'}
              onChange={template => set(i, { ...p, template })}
            />
          </DesignerField>
          <details className="designer-advanced form-disclosure">
            <summary>{tr('DefinitionRulesEditor.captureGroupTransforms')}</summary>
            {Object.entries(p.groups ?? {}).map(([key, g]: any) => (
              <div className="capture-group" key={key}>
                <header className="parameter-label">
                  <strong>
                    {tr('DefinitionRulesEditor.capture')} {key}
                  </strong>
                  <Button
                    theme="borderless"
                    size="S"
                    onClick={() => {
                      const groups = { ...p.groups };
                      delete groups[key];
                      set(i, { ...p, groups });
                    }}
                  >
                    {tr('DefinitionRulesEditor.remove')}
                  </Button>
                </header>
                <Checkbox
                  isSelected={g.trimLeadingZeros === true}
                  onChange={trimLeadingZeros =>
                    set(i, { ...p, groups: { ...p.groups, [key]: { ...g, trimLeadingZeros } } })
                  }
                >
                  {tr('DefinitionRulesEditor.trimLeadingZeroes')}
                </Checkbox>
                <DesignerField label={tr('DefinitionRulesEditor.zeroPadWidth')}>
                  <InputNumber
                    aria-label={tr('DefinitionRulesEditor.zeroPadWidth')}
                    value={g.padLeft ?? 0}
                    min={0}
                    max={32}
                    onChange={padLeft => set(i, { ...p, groups: { ...p.groups, [key]: { ...g, padLeft } } })}
                  />
                </DesignerField>
                <StringLines
                  label={tr('DefinitionRulesEditor.excludedValuesOnePerLine')}
                  value={g.exclude ?? []}
                  onChange={exclude => set(i, { ...p, groups: { ...p.groups, [key]: { ...g, exclude } } })}
                />
              </div>
            ))}
            <DesignerField
              label={tr('DefinitionRulesEditor.captureIndex')}
              help={tr('DefinitionRulesEditor.0IsTheFullMatch')}
            >
              <Space wrap>
                <InputNumber
                  aria-label={tr('DefinitionRulesEditor.captureIndex0IsTheFullMatch')}
                  value={newGroup}
                  min={0}
                  max={99}
                  step={1}
                  onChange={v => {
                    if (Number.isInteger(v)) setNewGroup(Number(v));
                  }}
                />
                <Button
                  theme="borderless"
                  size="S"
                  disabled={Object.hasOwn(p.groups ?? {}, String(newGroup))}
                  onClick={() => set(i, { ...p, groups: { ...p.groups, [newGroup]: {} } })}
                >
                  {tr('DefinitionRulesEditor.addCaptureTransform')}
                </Button>
              </Space>
            </DesignerField>
          </details>
        </div>
      ))}
      <Button
        theme="borderless"
        onClick={() => onChange({ ...value, patterns: [...patterns, { pattern: '', template: '{0}' }] })}
      >
        {tr('DefinitionRulesEditor.addPattern')}
      </Button>
    </div>
  );
}
