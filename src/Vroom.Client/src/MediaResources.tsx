import type { RpcMethod } from './rpc-methods';
import { useEffect, useState } from 'react';
import { Button, Input, Modal, Select, Space, Banner } from './ui';
import { FormField, FormLayout } from './components/FormLayout';
import { call } from './api';
import { notifyError, useApp, useJob } from './context';
import { JobNotice } from './components';
import { t } from './i18n';
import { sizeLabel } from './types';

export interface ResourceFile {
  id: string;
  path: string;
  size: number;
  duration: number;
  probeState: string;
  contentFingerprint?: string;
}
export interface MediaPart {
  id: string;
  fileId: string;
  ordinal: number;
  position: number;
  file: ResourceFile;
}
export interface MediaStructure {
  filmId: string;
  revision: number;
  selectedPartId?: string;
  versions: { id: string; name: string; ordinal: number; parts: MediaPart[] }[];
  resourceSets: { id: string; name: string; versionId?: string; partId?: string; files: ResourceFile[] }[];
}
export function MediaResources({
  filmId,
  title,
  visible,
  onClose,
  onChanged,
}: {
  filmId: string;
  title: string;
  visible: boolean;
  onClose(): void;
  onChanged(): void | Promise<void>;
}) {
  const app = useApp();
  const [data, setData] = useState<MediaStructure>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('version');
  const [owner, setOwner] = useState('work');
  const load = () => call<MediaStructure>('media.resources.get', { filmId }).then(setData);
  const [identityJob, setIdentityJob] = useState<string>(),
    [preview, setPreview] = useState<{
      previewToken: string;
      filmId: string;
      from: string;
      to: string;
      size: number;
    }>();
  const job = useJob<{ previewToken?: string; filmId?: string; from: string; to: string; size: number }>(
    identityJob,
    result => {
      if (result.previewToken && result.filmId === filmId) setPreview(result as NonNullable<typeof preview>);
      else {
        setPreview(undefined);
        void load().then(onChanged).catch(notifyError);
      }
    },
  );
  const identify = async (file: ResourceFile, relink = false) => {
    setBusy(true);
    setPreview(undefined);
    try {
      const paths = relink ? await call<string[]>('platform.pickFiles') : [];
      if (relink && paths.length !== 1) return;
      const result = await call<{ jobId: string }>(relink ? 'media.identity.preview' : 'media.identity.prepare', {
        filmId,
        fileId: file.id,
        ...(relink ? { revision: data!.revision, path: paths[0] } : {}),
      });
      setIdentityJob(result.jobId);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const identityActions = (file: ResourceFile) => (
    <>
      <Button disabled={busy} onClick={() => void identify(file)}>
        {t(file.contentFingerprint ? 'MediaIdentity.recheck' : 'MediaIdentity.prepare')}
      </Button>
      <Button disabled={busy} onClick={() => void identify(file, true)}>
        {t('MediaIdentity.locate')}
      </Button>
    </>
  );
  useEffect(() => {
    if (visible) void load().catch(notifyError);
  }, [visible, filmId]);
  const run = async (work: () => Promise<MediaStructure>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setData(await work());
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const change = (operation: string, id: string, extra: Record<string, unknown> = {}) =>
    void run(() => call('media.resources.change', { filmId, revision: data!.revision, operation, id, ...extra }));
  const pick = async (method: RpcMethod, args: Record<string, unknown>) => {
    const paths = await call<string[]>('platform.pickFiles');
    if (paths?.length) await run(() => call(method, { filmId, revision: data!.revision, paths, ...args }));
  };
  const play = (part: MediaPart) =>
    app.open({
      id: `player:${filmId}:${part.id}`,
      kind: 'player',
      title,
      params: { filmId, partId: part.id },
      state: {},
    });
  const reveal = (file: ResourceFile) =>
    void call('media.resources.reveal', { filmId, fileId: file.id }).catch(notifyError);
  return (
    <Modal
      mode="modeless"
      title={t('MediaResources.title')}
      visible={visible}
      width={820}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('MediaResources.close')}</Button>}
    >
      <div className="form-stack">
        {error && <Banner type="danger" description={error} />}
        <JobNotice job={job} />
        {preview && (
          <FormLayout>
            <FormField label={t('MediaIdentity.preview')} description={t('MediaIdentity.previewHelp')}>
              <dl className="description-list">
                <dt>{t('MediaIdentity.oldPath')}</dt>
                <dd>{preview.from}</dd>
                <dt>{t('MediaIdentity.newPath')}</dt>
                <dd>{preview.to}</dd>
                <dt>{t('MediaResources.files')}</dt>
                <dd>{sizeLabel(preview.size)}</dd>
              </dl>
              <Space>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void call<{ jobId: string }>('media.identity.commit', { previewToken: preview.previewToken })
                      .then(r => {
                        setIdentityJob(r.jobId);
                        setPreview(undefined);
                      })
                      .catch(notifyError)
                      .finally(() => setBusy(false));
                  }}
                >
                  {t('MediaIdentity.confirm')}
                </Button>
                <Button onClick={() => setPreview(undefined)}>{t('MediaIdentity.cancel')}</Button>
              </Space>
            </FormField>
          </FormLayout>
        )}
        <FormLayout>
          <FormField label={t('MediaResources.kind')}>
            <Select
              value={kind}
              onChange={v => setKind(String(v))}
              optionList={[
                { value: 'version', label: t('MediaResources.version') },
                { value: 'set', label: t('MediaResources.set') },
              ]}
            />
          </FormField>
          <FormField label={t('MediaResources.name')}>
            <Input value={name} onChange={setName} />
          </FormField>
          {kind === 'set' && (
            <FormField label={t('MediaResources.owner')}>
              <Select
                value={owner}
                onChange={v => setOwner(String(v))}
                optionList={[
                  { value: 'work', label: t('MediaResources.work') },
                  ...(data?.versions ?? []).flatMap(v => [
                    { value: 'v:' + v.id, label: v.name || t('MediaResources.defaultVersion') },
                    ...v.parts.map(p => ({
                      value: 'p:' + p.id,
                      label:
                        t('MediaResources.part', { number: p.ordinal + 1 }) + ' · ' + p.file.path.split(/[\\/]/).pop(),
                    })),
                  ]),
                ]}
              />
            </FormField>
          )}
          <FormField label={t('MediaResources.files')} description={t('MediaResources.filesHelp')}>
            <Button
              disabled={!data || busy || !name.trim()}
              onClick={() =>
                void pick(kind === 'version' ? 'media.resources.addVersion' : 'media.resources.addSet', {
                  name,
                  ...(owner.startsWith('v:')
                    ? { versionId: owner.slice(2) }
                    : owner.startsWith('p:')
                      ? { partId: owner.slice(2) }
                      : {}),
                }).catch(notifyError)
              }
            >
              {t('MediaResources.chooseAndAdd')}
            </Button>
          </FormField>
        </FormLayout>
        {data?.versions.map((v, versionIndex) => (
          <section className="form-stack" key={v.id}>
            <FormField
              label={t('MediaResources.version')}
              actions={
                <Space wrap>
                  <Button
                    disabled={busy || versionIndex === 0}
                    onClick={() => {
                      const order = data.versions.map(x => x.id);
                      [order[versionIndex - 1], order[versionIndex]] = [order[versionIndex], order[versionIndex - 1]];
                      change('reorder-versions', filmId, { order });
                    }}
                  >
                    {t('MediaResources.up')}
                  </Button>
                  <Button
                    disabled={busy || !v.name.trim()}
                    onClick={() => change('rename-version', v.id, { name: v.name })}
                  >
                    {t('MediaResources.rename')}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void pick('media.resources.addFiles', { targetId: v.id, parts: true }).catch(notifyError)
                    }
                  >
                    {t('MediaResources.addParts')}
                  </Button>
                  <Button disabled={busy} onClick={() => change('remove-version', v.id)}>
                    {t('MediaResources.detach')}
                  </Button>
                </Space>
              }
            >
              <Input
                aria-label={t('MediaResources.name')}
                value={v.name}
                placeholder={t('MediaResources.defaultVersion')}
                onChange={value =>
                  setData({ ...data, versions: data.versions.map(x => (x.id === v.id ? { ...x, name: value } : x)) })
                }
              />
            </FormField>
            {v.parts.map((p, index) => (
              <div className="form-stack" key={p.id}>
                <span className="file-path">
                  {t('MediaResources.part', { number: index + 1 })} · {p.file.path} · {sizeLabel(p.file.size)}
                </span>
                <Space wrap>
                  {identityActions(p.file)}
                  {p.file.probeState !== 'ready' && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void call<{ jobId: string }>('job.start', {
                          kind: 'media.probe',
                          payload: { id: filmId, partId: p.id },
                        })
                          .then(r => setIdentityJob(r.jobId))
                          .catch(notifyError)
                      }
                    >
                      {t('MediaIdentity.probe')}
                    </Button>
                  )}
                </Space>
                <Space wrap>
                  <Button disabled={busy} onClick={() => play(p)}>
                    {t('MediaResources.play')}
                  </Button>
                  <Button disabled={busy || p.id === data.selectedPartId} onClick={() => change('select-part', p.id)}>
                    {t(p.id === data.selectedPartId ? 'MediaResources.selected' : 'MediaResources.select')}
                  </Button>
                  <Button
                    disabled={busy || index === 0}
                    onClick={() => {
                      const order = v.parts.map(x => x.id);
                      [order[index - 1], order[index]] = [order[index], order[index - 1]];
                      change('reorder-parts', v.id, { order });
                    }}
                  >
                    {t('MediaResources.up')}
                  </Button>
                  <Button onClick={() => reveal(p.file)}>{t('MediaResources.reveal')}</Button>
                  <Button disabled={busy} onClick={() => change('remove-part', p.id)}>
                    {t('MediaResources.detach')}
                  </Button>
                </Space>
              </div>
            ))}
          </section>
        ))}
        {data?.resourceSets.map(s => (
          <section className="form-stack" key={s.id}>
            <FormField
              label={t('MediaResources.set')}
              actions={
                <Space>
                  <Button
                    disabled={busy || !s.name.trim()}
                    onClick={() => change('rename-set', s.id, { name: s.name })}
                  >
                    {t('MediaResources.rename')}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void pick('media.resources.addFiles', { targetId: s.id, parts: false }).catch(notifyError)
                    }
                  >
                    {t('MediaResources.addFiles')}
                  </Button>
                  <Button disabled={busy} onClick={() => change('remove-set', s.id)}>
                    {t('MediaResources.detach')}
                  </Button>
                </Space>
              }
            >
              <Input
                aria-label={t('MediaResources.name')}
                value={s.name}
                onChange={value =>
                  setData({
                    ...data,
                    resourceSets: data.resourceSets.map(x => (x.id === s.id ? { ...x, name: value } : x)),
                  })
                }
              />
            </FormField>
            {s.files.map(f => (
              <div key={f.id} className="form-stack">
                <span className="file-path">
                  {f.path} · {sizeLabel(f.size)}
                </span>
                <Space wrap>
                  {identityActions(f)}
                  <Button onClick={() => reveal(f)}>{t('MediaResources.reveal')}</Button>
                  <Button disabled={busy} onClick={() => change('detach-file', s.id, { name: f.id })}>
                    {t('MediaResources.detach')}
                  </Button>
                </Space>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
