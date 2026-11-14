import { useState } from 'react';
import { t } from '../i18n';
import { Button, Modal, Select } from '../ui';
import { IconEdit, IconPlus } from '../icons';
import { FormField, FormLayout } from '../components/FormLayout';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { useApp } from '../context';
import { localize } from './i18n';
import { PatternEditor } from './DefinitionRulesEditor';

export function NormalizationPicker({
  value,
  rules,
  onChange,
  onEdit,
}: {
  value?: string;
  rules: Record<string, any>;
  onChange(value?: string): void;
  onEdit(key: string, rule: any): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package;
  const [editing, setEditing] = useState<{ key: string; rule: any; isNew: boolean }>();
  return (
    <>
      <FormField
        layout="row"
        label={t('Normalization.processText')}
        description={t(value ? 'Normalization.appliedEffect' : 'Normalization.keepEffect')}
        actions={
          <>
            <Button
              size="S"
              icon={<IconPlus />}
              onClick={() =>
                setEditing({
                  key: 'user.rules.' + crypto.randomUUID(),
                  isNew: true,
                  rule: {
                    label: { [pack.i18n.defaultLocale]: '' },
                    patterns: [{ pattern: '(.*)', template: '{1}' }],
                  },
                })
              }
            >
              {t('Normalization.create')}
            </Button>
            {value && rules[value] && (
              <Button
                size="S"
                icon={<IconEdit />}
                onClick={() => setEditing({ key: value, rule: structuredClone(rules[value]), isNew: false })}
              >
                {t('Normalization.edit')}
              </Button>
            )}
          </>
        }
      >
        <Select
          aria-label={t('Normalization.processText')}
          value={value ?? ''}
          optionList={[
            { value: '', label: t('DefinitionDesigner.keepOriginal') },
            ...Object.entries(rules).map(([value, r]) => ({
              value,
              label: localize(r.label, app.locale, pack) || value,
            })),
          ]}
          onChange={v => onChange(String(v) || undefined)}
        />
      </FormField>
      <Modal
        mode="exclusive"
        width={760}
        title={t(editing?.isNew ? 'Normalization.create' : 'Normalization.edit')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{t('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              disabled={
                !editing ||
                !localize(editing.rule.label, app.locale, pack).trim() ||
                !editing.rule.patterns?.length ||
                editing.rule.patterns.some((p: any) => !p.pattern)
              }
              onClick={() => {
                onEdit(editing!.key, editing!.rule);
                onChange(editing!.key);
                setEditing(undefined);
              }}
            >
              {t('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing && (
          <FormLayout compact>
            <FormField layout="row" label={t('Normalization.name')}>
              <LocalizedTextField
                label={t('Normalization.name')}
                value={editing.rule.label}
                locale={app.locale}
                onChange={label => setEditing({ ...editing, rule: { ...editing.rule, label } })}
              />
            </FormField>
            {!editing.isNew && <p className="form-help">{t('Normalization.shared')}</p>}
            <PatternEditor value={editing.rule} onChange={rule => setEditing({ ...editing, rule })} />
          </FormLayout>
        )}
      </Modal>
    </>
  );
}
