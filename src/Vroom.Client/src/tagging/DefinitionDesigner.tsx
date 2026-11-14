import type { RelatedConfigChanges } from './config-related';
import { ConditionRules } from './ConditionRules';
import { t as appText, translate } from '../i18n';
import { useState, type ReactNode } from 'react';
import { Checkbox, SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2';
import { Banner, Input, InputNumber, Select } from '../ui';
import { FormField, FormSection } from '../components/FormLayout';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { TagSelect } from '../components/TagSelect';
import { useApp } from '../context';
import { AnnotationTargetPicker } from './AnnotationTargetPicker';
import {
  changeInput,
  compatibleInput,
  inputCapabilities,
  valueType,
  valueTypes,
  type ValueType,
} from './definition-designer';
import { prepareValueType } from './option-list';
import { OptionListEditor } from './OptionListEditor';
import { localize } from './i18n';
import { FacetEditor } from './FacetEditor';
import { SchemaIcon } from '../icon-catalog';
import { ComponentSettings, DesignerField } from './DesignerFields';
import { RuleList } from './DefinitionRulesEditor';
import { DisplayStylesEditor } from './DisplayStylesEditor';
import { DefinitionPlacements } from './DefinitionPlacements';
import { DefinitionEnrichment } from './DefinitionEnrichment';
import { DefinitionPreview } from './DefinitionPreview';
import { QueryPreview } from './QueryPreview';
import { PreviewDock } from './PreviewDock';
import type { Definition } from './types';

export type { RelatedConfigChange } from './option-list';
export function DefinitionDesigner({
  value: d,
  onChange,
  vocabularies,
  sources,
  rules,
  changes,
  placementOrder = {},
}: {
  value: Definition;
  onChange(d: Definition, change?: RelatedConfigChanges): void;
  /** Region member order including unpublished drafts. */
  placementOrder?: Record<string, string[]>;
  vocabularies: Record<string, any>;
  sources: Record<string, any>;
  rules: Record<string, any>;
  changes(): any[];
}) {
  const app = useApp(),
    pack = app.data.tagging.package,
    locale = app.locale;
  const tr = (key: string) => translate(key, locale),
    t = (v: any) => localize(v, locale, pack);
  const [panel, setPanel] = useState('basics');
  const update = (patch: Partial<Definition>) => onChange({ ...d, ...patch });
  const row = (label: string, control: ReactNode, help?: string, actions?: ReactNode) => (
    <FormField className="designer-row" layout="row" label={label} description={help} actions={actions}>
      {control}
    </FormField>
  );
  const numeric = ['integer', 'number'].includes(d.value.schema.type),
    enumerable = !!d.value.vocabulary;
  const schema = (key: string, value: any) => {
    const next = { ...d.value.schema };
    if (value == null || (typeof value === 'number' && Number.isNaN(value))) delete next[key];
    else next[key] = value;
    update({ value: { ...d.value, schema: next } });
  };
  const film = d.targets.includes('film-whole'),
    type = valueType(d),
    recommended = valueTypes[type]?.recommendedInput;
  const collectionOptions = Object.entries(vocabularies).map(([value, v]) => ({ value, label: t(v.label) }));
  return (
    <div className="definition-designer">
      <div className="designer-tabs">
        <SegmentedControl
          aria-label={tr('DefinitionDesigner.configurationTask')}
          selectedKey={panel}
          onSelectionChange={key => setPanel(String(key))}
        >
          <SegmentedControlItem id="basics">{tr('DefinitionDesigner.basics')}</SegmentedControlItem>
          <SegmentedControlItem id="input">{tr('DefinitionDesigner.editing')}</SegmentedControlItem>
          <SegmentedControlItem id="display">{tr('DefinitionDesigner.displaying')}</SegmentedControlItem>
          <SegmentedControlItem id="query">{tr('DefinitionDesigner.query')}</SegmentedControlItem>
          <SegmentedControlItem id="sources">{tr('DefinitionDesigner.automation')}</SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div className="designer-scroll" key={panel}>
        {panel === 'basics' && (
          <section className="designer-section" aria-label={tr('DefinitionDesigner.basics')}>
            {row(
              tr('DefinitionDesigner.name'),
              <LocalizedTextField
                label={tr('DefinitionDesigner.name')}
                value={d.label}
                locale={locale}
                onChange={label => update({ label })}
              />,
            )}
            {row(
              tr('DefinitionDesigner.description'),
              <LocalizedTextField
                label={tr('DefinitionDesigner.description')}
                value={d.description}
                locale={locale}
                multiline
                onChange={description => update({ description })}
              />,
            )}
            {row(
              tr('DefinitionDesigner.valueType'),
              <Select
                aria-label={tr('DefinitionDesigner.valueType')}
                value={type}
                optionList={Object.entries(valueTypes).map(([value, p]) => ({
                  value,
                  label: t(p.label),
                  icon: <SchemaIcon slot="icon" name={p.icon} />,
                }))}
                onChange={v => {
                  const next = prepareValueType(d, String(v) as ValueType);
                  onChange(next.definition, next.collection);
                }}
              />,
              tr('DefinitionDesigner.chooseWhatToStoreTheInputIs'),
              type === 'text' && (
                <details className="designer-advanced form-disclosure">
                  <summary>{tr('DefinitionDesigner.textConstraints')}</summary>
                  <div className="designer-fields">
                    <DesignerField label={tr('DefinitionDesigner.maximumLength')}>
                      <InputNumber
                        aria-label={tr('DefinitionDesigner.maximumLength')}
                        value={d.value.schema.maxLength ?? null}
                        min={0}
                        onChange={v => schema('maxLength', v)}
                      />
                    </DesignerField>
                    <DesignerField label={tr('DefinitionDesigner.validationPattern')}>
                      <Input
                        aria-label={tr('DefinitionDesigner.validationPattern')}
                        value={d.value.schema.pattern ?? ''}
                        onChange={v => schema('pattern', v || undefined)}
                      />
                    </DesignerField>
                  </div>
                </details>
              ),
            )}
            {numeric &&
              row(
                tr('DefinitionDesigner.valueConstraints'),
                <div className="designer-fields designer-constraints">
                  {['minimum', 'maximum', 'multipleOf'].map((key, i) => (
                    <DesignerField
                      key={key}
                      label={
                        [
                          appText('DefinitionDesigner.minimum'),
                          appText('DefinitionDesigner.maximum'),
                          appText('DefinitionDesigner.step'),
                        ][i]
                      }
                    >
                      <InputNumber
                        aria-label={
                          [
                            appText('DefinitionDesigner.minimum'),
                            appText('DefinitionDesigner.maximum'),
                            appText('DefinitionDesigner.step'),
                          ][i]
                        }
                        value={d.value.schema[key] ?? null}
                        onChange={v => schema(key, v)}
                        min={key === 'multipleOf' ? Number.EPSILON : undefined}
                      />
                    </DesignerField>
                  ))}
                </div>,
              )}
            {enumerable && (
              <>
                {row(
                  tr('DefinitionDesigner.options'),
                  <OptionListEditor
                    key={d.value.vocabulary}
                    definition={d}
                    vocabularies={vocabularies}
                    onChange={onChange}
                  />,
                )}
                {row(
                  tr('DefinitionDesigner.optionEditing'),
                  <div className="designer-checks">
                    <Checkbox
                      isSelected={!!d.writes?.createTerms}
                      onChange={v =>
                        update({
                          writes: {
                            ...d.writes,
                            createTerms: v ? { namespace: 'user.term' } : undefined,
                          },
                        })
                      }
                    >
                      {tr('DefinitionDesigner.allowNewOptionsWhileEntering')}
                    </Checkbox>
                  </div>,
                )}
              </>
            )}
            {row(
              tr('DefinitionDesigner.subjects'),
              <AnnotationTargetPicker
                label={tr('DefinitionDesigner.subjects')}
                value={d.targets}
                onChange={targets => {
                  const next = { ...d, targets };
                  if (!targets.includes('term-whole')) delete next.subjectVocabularies;
                  onChange(next);
                }}
              />,
            )}
            {d.targets.includes('term-whole') &&
              row(
                tr('DefinitionDesigner.subjectCollections'),
                <TagSelect
                  multiple
                  label={tr('DefinitionDesigner.subjectCollections')}
                  value={d.subjectVocabularies ?? []}
                  options={collectionOptions.map(o => ({ id: o.value, label: o.label, value: o.value }))}
                  onChange={items => update({ subjectVocabularies: items.map(i => i.id) })}
                  placeholder={tr('DefinitionDesigner.allCollections')}
                  emptyText={tr('DefinitionDesigner.noCollections')}
                  createLabel={s => s}
                />,
                tr('DefinitionDesigner.emptyMeansAllValueEntitiesThisRestricts'),
              )}
            {row(
              tr('DefinitionDesigner.configurationGroup'),
              <Select
                aria-label={tr('DefinitionDesigner.configurationGroup')}
                value={d.group ?? ''}
                optionList={[
                  { value: '', label: tr('DefinitionDesigner.none') },
                  ...Object.entries(pack.groups ?? {}).map(([value, g]) => ({ value, label: t(g.label) })),
                ]}
                onChange={v => {
                  const next = { ...d };
                  if (v) next.group = String(v);
                  else delete next.group;
                  onChange(next);
                }}
              />,
            )}
          </section>
        )}
        {panel === 'input' && (
          <section
            className="designer-section designer-input-form designer-task-sections"
            aria-label={tr('DefinitionDesigner.editing')}
          >
            <FormSection title={tr('DefinitionDesigner.controlAndPermissions')}>
              <ComponentSettings
                label={tr('DefinitionDesigner.inputControl')}
                component={d.input.component}
                value={d.input.props}
                onChange={props => update({ input: { ...d.input, props } })}
                selector={
                  <Select
                    aria-label={tr('DefinitionDesigner.inputControl')}
                    value={d.input.component}
                    optionList={inputCapabilities
                      .filter(([, p]) => p.cardinality === d.value.cardinality && p.types.includes(d.value.schema.type))
                      .map(([value, p]) => ({
                        value,
                        label: t(p.label) + (value === recommended ? tr('DefinitionDesigner.recommended') : ''),
                        disabled: !compatibleInput(d, value),
                        icon: <SchemaIcon slot="icon" name={'icon' in p ? String(p.icon) : undefined} />,
                      }))}
                    onChange={v => onChange(changeInput(d, String(v)))}
                  />
                }
                description={tr('DefinitionDesigner.onlyCompatibleControlsAreOfferedSwitchingNever')}
                notes={
                  numeric &&
                  inputCapabilities
                    .filter(([id, p]) => p.types.includes(d.value.schema.type) && !compatibleInput(d, id))
                    .map(([id, p]) => (
                      <p className="designer-help" key={id}>
                        {t(p.label)}: {t((p as any).requirementHelp)}
                      </p>
                    ))
                }
              />

              {row(
                tr('DefinitionDesigner.editPermissions'),
                <div className="designer-checks designer-checks-stack">
                  <Checkbox
                    isSelected={d.writes?.manual !== false}
                    onChange={manual => update({ writes: { ...d.writes, manual } })}
                  >
                    {tr('DefinitionDesigner.allowManualEdits')}
                  </Checkbox>
                  <Checkbox
                    isDisabled={d.writes?.manual === false}
                    isSelected={d.writes?.manualClearBlocksAutomatic !== false}
                    onChange={manualClearBlocksAutomatic =>
                      update({ writes: { ...d.writes, manualClearBlocksAutomatic } })
                    }
                  >
                    {tr('DefinitionDesigner.doNotRefillManuallyClearedValues')}
                  </Checkbox>
                </div>,
              )}

              <DefinitionPlacements definition={d} purpose="edit" order={placementOrder} onChange={onChange} />
            </FormSection>
          </section>
        )}
        {panel === 'display' && (
          <section className="designer-section designer-task-sections" aria-label={tr('DefinitionDesigner.displaying')}>
            <FormSection title={tr('DefinitionDesigner.displayStyle')}>
              <DisplayStylesEditor definition={d} onChange={onChange} />
              <DefinitionPlacements definition={d} purpose="display" order={placementOrder} onChange={onChange} />
            </FormSection>
          </section>
        )}
        {panel === 'query' && (
          <section className="designer-section designer-task-sections" aria-label={tr('DefinitionDesigner.query')}>
            <FormSection title={tr('DefinitionDesigner.queryFeatures')}>
              {row(
                tr('DefinitionDesigner.queryUsage'),
                <div className="designer-checks">
                  {(['filter', 'sort', 'deduplicate'] as const).map((key, i) => (
                    <Checkbox
                      key={key}
                      isSelected={d.query?.[key] === true}
                      onChange={v => update({ query: { ...d.query, [key]: v } })}
                    >
                      {
                        [
                          appText('DefinitionDesigner.filter'),
                          appText('DefinitionDesigner.sort'),
                          appText('DefinitionDesigner.deduplicate'),
                        ][i]
                      }
                    </Checkbox>
                  ))}
                </div>,
              )}
              {row(
                tr('DefinitionDesigner.grouping'),
                <div className="designer-checks">
                  {[
                    { key: 'value', label: tr('DefinitionDesigner.groupValue') },
                    ...(d.value.cardinality === 'many'
                      ? [{ key: 'member', label: tr('DefinitionDesigner.groupMember') }]
                      : []),
                    ...(Object.keys(d.facets ?? {}).length
                      ? [{ key: 'facet', label: tr('DefinitionDesigner.groupFacet') }]
                      : []),
                  ].map(({ key, label }) => (
                    <Checkbox
                      key={key}
                      isSelected={d.query?.groupBy?.includes(key) === true}
                      onChange={checked =>
                        update({
                          query: {
                            ...d.query,
                            groupBy: checked
                              ? [...(d.query?.groupBy ?? []), key]
                              : (d.query?.groupBy ?? []).filter(value => value !== key),
                          },
                        })
                      }
                    >
                      {label}
                    </Checkbox>
                  ))}
                </div>,
              )}
            </FormSection>
            {numeric && <FacetEditor definition={d} onChange={onChange} />}
            <DefinitionPlacements definition={d} purpose="navigate" order={placementOrder} onChange={onChange} />
          </section>
        )}
        {panel === 'sources' && (
          <section className="designer-section designer-task-sections" aria-label={tr('DefinitionDesigner.automation')}>
            {!film && !d.targets.includes('term-whole') ? (
              <Banner type="info" description={tr('DefinitionDesigner.discoveryAndMediaEnrichmentApplyToWhole')} />
            ) : (
              <>
                {film && (
                  <div className="designer-automation-group">
                    <ConditionRules
                      definition={d}
                      catalog={{ ...pack, vocabularies }}
                      onChange={onChange}
                      changes={changes}
                    />
                  </div>
                )}
                {film && (
                  <div className="designer-automation-group">
                    <RuleList definition={d} kind="initialization" onChange={onChange} />
                  </div>
                )}
                <div className="designer-automation-group">
                  <DefinitionEnrichment definition={d} sources={sources} rules={rules} onChange={onChange} />
                </div>
                <div className="designer-automation-group">
                  <RuleList definition={d} kind="automation" onChange={onChange} />
                </div>
              </>
            )}
          </section>
        )}
      </div>
      {['input', 'display', 'query'].includes(panel) && (
        <PreviewDock
          title={tr(
            panel === 'input'
              ? 'DefinitionPreview.editPreview'
              : panel === 'display'
                ? 'DefinitionPreview.displayPreview'
                : 'DefinitionPreview.queryPreview',
          )}
        >
          {panel === 'query' ? (
            <QueryPreview definition={d} catalog={{ ...pack, vocabularies }} docked />
          ) : (
            <DefinitionPreview
              key={panel}
              definition={d}
              catalog={{ ...pack, vocabularies }}
              purpose={panel === 'input' ? 'edit' : 'display'}
              docked
            />
          )}
        </PreviewDock>
      )}
    </div>
  );
}
