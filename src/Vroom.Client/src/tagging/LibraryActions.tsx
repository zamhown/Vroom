import { useState, type ReactNode } from 'react';
import { t as appText } from '../i18n';
import { useApp, action } from '../context';
import { call } from '../api';
import { Button, Modal, Space } from '../ui';
import type { Query } from '../types';
import { FormLayout, FormSection } from '../components/FormLayout';
import { SchemaAction } from './Surface';
import { localize } from './i18n';
import { BulkDialog } from './BulkDialog';
import { AutomationDialog } from './AutomationDialog';
import type { LocalizedText } from './types';
import { RibbonLayout } from './RibbonLayout';
import type { RibbonState } from '../components/Ribbon';

interface Target {
  command: string;
  label: LocalizedText;
  query: Query;
  subjectIds?: string[];
}

export function LibraryActions({
  query,
  subjectIds,
  disabled,
  queued,
  heading,
  controls = {},
  commands = {},
  ribbonState,
  onRibbonChange,
}: {
  query: Query;
  subjectIds?: string[];
  disabled: boolean;
  queued(id: string): void;
  heading?: ReactNode;
  controls?: Record<string, ReactNode>;
  commands?: Record<string, { run(): void; disabled?: boolean; selected?: boolean; danger?: boolean; badge?: number }>;
  ribbonState?: RibbonState;
  onRibbonChange?(state: RibbonState): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package;
  const [target, setTarget] = useState<Target>();
  const layout = pack.ui.layouts[pack.ui.surfaceBindings['library.actions']];
  const close = () => setTarget(undefined);
  const scope = subjectIds
    ? appText('LibraryActions.selected', { count: subjectIds.length })
    : appText('LibraryActions.all');
  if (!layout || layout.surface !== 'library.actions') return <>{heading}</>;
  const renderAction = (key: string) => {
    const config = pack.ui.actions[key];
    if (!config) return null;
    const command = commands[config.command];
    return (
      <SchemaAction
        key={key}
        config={config}
        label={localize(config.label, app.locale, pack)}
        disabled={command ? command.disabled : disabled}
        selected={command?.selected}
        danger={command?.danger}
        badge={command?.badge}
        onClick={() =>
          command
            ? command.run()
            : setTarget({
                command: config.command,
                label: config.label,
                query: structuredClone(query),
                subjectIds: subjectIds?.slice(),
              })
        }
      />
    );
  };
  return (
    <>
      {layout.root.type === 'ribbon' ? (
        <RibbonLayout
          node={layout.root}
          text={value => localize(value, app.locale, pack)}
          action={renderAction}
          control={binding => controls[binding]}
          heading={heading}
          state={ribbonState}
          onChange={onRibbonChange}
        />
      ) : (
        <>
          {heading}
          <div className="collection-actions">
            <span className="collection-actions-scope">{scope}</span>
            <Space wrap>{(layout.root.actions ?? []).map(renderAction)}</Space>
          </div>
        </>
      )}
      {target?.command === 'annotations.bulk' && (
        <BulkDialog visible close={close} query={target.query} subjectIds={target.subjectIds} queued={queued} />
      )}
      {target?.command === 'automation.bulk' && (
        <AutomationDialog close={close} query={target.query} subjectIds={target.subjectIds} queued={queued} />
      )}
      {target?.command === 'metadata.enrich' && <EnrichmentDialog target={target} close={close} queued={queued} />}
    </>
  );
}

interface Preview {
  previewToken: string;
  count: number;
  sample: { id: string; presentation: { title: string } }[];
}

function EnrichmentDialog({ target, close, queued }: { target: Target; close(): void; queued(id: string): void }) {
  const app = useApp();
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    action(async () => {
      try {
        if (preview) {
          const result = await call<{ jobId: string }>('metadata.bulk.commit', { previewToken: preview.previewToken });
          queued(result.jobId);
          close();
        } else {
          setPreview(
            await call<Preview>('metadata.bulk.preview', {
              expectedGeneration: app.data.tagging.generation,
              ...(target.subjectIds ? { subjectIds: target.subjectIds } : { query: target.query }),
            }),
          );
        }
      } finally {
        setBusy(false);
      }
    });
  };
  return (
    <Modal
      mode="exclusive"
      visible
      title={localize(target.label, app.locale, app.data.tagging.package)}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close} disabled={busy}>
            {appText('ui.cancel')}
          </Button>
          <Button theme="solid" disabled={busy || preview?.count === 0} onClick={run}>
            {preview ? appText('Enrichment.start', { count: preview.count }) : appText('Enrichment.preview')}
          </Button>
        </Space>
      }
    >
      <FormLayout>
        <p>
          {target.subjectIds
            ? appText('LibraryActions.selected', { count: target.subjectIds.length })
            : appText('LibraryActions.all')}
        </p>
        <p className="form-help">{appText('Enrichment.policy')}</p>
        {preview && (
          <FormSection title={appText('Enrichment.count', { count: preview.count })}>
            <p className="form-help">{appText('BulkDialog.targetsAndRevisionsAreFrozenConcurrentChanges')}</p>
            <div className="bulk-sample">
              {preview.sample.map(f => (
                <p key={f.id}>{f.presentation.title}</p>
              ))}
            </div>
          </FormSection>
        )}
      </FormLayout>
    </Modal>
  );
}
