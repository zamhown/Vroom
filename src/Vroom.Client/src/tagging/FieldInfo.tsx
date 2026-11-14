import { EvidenceDetails } from './EvidenceDetails';
import { openContextMenu } from '../ContextMenu';
import { t as appText } from '../i18n';
import { defaultQuery } from '../types';
import { openTagSettings } from './field-links';
import { ActionButton } from '@react-spectrum/s2';
import { Popover, PreviewTrigger } from 'react-aria-components';
import { useState } from 'react';
import { Button } from '../ui';
import { IconInfo } from '../icons';
import { useApp } from '../context';
import type { AnnotationRecord, Definition, Json } from './types';
import { localize, ui } from './i18n';
import { inputGuidance } from './InputGuidance';

export function FieldInfo({
  definition,
  record,
  actions = [],
}: {
  definition: Definition;
  record?: AnnotationRecord;
  actions?: { id: string; label: string; run(): void }[];
}) {
  const app = useApp();
  const description = localize(definition.description, app.locale, app.data.tagging.package);
  const label = localize(definition.label, app.locale, app.data.tagging.package);
  const hint = localize(inputGuidance(definition), app.locale, app.data.tagging.package);
  const [open, setOpen] = useState(false);
  const active = app.workspace.tabs.find(t => t.id === app.workspace.activeId);
  if (active && ['film', 'player'].includes(active.kind))
    actions = [
      ...actions,
      ...(definition.query?.filter === false
        ? []
        : [
            {
              id: 'filter',
              label: appText('Journey.filterBy'),
              run: () =>
                app.open({
                  id: crypto.randomUUID(),
                  kind: 'library',
                  title: label,
                  params: {
                    query: {
                      ...defaultQuery(),
                      where:
                        record?.value != null
                          ? definition.value.cardinality === 'many'
                            ? {
                                op: 'and',
                                args: (record.value as Json[]).map(value => ({
                                  op: 'has',
                                  tag: definition.key,
                                  value,
                                })),
                              }
                            : { op: 'eq', tag: definition.key, value: record.value }
                          : { op: 'exists', tag: definition.key },
                    },
                  },
                  state: { showAdvanced: true },
                }),
            },
          ]),
      { id: 'settings', label: appText('Journey.tagSettings'), run: () => openTagSettings(app, definition.key) },
    ];
  if (!description && !hint && !record && !actions.length) return null;
  const source = record ? ui('origin.' + record.origin.kind, app.locale) : '';
  const info = (
    <div className="schema-field-description">
      {description && <p>{description}</p>}
      {record && (
        <div className="schema-field-source">
          <p>
            {ui('source', app.locale)}：{source}
          </p>
          {record.provenance?.source && <p>{record.provenance.source}</p>}
          <EvidenceDetails evidence={record.provenance?.evidence} />
          {record.editPolicy?.locked && <p>{ui('locked', app.locale)}</p>}
        </div>
      )}
    </div>
  );
  return (
    <span
      className="field-context"
      onContextMenu={event =>
        openContextMenu(event, [
          { id: 'info', label: ui('fieldInfo', app.locale), run: () => setOpen(true) },
          ...actions,
        ])
      }
    >
      <PreviewTrigger isOpen={open} onOpenChange={setOpen} delay={350} closeDelay={200}>
        <ActionButton
          size="S"
          isQuiet
          onPress={() => setOpen(true)}
          aria-label={label + ' · ' + ui('fieldInfo', app.locale)}
          UNSAFE_className="schema-field-info"
        >
          <IconInfo size="small" />
        </ActionButton>
        <Popover placement="bottom start" aria-label={label} className="schema-field-popover">
          <strong>{label}</strong>
          {info}
          {hint && <p className="schema-input-guidance">{hint}</p>}
          {actions.length > 0 && (
            <div className="schema-field-menu">
              {actions.map(a => (
                <Button
                  key={a.id}
                  onClick={() => {
                    setOpen(false);
                    a.run();
                  }}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </Popover>
      </PreviewTrigger>
    </span>
  );
}
