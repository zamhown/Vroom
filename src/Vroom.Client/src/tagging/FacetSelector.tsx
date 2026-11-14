import { useState } from 'react';
import { t } from '../i18n';
import { Button, Input, Modal, Select } from '../ui';
import { IconPlus } from '../icons';
import { FormField, FormLayout } from '../components/FormLayout';
import { useApp } from '../context';
import { localize } from './i18n';
import { FacetBandsEditor } from './FacetEditor';
import type { Definition } from './types';

/** All changes stay in the parent rule's draft, including newly created band groups. */
export function FacetSelector({
  definition,
  selected,
  onChange,
}: {
  definition: Definition;
  selected: string;
  onChange(facets: NonNullable<Definition['facets']>, selected: string): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package,
    facets = definition.facets ?? {};
  const [creating, setCreating] = useState(false),
    [name, setName] = useState('');
  return (
    <FormLayout compact>
      <FormField
        layout="row"
        label={t('RuleFlow.classification')}
        actions={
          <Button
            size="S"
            icon={<IconPlus />}
            onClick={() => {
              setName('');
              setCreating(true);
            }}
          >
            {t('RuleFlow.createClassification')}
          </Button>
        }
      >
        <Select
          aria-label={t('RuleFlow.classification')}
          value={selected}
          optionList={Object.entries(facets).map(([value, f]) => ({
            value,
            label: localize(f.label, app.locale, pack) || value,
          }))}
          onChange={v => onChange(facets, String(v))}
        />
      </FormField>
      {facets[selected] && (
        <FacetBandsEditor
          value={facets[selected]}
          schema={definition.value.schema}
          onChange={value => onChange({ ...facets, [selected]: value }, selected)}
        />
      )}
      <Modal
        mode="exclusive"
        title={t('RuleFlow.createClassification')}
        visible={creating}
        onCancel={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{t('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              disabled={!name.trim()}
              onClick={() => {
                const key = 'bands-' + crypto.randomUUID(),
                  defaultLocale = pack.i18n.defaultLocale;
                onChange(
                  {
                    ...facets,
                    [key]: {
                      kind: 'numeric-bands',
                      label: { [defaultLocale]: name.trim() },
                      bands: [],
                    },
                  },
                  key,
                );
                setCreating(false);
              }}
            >
              {t('RuleFlow.createAndUse')}
            </Button>
          </>
        }
      >
        <FormLayout compact>
          <FormField layout="row" label={t('FacetEditor.bandGroupName')}>
            <Input aria-label={t('FacetEditor.bandGroupName')} value={name} onChange={setName} />
          </FormField>
        </FormLayout>
      </Modal>
    </FormLayout>
  );
}
