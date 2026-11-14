import { useState } from 'react';
import { t } from '../i18n';
import { Button, Modal, Select } from '../ui';
import { IconEdit, IconPlus } from '../icons';
import { FormField, FormLayout } from '../components/FormLayout';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { useApp } from '../context';
import { localize } from './i18n';
import { editorGuidance } from './config-editor';
import { ComponentSettings } from './DesignerFields';
import { displayStyleLabel, displayStylePositions } from './display-style';
import type { Definition, LocalizedText } from './types';
import registry from '../../../../resources/tagging/host-capabilities.json';

/** Style identity stays stable when its user-facing name changes. Placements reference that identity. */
export function DisplayStylesEditor({
  definition: d,
  onChange,
}: {
  definition: Definition;
  onChange(d: Definition): void;
}) {
  const { data, locale } = useApp(),
    pack = data.tagging.package;
  const [editing, setEditing] = useState<{ key: string; label: LocalizedText; isNew?: boolean }>();
  const name = (key: string) => displayStyleLabel(d, key, locale, pack);
  const slotName = (slot: string) =>
    localize((editorGuidance.slots as Record<string, LocalizedText>)[slot], locale, pack) || slot;
  return (
    <>
      {Object.entries(d.display ?? {}).map(([key, spec]) => {
        const positions = displayStylePositions(d, key);
        return (
          <section className="designer-display-style" key={key} aria-label={name(key)}>
            <header className="display-style-heading">
              <h4>{name(key)}</h4>
              <Button
                size="S"
                theme="borderless"
                icon={<IconEdit />}
                aria-label={t('DisplayStyle.rename', { name: name(key) })}
                onClick={() =>
                  setEditing({
                    key,
                    label: spec.label ?? { [pack.i18n.defaultLocale]: name(key) },
                  })
                }
              />
            </header>
            <p className="form-help display-style-usage">
              {positions.length
                ? t('DisplayStyle.usedAt', {
                    locations: new Intl.ListFormat(locale).format([...new Set(positions.map(p => slotName(p.slot)))]),
                  })
                : t(key === 'default' ? 'DisplayStyle.defaultUsage' : 'DisplayStyle.notPlaced')}
            </p>
            <ComponentSettings
              label={t('DefinitionDesigner.displayControl')}
              component={spec.component}
              value={spec.props}
              onChange={props => onChange({ ...d, display: { ...d.display, [key]: { ...spec, props } } })}
              selector={
                <Select
                  aria-label={t('DefinitionDesigner.displayControl') + ' ' + name(key)}
                  value={spec.component}
                  optionList={Object.entries(registry.components)
                    .filter(
                      ([, p]) =>
                        p.role === 'display' &&
                        (!('types' in p) || (p.types as string[]).includes(d.value.schema.type)),
                    )
                    .map(([value, p]) => ({ value, label: localize(p.label, locale, pack) }))}
                  onChange={v =>
                    onChange({ ...d, display: { ...d.display, [key]: { ...spec, component: String(v) } } })
                  }
                />
              }
            />
          </section>
        );
      })}
      <div>
        <Button
          size="S"
          icon={<IconPlus />}
          onClick={() =>
            setEditing({
              key: Object.keys(d.display ?? {}).length ? 'style-' + crypto.randomUUID() : 'default',
              label: { [pack.i18n.defaultLocale]: '' },
              isNew: true,
            })
          }
        >
          {t('DisplayStyle.add')}
        </Button>
      </div>
      <Modal
        mode="exclusive"
        title={t('DisplayStyle.name')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{t('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              disabled={!editing || !localize(editing.label, locale, pack).trim()}
              onClick={() => {
                if (!editing) return;
                onChange({
                  ...d,
                  display: {
                    ...d.display,
                    [editing.key]: {
                      ...(editing.isNew ? { component: 'text-display@1' } : d.display![editing.key]),
                      label: editing.label,
                    },
                  },
                });
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
            <FormField layout="row" label={t('DisplayStyle.name')}>
              <LocalizedTextField
                label={t('DisplayStyle.name')}
                value={editing.label}
                locale={locale}
                onChange={label => setEditing({ ...editing, label })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
    </>
  );
}
