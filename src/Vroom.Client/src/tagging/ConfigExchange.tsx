import { useState } from 'react';
import { FileTrigger, ActionButton } from '@react-spectrum/s2';
import { t as appText, translate } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { Button, Modal, Select, Space } from '../ui';
import { action, useApp } from '../context';
import { call } from '../api';
import { ui } from './i18n';

/** Export definitions and annotations, or preview and commit an imported package. */
export function ConfigExchange({ close }: { close(): void }) {
  const app = useApp();
  const word = (key: string) => ui(key, app.locale),
    tr = (key: string) => translate(key, app.locale);
  const [exporting, setExporting] = useState(true),
    [exportKind, setExportKind] = useState('bundle');
  const [importDocument, setImportDocument] = useState<any>(),
    [mediaMappings, setMediaMappings] = useState<Record<string, string>>({}),
    [importPolicy, setImportPolicy] = useState('keep-local'),
    [importFilms, setImportFilms] = useState<any[]>([]),
    [importPreview, setImportPreview] = useState<any>();
  const download = async () => {
    const document = await call('exchange.export', { kind: exportKind, archive: true });
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `vroom-${exportKind}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const setExchange = (open: boolean) => {
    setExporting(open);
    if (!open && !importPreview) close();
  };
  return (
    <>
      <Modal
        mode="exclusive"
        title={tr('TagsPage.importAndExport')}
        visible={exporting}
        onCancel={() => setExchange(false)}
        footer={<Button onClick={() => setExchange(false)}>{word('close')}</Button>}
      >
        <div className="schema-exchange">
          <section>
            <h3>{word('export')}</h3>
            <div className="schema-exchange-row">
              <Select
                aria-label={tr('TagsPage.exportContent')}
                value={exportKind}
                onChange={v => setExportKind(String(v))}
                optionList={[
                  { value: 'definitions', label: tr('TagsPage.definitions_1') },
                  { value: 'annotations', label: tr('TagsPage.annotations') },
                  { value: 'bundle', label: tr('TagsPage.definitionsAndAnnotations') },
                ]}
              />
              <Button onClick={() => action(download)}>{tr('TagsPage.exportJson')}</Button>
            </div>
          </section>
          <section>
            <h3>{word('import')}</h3>
            <FileTrigger
              acceptedFileTypes={['.json']}
              onSelect={files => {
                const file = files?.[0];
                if (file)
                  action(async () => {
                    if (file.size > 15_000_000) throw new Error(tr('TagsPage.importFileIsTooLarge'));
                    const document = JSON.parse(await file.text());
                    setImportDocument(document);
                    setMediaMappings({});
                    setImportPolicy('keep-local');
                    setImportPreview(await call('exchange.preview', { document, conflictPolicy: 'keep-local' }));
                    setImportFilms(
                      (await call<{ films: any[] }>('films.query', { ignoreDefaultQuery: true, limit: 10000 })).films,
                    );
                    // Hand over to the import preview; closing the export dialog must not close the flow.
                    setExporting(false);
                  });
              }}
            >
              <ActionButton>{tr('TagsPage.chooseJsonFile')}</ActionButton>
            </FileTrigger>
          </section>
        </div>
      </Modal>
      <Modal
        mode="exclusive"
        title={word('import')}
        visible={!!importPreview}
        onCancel={() => {
          setImportPreview(undefined);
          close();
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setImportPreview(undefined);
                close();
              }}
            >
              {word('cancel')}
            </Button>
            <Button
              theme="solid"
              disabled={!importPreview?.canCommit}
              onClick={() =>
                action(async () => {
                  await call('exchange.commit', { previewToken: importPreview.previewToken });
                  setImportPreview(undefined);
                  await app.refresh();
                })
              }
            >
              {word('apply')}
            </Button>
          </Space>
        }
      >
        <FormLayout>
          <FormField layout="row" label={tr('TagsPage.conflictHandling')}>
            <Select
              aria-label={tr('TagsPage.conflictHandling')}
              value={importPolicy}
              optionList={[
                { value: 'keep-local', label: tr('TagsPage.keepLocalAnnotations') },
                { value: 'replace', label: tr('TagsPage.useImportedAnnotations') },
              ]}
              onChange={v => {
                setImportPolicy(String(v));
                setImportPreview({ ...importPreview, canCommit: false });
              }}
            />
          </FormField>
          {(importPreview?.unresolved ?? []).map((media: any) => (
            <FormField key={media.id} label={media.path ?? media.id}>
              <Select
                aria-label={media.path ?? media.id}
                placeholder={media.path ?? media.id}
                value={mediaMappings[media.id] ?? ''}
                optionList={importFilms.map(f => ({ value: f.id, label: f.presentation.title + ' · ' + f.path }))}
                onChange={v => setMediaMappings({ ...mediaMappings, [media.id]: String(v) })}
              />
            </FormField>
          ))}
          <Button
            onClick={() =>
              action(async () =>
                setImportPreview(
                  await call('exchange.preview', {
                    document: importDocument,
                    mediaMappings,
                    conflictPolicy: importPolicy,
                  }),
                ),
              )
            }
          >
            {tr('TagsPage.previewAgain')}
          </Button>
          <details className="form-disclosure">
            <summary>{appText('Journey.diagnostics')}</summary>
            <pre>{JSON.stringify(importPreview, null, 2)}</pre>
          </details>
        </FormLayout>
      </Modal>
    </>
  );
}
