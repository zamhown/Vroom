import { useState } from 'react';
import { t } from '../i18n';
import { Button, Modal, Select } from '../ui';
import { IconChevronDown, IconChevronUp, IconPlus } from '../icons';
import { CollectionEditor } from '../components/CollectionEditor';
import { FormField, FormLayout } from '../components/FormLayout';
import { useApp } from '../context';
import { localize } from './i18n';
import { displayStyleLabel } from './display-style';
import { editorGuidance } from './config-editor';
import { placementChoices } from './definition-designer';
import type { Definition, Placement } from './types';
import { comparePlacements } from './LayoutFrame';
import type { RelatedConfigChange } from './option-list';

export type PlacementPurpose = 'edit' | 'display' | 'navigate';
export function placementPurpose(p: Placement): PlacementPurpose {
  return p.mode;
}

/** A position is edited under its purpose. The stored placement remains the one public contract. */
export function DefinitionPlacements({
  definition: d,
  purpose,
  order,
  onChange,
}: {
  definition: Definition;
  purpose: PlacementPurpose;
  order: Record<string, string[]>;
  onChange(d: Definition, change?: RelatedConfigChange): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package;
  const text = (value: any) => localize(value, app.locale, pack);
  const title = t('DefinitionDesigner.positions.' + purpose);
  const allSlots = placementChoices(pack, d);
  const slotName = (id: string) => text((editorGuidance.slots as any)[id]) || id;
  const items = d.placements.filter(p => placementPurpose(p) === purpose);
  const [editing, setEditing] = useState<Placement>();
  const currentPurpose = editing?.mode ?? purpose;
  const slots = allSlots.filter(s =>
    currentPurpose === 'navigate' ? s.id.startsWith('nav.') : !s.id.startsWith('nav.'),
  );
  const displayNames = Object.keys(d.display ?? {});
  const views = [
    ...(currentPurpose === 'edit' ? [{ value: 'input', label: t('DefinitionDesigner.inputControl') }] : []),
    ...(currentPurpose === 'navigate'
      ? [{ value: 'navigation', label: t('DefinitionDesigner.categoryFilter') }]
      : (displayNames.length ? displayNames : ['default']).map(key => ({
          value: 'display.' + key,
          label: displayStyleLabel(d, key, app.locale, pack),
        }))),
  ];
  const viewName = (view: string) => views.find(v => v.value === view)?.label ?? view;
  // A region owns the order of its members; this field moves within it.
  const members = (slot: string) => {
    const keys = [
      ...new Set([...pack.definitions.filter(x => x.placements.some(p => p.slot === slot)).map(x => x.key), d.key]),
    ];
    const view = { ui: { ...pack.ui, placementOrder: order } };
    return keys.sort((a, b) => comparePlacements(view, [slot], { key: a, slot }, { key: b, slot }));
  };
  const move = (slot: string, offset: number) => {
    const keys = members(slot),
      from = keys.indexOf(d.key),
      to = from + offset;
    if (from < 0 || to < 0 || to >= keys.length) return;
    [keys[from], keys[to]] = [keys[to], keys[from]];
    onChange(d, { kind: 'ui.placementOrder', key: slot, value: keys });
  };
  const selectedSlots = slots.filter(s => editing?.view !== 'input' || s.mode !== 'display');
  const apply = () => {
    if (!editing) return;
    const next = {
      ...d,
      placements: d.placements.some(p => p.id === editing.id)
        ? d.placements.map(p => (p.id === editing.id ? editing : p))
        : [...d.placements, editing],
    };
    if (editing.view.startsWith('display.') && !d.display?.[editing.view.slice(8)])
      next.display = { ...d.display, [editing.view.slice(8)]: { component: 'text-display@1' } };
    if (editing.mode === 'navigate' && !d.navigation)
      next.navigation = { component: 'filter-link@1', open: { kind: 'query', filter: { op: 'exists', tag: '$self' } } };
    onChange(next);
    setEditing(undefined);
  };
  return (
    <>
      <CollectionEditor
        label={title}
        title={title}
        count={items.length ? String(items.length) : ''}
        items={items}
        actionsLabel={t('FacetEditor.actions')}
        emptyText={t('DefinitionDesigner.noPositions')}
        columns={[
          { id: 'slot', title: t('DefinitionDesigner.region'), wide: true, render: p => slotName(p.slot) },
          ...(purpose === 'navigate'
            ? []
            : [
                { id: 'view', title: t('DefinitionDesigner.presentation'), render: (p: Placement) => viewName(p.view) },
              ]),
          {
            id: 'order',
            title: t('DefinitionDesigner.order'),
            render: p => {
              const keys = members(p.slot),
                index = keys.indexOf(d.key);
              return (
                <span className="placement-order">
                  {t('DefinitionDesigner.positionOf', { position: index + 1, count: keys.length })}
                  <Button
                    size="S"
                    theme="borderless"
                    icon={<IconChevronUp />}
                    aria-label={t('DefinitionDesigner.moveEarlier', { name: slotName(p.slot) })}
                    disabled={index <= 0}
                    onClick={() => move(p.slot, -1)}
                  />
                  <Button
                    size="S"
                    theme="borderless"
                    icon={<IconChevronDown />}
                    aria-label={t('DefinitionDesigner.moveLater', { name: slotName(p.slot) })}
                    disabled={index >= keys.length - 1}
                    onClick={() => move(p.slot, 1)}
                  />
                </span>
              );
            },
          },
        ]}
        editLabel={p => t('DefinitionDesigner.editPosition', { name: slotName(p.slot) })}
        onEdit={p => setEditing(structuredClone(p))}
        removeLabel={p => t('DefinitionDesigner.removePosition', { name: slotName(p.slot) })}
        onRemove={p => onChange({ ...d, placements: d.placements.filter(item => item.id !== p.id) })}
        actions={
          <Button
            size="S"
            icon={<IconPlus />}
            disabled={!slots.length}
            onClick={() => {
              const view = views[0].value,
                slot = slots.find(s => view !== 'input' || (s.surface && s.mode !== 'display'))?.id ?? slots[0].id;
              setEditing({ id: crypto.randomUUID(), slot, view, mode: purpose });
            }}
          >
            {t('DefinitionDesigner.addPosition.' + purpose)}
          </Button>
        }
      />
      <Modal
        mode="exclusive"
        title={t('DefinitionDesigner.positionSettings')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>{t('FacetEditor.cancel')}</Button>
            <Button
              theme="solid"
              disabled={!editing || !selectedSlots.some(s => s.id === editing.slot)}
              onClick={apply}
            >
              {t('FacetEditor.applyToDraft')}
            </Button>
          </>
        }
      >
        {editing && (
          <FormLayout compact>
            <FormField layout="row" label={t('DefinitionDesigner.positionPurpose')}>
              <Select
                aria-label={t('DefinitionDesigner.positionPurpose')}
                value={editing.mode}
                optionList={(['edit', 'display', 'navigate'] as const).map(value => ({
                  value,
                  label: t('DefinitionDesigner.positions.' + value),
                }))}
                onChange={v => {
                  const mode = v as PlacementPurpose,
                    view =
                      mode === 'edit'
                        ? 'input'
                        : mode === 'navigate'
                          ? 'navigation'
                          : 'display.' + (displayNames[0] ?? 'default');
                  const available = allSlots.filter(
                    s =>
                      (mode === 'navigate' ? s.id.startsWith('nav.') : !s.id.startsWith('nav.')) &&
                      (view !== 'input' || s.mode !== 'display'),
                  );
                  setEditing({
                    ...editing,
                    mode,
                    view,
                    slot: available.some(s => s.id === editing.slot) ? editing.slot : (available[0]?.id ?? ''),
                  });
                }}
              />
            </FormField>
            {currentPurpose !== 'navigate' && (
              <FormField layout="row" label={t('DefinitionDesigner.presentation')}>
                <Select
                  aria-label={t('DefinitionDesigner.presentation')}
                  value={editing.view}
                  optionList={views}
                  onChange={v => {
                    const view = String(v),
                      available = slots.filter(s => view !== 'input' || s.mode !== 'display');
                    setEditing({
                      ...editing,
                      view,
                      slot: available.some(s => s.id === editing.slot) ? editing.slot : (available[0]?.id ?? ''),
                    });
                  }}
                />
              </FormField>
            )}
            <FormField layout="row" label={t('DefinitionDesigner.region')}>
              <Select
                aria-label={t('DefinitionDesigner.region')}
                value={editing.slot}
                optionList={[
                  ...selectedSlots.map(s => ({ value: s.id, label: slotName(s.id) })),
                  ...(!selectedSlots.some(s => s.id === editing.slot)
                    ? [
                        {
                          value: editing.slot,
                          label: slotName(editing.slot) + t('DefinitionDesigner.unavailable'),
                          disabled: true,
                        },
                      ]
                    : []),
                ]}
                onChange={v => setEditing({ ...editing, slot: String(v) })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
    </>
  );
}
