import { ExpressionEditor } from './ExpressionEditor';
import { useState } from 'react';
import { Checkbox } from '@react-spectrum/s2';
import { t } from '../i18n';
import { Button, Input, InputNumber, Modal, Select } from '../ui';
import { IconPlus } from '../icons';
import { CollectionEditor } from '../components/CollectionEditor';
import { FormField, FormLayout } from '../components/FormLayout';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { useApp } from '../context';
import { localize } from './i18n';
import { PatternEditor } from './DefinitionRulesEditor';
import { writePolicies, WritePolicyField, WriteProtectionNote } from './WritePolicyField';
import { NormalizationPicker } from './NormalizationPicker';
import type { RelatedConfigChanges } from './config-related';
import type { Definition } from './types';

export function DefinitionEnrichment({
  definition: d,
  sources,
  rules,
  onChange,
}: {
  definition: Definition;
  sources: Record<string, any>;
  rules: Record<string, any>;
  onChange(d: Definition, change?: RelatedConfigChanges): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package,
    text = (v: any) => localize(v, app.locale, pack);
  const [writes, setWrites] = useState(d.writes);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, any>>({});
  const [editing, setEditing] = useState<any>(),
    [sourceDraft, setSourceDraft] = useState<any>();
  const rows = d.enrichment ?? [],
    policies = writePolicies(d, app.locale);
  const source = editing && (sourceDraft ?? sources[editing.source]),
    field = source?.parse?.fields?.[editing?.field];
  const sourceName = (key: string) => text(sources[key]?.label) || key;
  const fieldName = (row: any) => text(sources[row.source]?.parse?.fields?.[row.field]?.label) || row.field;
  const open = (row: any) => {
    setEditing(structuredClone(row));
    setSourceDraft(undefined);
    setRuleDrafts({});
    setWrites(structuredClone(d.writes));
  };
  const updateField = (next: any) =>
    setSourceDraft({
      ...source,
      parse: { ...source.parse, fields: { ...source.parse.fields, [editing.field]: next } },
    });
  const patchField = (patch: any) => {
    const next = { ...field, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    updateField(next);
  };
  return (
    <>
      <FormLayout>
        <FormField label={t('Enrichment.minimumAgreement')} description={t('Enrichment.agreementHelp')}>
          <InputNumber
            min={1}
            max={20}
            value={d.enrichmentPolicy?.minIndependentSources ?? 1}
            onChange={value => onChange({ ...d, enrichmentPolicy: { minIndependentSources: value } })}
          />
        </FormField>
      </FormLayout>
      <CollectionEditor
        label={t('DefinitionDesigner.externalMetadata')}
        title={t('DefinitionDesigner.externalMetadata')}
        count={rows.length ? String(rows.length) : ''}
        items={rows}
        columns={[
          { id: 'source', title: t('DefinitionDesigner.source'), render: r => sourceName(r.source) },
          { id: 'field', title: t('DefinitionDesigner.sourceProperty_5'), render: fieldName },
          {
            id: 'policy',
            title: t('DefinitionDesigner.writePolicy'),
            render: r => policies.find(p => p.value === r.apply)?.label ?? r.apply,
          },
        ]}
        actionsLabel={t('FacetEditor.actions')}
        emptyText={t('DefinitionDesigner.noEnrichment')}
        editLabel={r => t('DefinitionDesigner.editMapping', { name: sourceName(r.source) })}
        onEdit={open}
        removeLabel={r => t('DefinitionDesigner.removeMapping', { name: sourceName(r.source) })}
        onRemove={r => onChange({ ...d, enrichment: rows.filter(item => item.id !== r.id) })}
        actions={
          <Button
            size="S"
            icon={<IconPlus />}
            disabled={!Object.keys(sources).length}
            onClick={() => {
              const source = Object.keys(sources)[0];
              open({
                id: crypto.randomUUID(),
                source,
                field: Object.keys(sources[source].parse.fields)[0] ?? '',
                apply: 'suggest-only',
              });
            }}
          >
            {t('DefinitionDesigner.addSourceMapping')}
          </Button>
        }
      />
      <Modal
        mode="exclusive"
        width={760}
        title={t('DefinitionDesigner.externalMetadata')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{t('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              disabled={!field}
              onClick={() => {
                const usedRules = new Set(Object.values(source?.parse?.fields ?? {}).map((f: any) => f.normalizeWith));
                onChange(
                  {
                    ...d,
                    writes,
                    enrichment: rows.some(r => r.id === editing.id)
                      ? rows.map(r => (r.id === editing.id ? editing : r))
                      : [...rows, editing],
                  },
                  [
                    ...(sourceDraft ? [{ kind: 'sources', key: editing.source, value: sourceDraft }] : []),
                    ...Object.entries(ruleDrafts)
                      .filter(([key]) => usedRules.has(key))
                      .map(([key, value]) => ({ kind: 'rules', key, value })),
                  ],
                );
                setEditing(undefined);
                setSourceDraft(undefined);
              }}
            >
              {t('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing && (
          <FormLayout compact>
            <FormField layout="row" label={t('DefinitionDesigner.source')}>
              <Select
                aria-label={t('DefinitionDesigner.source')}
                value={editing.source}
                optionList={Object.keys(sources).map(value => ({ value, label: sourceName(value) }))}
                onChange={v => {
                  setSourceDraft(undefined);
                  setEditing({
                    ...editing,
                    source: String(v),
                    field: Object.keys(sources[String(v)]?.parse?.fields ?? {})[0] ?? '',
                  });
                }}
              />
            </FormField>
            <FormField layout="row" label={t('DefinitionDesigner.sourceProperty_5')}>
              <Select
                aria-label={t('DefinitionDesigner.sourceProperty_5')}
                value={editing.field}
                optionList={Object.entries(source?.parse?.fields ?? {}).map(([value, f]: any) => ({
                  value,
                  label: text(f.label) || value,
                }))}
                onChange={v => setEditing({ ...editing, field: String(v) })}
              />
            </FormField>
            <WritePolicyField
              definition={{ ...d, writes }}
              onPriorityChange={sourcePriority => setWrites({ ...writes, sourcePriority })}
              value={editing.apply}
              onChange={apply => setEditing({ ...editing, apply })}
            />
            {field && (
              <NormalizationPicker
                value={field.normalizeWith}
                rules={{ ...rules, ...ruleDrafts }}
                onChange={normalizeWith => patchField({ normalizeWith })}
                onEdit={(key, rule) => setRuleDrafts(current => ({ ...current, [key]: rule }))}
              />
            )}

            {source && (
              <details className="form-disclosure">
                <summary>{t('DefinitionDesigner.viewAndEditExtraction')}</summary>
                <FormLayout compact>
                  <p className="form-help">{t('DefinitionDesigner.editsBecomeAUserOverrideOfThis')}</p>
                  <FormField layout="row" label={t('DefinitionDesigner.sourceAddress')}>
                    <span className="config-path-value">
                      {source.transport === 'sidecar' ? source.extension : source.request?.urlTemplate}
                    </span>
                  </FormField>
                  {field && (
                    <>
                      <FormField layout="row" label={t('DefinitionDesigner.sourcePropertyLabel')}>
                        <LocalizedTextField
                          label={t('DefinitionDesigner.sourcePropertyLabel')}
                          value={field.label}
                          locale={app.locale}
                          onChange={label => patchField({ label })}
                        />
                      </FormField>
                      {source.parse.format === 'text' ? (
                        <PatternEditor value={field} onChange={updateField} />
                      ) : (
                        <FormField
                          layout="row"
                          label={
                            source.parse.format === 'json'
                              ? t('DefinitionDesigner.jsonPointer')
                              : t('DefinitionDesigner.elementPathSelector')
                          }
                        >
                          <Input
                            aria-label={
                              source.parse.format === 'json'
                                ? t('DefinitionDesigner.jsonPointer')
                                : t('DefinitionDesigner.elementPathSelector')
                            }
                            value={field[source.parse.format === 'json' ? 'pointer' : 'selector'] ?? ''}
                            onChange={v => patchField({ [source.parse.format === 'json' ? 'pointer' : 'selector']: v })}
                          />
                        </FormField>
                      )}
                      {source.parse.format === 'html' && (
                        <FormField
                          layout="row"
                          label={t('DefinitionDesigner.extractContent')}
                          description={t('DefinitionDesigner.enterTextOrAttributeName')}
                        >
                          <Input
                            aria-label={t('DefinitionDesigner.extractContent')}
                            value={field.extract ?? 'text'}
                            onChange={extract => patchField({ extract })}
                          />
                        </FormField>
                      )}
                      <FormField layout="row" label={t('DefinitionDesigner.readQuantity')}>
                        <Select
                          aria-label={t('DefinitionDesigner.readQuantity')}
                          value={field.cardinality ?? 'one'}
                          optionList={[
                            { value: 'one', label: t('DefinitionDesigner.firstMatch') },
                            { value: 'many', label: t('DefinitionDesigner.allMatches') },
                          ]}
                          onChange={cardinality => patchField({ cardinality })}
                        />
                      </FormField>

                      <Checkbox
                        isSelected={field.resolveUrl === true}
                        onChange={resolveUrl => patchField({ resolveUrl })}
                      >
                        {t('DefinitionDesigner.resolveRelativeUrls')}
                      </Checkbox>
                    </>
                  )}
                </FormLayout>
              </details>
            )}
            <FormField label={t('Enrichment.transform')}>
              <Checkbox
                isSelected={!!editing.transform}
                onChange={enabled => {
                  const next = { ...editing };
                  if (enabled) next.transform = { fact: 'source.value' };
                  else delete next.transform;
                  setEditing(next);
                }}
              >
                {t('Enrichment.transformEnabled')}
              </Checkbox>
              {editing.transform && (
                <ExpressionEditor
                  label={t('Enrichment.transform')}
                  value={editing.transform}
                  onChange={transform => setEditing({ ...editing, transform })}
                />
              )}
            </FormField>
            <FormField label={t('Enrichment.evidenceGroup')} description={t('Enrichment.evidenceGroupHelp')}>
              <Input
                value={source?.evidenceGroup ?? editing.source}
                onChange={evidenceGroup => setSourceDraft({ ...source, evidenceGroup })}
              />
            </FormField>
            <WriteProtectionNote />
          </FormLayout>
        )}
      </Modal>
    </>
  );
}
