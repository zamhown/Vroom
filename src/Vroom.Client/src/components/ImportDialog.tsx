import { useState } from 'react';
import { t as appText } from '../i18n';
import { action, useApp } from '../context';
import { call } from '../api';
import { Button, Input, TextArea, Modal, Space, Select, Banner, Checkbox } from '../ui';
import { IconFolder, IconVideo } from '../icons';
import { FormField, FormLayout } from './FormLayout';

export function ImportDialog({
  close,
  imported,
  defaultLibraryId = '',
}: {
  /** Opening from a library imports into that library unless the user picks another one. */
  defaultLibraryId?: string;
  close(): void;
  imported(result: { jobId: string; libraryId: string }): void;
}) {
  const app = useApp();
  const [kind, setKind] = useState('files'),
    [paths, setPaths] = useState<string[]>([]),
    [name, setName] = useState(''),
    [libraryId, setLibrary] = useState(defaultLibraryId),
    [fallback, setFallback] = useState(false),
    [busy, setBusy] = useState(false);
  const [excludes, setExcludes] = useState(''),
    [probeOnScan, setProbe] = useState(true),
    [autoEnrich, setEnrich] = useState(true);
  const pick = (kind: string) =>
    action(async () => {
      const selected =
        kind === 'folder'
          ? await call<string | null>('platform.pickFolder')
          : await call<string[]>('platform.pickFiles');
      const items = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (items.length) {
        setKind(kind);
        setPaths(items);
        setFallback(false);
      } else if (!paths.length) {
        setKind(kind);
        setFallback(true);
      }
    });
  return (
    <Modal
      mode="exclusive"
      visible
      title={appText('Journey.import')}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close}>{appText('ui.cancel')}</Button>
          <Button
            theme="solid"
            disabled={busy || !paths.length}
            onClick={() => {
              setBusy(true);
              action(async () => {
                try {
                  const result = await call<{ jobId: string; libraryId: string }>('library.import', {
                    kind,
                    paths,
                    ...(name.trim() ? { name: name.trim() } : {}),
                    ...(libraryId
                      ? { libraryId }
                      : {
                          excludes:
                            kind === 'folder'
                              ? excludes
                                  .split(/\r?\n/)
                                  .map(p => p.trim())
                                  .filter(Boolean)
                              : [],
                          probeOnScan,
                          autoEnrich,
                        }),
                  });
                  await app.refresh();
                  imported(result);
                  close();
                } finally {
                  setBusy(false);
                }
              });
            }}
          >
            {appText('Journey.add')}
          </Button>
        </Space>
      }
    >
      <FormLayout>
        <Space wrap>
          <Button icon={<IconVideo />} onClick={() => pick('files')}>
            {appText('Journey.chooseFiles')}
          </Button>
          <Button icon={<IconFolder />} onClick={() => pick('folder')}>
            {appText('Journey.chooseFolder')}
          </Button>
        </Space>
        <p className="form-help">{appText(kind === 'folder' ? 'Journey.watchFolder' : 'Journey.onlySelectedFiles')}</p>
        {!!paths.length && (
          <div className="import-sources">
            {paths.map(path => (
              <div key={path}>
                {kind === 'folder' ? <IconFolder /> : <IconVideo />}
                <span title={path}>{path}</span>
              </div>
            ))}
          </div>
        )}
        {fallback && (
          <>
            <Banner description={appText('Journey.pastePath')} />
            <FormField label={appText('Journey.paths')}>
              <TextArea
                rows={3}
                value={paths.join('\n')}
                onChange={v =>
                  setPaths(
                    v
                      .split(/\r?\n/)
                      .map(p => p.trim())
                      .filter(Boolean),
                  )
                }
              />
            </FormField>
          </>
        )}
        <details className="form-disclosure">
          <summary>{appText('Journey.importSettings')}</summary>
          <FormField layout="row" label={appText('Journey.library')}>
            <Select
              value={libraryId}
              optionList={[
                { value: '', label: appText('Journey.createLibrary') },
                ...app.data.libraries.map(l => ({ value: l.id, label: l.name })),
              ]}
              onChange={v => setLibrary(String(v))}
            />
          </FormField>
          {!libraryId ? (
            <>
              <FormField layout="row" label={appText('Journey.name')}>
                <Input value={name} onChange={setName} placeholder={paths[0]?.split(/[\\/]/).filter(Boolean).at(-1)} />
              </FormField>
              {kind === 'folder' && (
                <FormField
                  layout="row"
                  label={appText('ManagementPages.excludedKeywords')}
                  description={appText('ManagementPages.oneKeywordPerLineMatchingPathsAre')}
                >
                  <TextArea rows={2} value={excludes} onChange={setExcludes} />
                </FormField>
              )}
              <FormField layout="row" label={appText('ManagementPages.mediaInformation')}>
                <Checkbox checked={probeOnScan} onChange={e => setProbe(e.target.checked)}>
                  {appText('ManagementPages.readDurationAndVideoQualityAutomatically')}
                </Checkbox>
              </FormField>
              <FormField
                layout="row"
                label={appText('ManagementPages.metadataSource')}
                description={appText('ManagementPages.accessToExternalSitesIsControlledIn')}
              >
                <Checkbox checked={autoEnrich} onChange={e => setEnrich(e.target.checked)}>
                  {appText('ManagementPages.enrichMetadataAutomatically')}
                </Checkbox>
              </FormField>
            </>
          ) : (
            <p className="form-help">{appText('Journey.useLibrarySettings')}</p>
          )}
        </details>
      </FormLayout>
    </Modal>
  );
}
