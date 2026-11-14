import { t as appText, translate } from '../i18n';
import { useState } from 'react';
import { Button, InputNumber, Modal, TextArea } from '../ui';
import { useApp } from '../context';
import { localize } from './i18n';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { CollectionEditor } from '../components/CollectionEditor';
import { FormField, FormLayout } from '../components/FormLayout';
import { IconPlus, IconSetting } from '../icons';
import type { Definition } from './types';

/** Numeric bands are data. No built-in tag names or score scale are assumed. */
export function FacetEditor({ definition: d, onChange }: { definition: Definition; onChange(d: Definition): void }) {
  const app = useApp(),
    { locale } = app,
    defaultLocale = app.data.tagging.package.i18n.defaultLocale,
    tr = (key: string) => translate(key, locale);
  const update = (key: string, value: any) => onChange({ ...d, facets: { ...d.facets, [key]: value } });
  return (
    <details className="designer-advanced form-disclosure">
      <summary>{tr('FacetEditor.valueBandsAndPathAliases')}</summary>
      <p className="designer-help">{tr('FacetEditor.rangesClassifyValuesAMatchingPathAlias')}</p>
      <div className="form-collection-stack">
        {Object.entries(d.facets ?? {}).map(([key, facet]) => (
          <FacetBandsEditor
            key={key}
            value={facet}
            schema={d.value.schema}
            onChange={value => update(key, value)}
            onRemove={() => {
              const facets = { ...d.facets };
              delete facets[key];
              onChange({ ...d, facets });
            }}
          />
        ))}
        <Button
          size="S"
          icon={<IconPlus />}
          onClick={() =>
            update('bands-' + crypto.randomUUID().slice(0, 8), {
              kind: 'numeric-bands',
              label: { [defaultLocale]: translate('FacetEditor.valueBands', defaultLocale) },
              bands: [],
            })
          }
        >
          {tr('FacetEditor.addBandGroup')}
        </Button>
      </div>
    </details>
  );
}

