import { t as appText } from '../i18n';
import { supportsTarget } from './annotation-targets';
import { useState } from 'react';
import { Button, Modal, Select, Space, Tag, Banner } from '../ui';
import { useApp, action } from '../context';
import { call } from '../api';
import type { Query } from '../types';
import type { Json } from './types';
import { localize } from './i18n';
import { FormField, FormLayout, FormSection } from '../components/FormLayout';
import { TagInput } from './Inputs';

export function BulkDialog({
  query,
  subjectIds,
  queued,
  visible,
  close,
}: {
  query: Query;
  subjectIds?: string[];
  queued?(id: string): void;
  visible: boolean;
  close(): void;
}) {
  const app = useApp();
  const [key, setKey] = useState('');
  const [value, setValue] = useState<Json>(null);
  const [operation, setOperation] = useState('set');
  const [preview, setPreview] = useState<any>();
  const fields = app.data.tagging.package.definitions.filter(
    d => d.enabled && supportsTarget(d, 'film', 'whole') && d.writes?.manual !== false,
  );
  const definition = fields.find(d => d.key === key);
  return (
    <Modal
      mode="exclusive"
      title={appText('BulkDialog.bulkAnnotation')}
      visible={visible}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close}>{appText('BulkDialog.cancel')}</Button>
          {preview ? (
            <Button
              theme="solid"
              disabled={!preview.count}
              onClick={() =>
                action(async () => {
                  const result = await call<{ jobId: string }>('annotations.bulk.commit', {
                    previewToken: preview.previewToken,
                  });
                  queued?.(result.jobId);
                  close();
                })
              }
            >
              {appText('BulkDialog.annotations')}
              {preview.count} {appText('BulkDialog.films')}
            </Button>
          ) : (
            <Button
              theme="solid"
              disabled={!definition}
              onClick={() =>
                action(async () =>
                  setPreview(
                    await call('annotations.bulk.preview', {
                      expectedGeneration: app.data.tagging.generation,
                      ...(subjectIds ? { subjectIds } : { query }),
                      changes: [{ tagKey: key, operation, value }],
                    }),
                  ),
                )
              }
            >
              {appText('BulkDialog.previewTargets')}
            </Button>
          )}
        </Space>
      }
    >
      <FormLayout>
        <FormField layout="row" label={appText('BulkDialog.tags')}>
          <Select
            aria-label={appText('BulkDialog.tags')}
            value={key}
            onChange={v => {
              setKey(String(v));
              setValue(null);
              setPreview(undefined);
            }}
            optionList={fields.map(d => ({
              value: d.key,
              label: localize(d.label, app.locale, app.data.tagging.package),
            }))}
          />
        </FormField>
        <FormField layout="row" label={appText('BulkDialog.actions')}>
          <Select
            aria-label={appText('BulkDialog.actions')}
            value={operation}
            onChange={v => {
              setOperation(String(v));
              setPreview(undefined);
            }}
            optionList={[
              { value: 'set', label: appText('BulkDialog.assignValue') },
              { value: 'clear', label: appText('BulkDialog.clear') },
              ...(definition?.value.cardinality === 'many'
                ? [
                    { value: 'add', label: appText('BulkDialog.addMembers') },
                    { value: 'remove', label: appText('BulkDialog.removeMembers') },
                  ]
                : []),
            ]}
          />
        </FormField>
        {definition && operation !== 'clear' && (
          <FormField layout="row" label={localize(definition.label, app.locale, app.data.tagging.package)}>
            <TagInput
              definition={definition}
              value={value}
              onChange={v => {
                setValue(v);
                setPreview(undefined);
              }}
            />
          </FormField>
        )}
        {preview && (
          <FormSection title={appText('BulkDialog.previewTargets')}>
            <Tag>
              {preview.count} {appText('BulkDialog.films')}
            </Tag>
            <Banner description={appText('BulkDialog.targetsAndRevisionsAreFrozenConcurrentChanges')} />
            <div className="bulk-sample">
              {preview.sample.map((f: any) => (
                <p key={f.id}>{f.presentation.title}</p>
              ))}
            </div>
          </FormSection>
        )}
      </FormLayout>
    </Modal>
  );
}