/** The definition and path-rule editors share the same band overview and item editor. */
export function FacetBandsEditor({
  value: facet,
  onChange,
  onRemove,
  schema = {},
  aliasesOnly = false,
}: {
  value: any;
  onChange(value: any): void;
  onRemove?(): void;
  schema?: Record<string, any>;
  aliasesOnly?: boolean;
}) {
  const app = useApp(),
    { locale } = app,
    defaultLocale = app.data.tagging.package.i18n.defaultLocale,
    tr = (key: string) => translate(key, locale),
    t = (value: any) => localize(value, locale, app.data.tagging.package);
  const [editing, setEditing] = useState<{ band: any; isNew: boolean }>(),
    [settings, setSettings] = useState(false),
    [groupLabel, setGroupLabel] = useState<any>();
  const bands: any[] = facet.bands ?? [],
    title = t(facet.label) || tr('FacetEditor.unnamedBandGroup');
  const bandName = (band: any) => t(band.label) || tr('FacetEditor.unnamedBand');
  const patch = (value: Record<string, any>) =>
    setEditing(current => current && { ...current, band: { ...current.band, ...value } });
  const apply = () => {
    if (!editing) return;
    const next = editing.isNew
      ? [...bands, editing.band]
      : bands.map(band =>
          band.id === editing.band.id
            ? aliasesOnly
              ? { ...band, matchAliases: editing.band.matchAliases }
              : editing.band
            : band,
        );
    onChange({ ...facet, bands: next });
    setEditing(undefined);
  };
  return (
    <>
      <CollectionEditor
        label={title}
        title={title}
        count={`${bands.length} ${tr('FacetEditor.bands')}`}
        items={bands}
        actionsLabel={tr('FacetEditor.actions')}
        columns={[
          {
            id: 'name',
            title: tr('FacetEditor.band'),
            render: band => <span title={bandName(band)}>{bandName(band)}</span>,
          },
          {
            id: 'range',
            title: tr('FacetEditor.rangeInclusive'),
            render: band => `${band.gte ?? '—'} – ${band.lte ?? '—'}`,
          },
          { id: 'value', title: tr('FacetEditor.valueToWrite'), render: band => String(band.representative ?? '—') },
          {
            id: 'aliases',
            title: tr('FacetEditor.pathAliases'),
            wide: true,
            render: band => (
              <span title={(band.matchAliases ?? []).join('、')}>{(band.matchAliases ?? []).join('、') || '—'}</span>
            ),
          },
        ]}
        editLabel={band =>
          aliasesOnly ? appText('FacetEditor.editAliases') : appText('FacetEditor.editBand') + bandName(band)
        }
        removeLabel={band => tr('FacetEditor.removeBand') + bandName(band)}
        onEdit={band => setEditing({ band: structuredClone(band), isNew: false })}
        onRemove={
          aliasesOnly ? undefined : band => onChange({ ...facet, bands: bands.filter(item => item.id !== band.id) })
        }
        emptyText={
          aliasesOnly ? tr('FacetEditor.thisGroupHasNoBandsAddThem') : tr('FacetEditor.noBandsYetAddAValueRange')
        }
        actions={
          !aliasesOnly && (
            <>
              <Button
                size="S"
                icon={<IconSetting />}
                aria-label={tr('FacetEditor.bandGroupSettings') + title}
                onClick={() => {
                  setGroupLabel(structuredClone(facet.label));
                  setSettings(true);
                }}
              >
                {tr('FacetEditor.groupSettings')}
              </Button>
              <Button
                size="S"
                icon={<IconPlus />}
                onClick={() =>
                  setEditing({
                    isNew: true,
                    band: {
                      id: crypto.randomUUID(),
                      label: {
                        defaultLocale,
                        values: { [defaultLocale]: translate('FacetEditor.newBand', defaultLocale) },
                      },
                      gte: schema.minimum ?? 0,
                      lte: schema.maximum ?? 100,
                      representative: schema.minimum ?? 0,
                      matchAliases: [],
                    },
                  })
                }
              >
                {tr('FacetEditor.addBand')}
              </Button>
            </>
          )
        }
      />
      <Modal
        mode="exclusive"
        title={
          editing?.isNew
            ? tr('FacetEditor.addBand')
            : aliasesOnly
              ? appText('FacetEditor.editPathAliases')
              : appText('FacetEditor.editBand2')
        }
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{tr('FacetEditor.cancel')}</Button>
            <Button theme="solid" onClick={apply}>
              {tr('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing && (
          <FormLayout compact>
            <FormField layout="row" label={tr('FacetEditor.bandName')}>
              {aliasesOnly ? (
                <span>{bandName(editing.band)}</span>
              ) : (
                <LocalizedTextField
                  label={tr('FacetEditor.bandName')}
                  value={editing.band.label}
                  locale={locale}
                  onChange={label => patch({ label })}
                />
              )}
            </FormField>
            {!aliasesOnly &&
              (['gte', 'lte'] as const).map((key, index) => (
                <FormField
                  key={key}
                  layout="row"
                  label={[appText('FacetEditor.minimumInclusive'), appText('FacetEditor.maximumInclusive')][index]}
                >
                  <InputNumber
                    aria-label={
                      [appText('FacetEditor.minimumInclusive'), appText('FacetEditor.maximumInclusive')][index]
                    }
                    value={editing.band[key] ?? null}
                    onChange={value => {
                      if (Number.isFinite(value)) patch({ [key]: value });
                    }}
                  />
                </FormField>
              ))}
            <FormField
              layout="row"
              label={tr('FacetEditor.valueToWrite')}
              description={tr('FacetEditor.thisValueIsWrittenWhenAPath')}
            >
              {aliasesOnly ? (
                <span>{String(editing.band.representative ?? '—')}</span>
              ) : (
                <InputNumber
                  aria-label={tr('FacetEditor.valueToWrite')}
                  value={editing.band.representative ?? null}
                  onChange={representative => {
                    if (Number.isFinite(representative)) patch({ representative });
                  }}
                />
              )}
            </FormField>
            <FormField
              layout="row"
              label={tr('FacetEditor.pathAliases')}
              description={tr('FacetEditor.oneAliasPerLine')}
            >
              <TextArea
                aria-label={tr('FacetEditor.pathAliases')}
                rows={2}
                value={(editing.band.matchAliases ?? []).join('\n')}
                onChange={value => patch({ matchAliases: value.split('\n') })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
      <Modal
        mode="exclusive"
        title={tr('FacetEditor.bandGroupSettings_8')}
        visible={settings}
        onCancel={() => setSettings(false)}
        footer={
          <>
            {onRemove && (
              <Button
                type="danger"
                onClick={() => {
                  onRemove();
                  setSettings(false);
                }}
              >
                {tr('FacetEditor.removeBandGroup')}
              </Button>
            )}
            <Button onClick={() => setSettings(false)}>{tr('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              onClick={() => {
                onChange({ ...facet, label: groupLabel });
                setSettings(false);
              }}
            >
              {tr('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        <FormLayout compact>
          <FormField layout="row" label={tr('FacetEditor.bandGroupName')}>
            <LocalizedTextField
              label={tr('FacetEditor.bandGroupName')}
              value={groupLabel}
              locale={locale}
              onChange={setGroupLabel}
            />
          </FormField>
        </FormLayout>
      </Modal>
    </>
  );
}
