import type { RpcMethod } from './rpc-methods';
import { useEffect, useRef, useState } from 'react';
import { TextField } from '@react-spectrum/s2';
import { Banner, Button, Card, Input, Modal, Space } from './ui';
import { FormField, FormLayout } from './components/FormLayout';
import { call } from './api';
import { notifyError } from './context';
import { t } from './i18n';
import type { MediaStructure } from './MediaResources';

type Account = { available: boolean; configured: boolean; signedIn: boolean };
type Match = { fileId: number; name: string; language: string; hearingImpaired: boolean; downloads: number };
type Search = { ticket: string; partId: string; matches: Match[]; page: number; pages: number };
export type SubtitleFile = { filmId: string; partId: string; fileId: string; name: string; text: string };
export function SubtitleSettings() {
  const [account, setAccount] = useState<Account>();
  const [key, setKey] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<Account>('subtitles.account').then(setAccount).catch(notifyError);
  }, []);
  const change = async (method: RpcMethod, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      setAccount(await call<Account>(method, args));
      setKey('');
      setPassword('');
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('Subtitles.account')}>
      <FormLayout>
        {!account?.available ? (
          <Banner type="warning" description={t('host.Subtitles.secureStoreUnavailable')} />
        ) : (
          <>
            <FormField
              label={t('Subtitles.apiKey')}
              description={t(account.configured ? 'Subtitles.keyConfigured' : 'Subtitles.keyHelp')}
            >
              <TextField
                type="password"
                aria-label={t('Subtitles.apiKey')}
                value={key}
                onChange={setKey}
                isDisabled={busy}
                autoComplete="off"
                onBlur={() => {
                  if (key.trim()) void change('subtitles.configure', { apiKey: key });
                }}
              />
              {account.configured && (
                <Button size="S" disabled={busy} onClick={() => void change('subtitles.configure', { apiKey: '' })}>
                  {t('Subtitles.removeKey')}
                </Button>
              )}
            </FormField>
            {account.configured &&
              (account.signedIn ? (
                <FormField label={t('Subtitles.session')} description={t('Subtitles.signedIn')}>
                  <Button disabled={busy} onClick={() => void change('subtitles.signOut', {})}>
                    {t('Subtitles.signOut')}
                  </Button>
                </FormField>
              ) : (
                <>
                  <FormField label={t('Subtitles.username')}>
                    <Input
                      aria-label={t('Subtitles.username')}
                      value={username}
                      onChange={setUsername}
                      disabled={busy}
                    />
                  </FormField>
                  <FormField
                    label={t('Subtitles.password')}
                    description={t('Subtitles.loginHelp')}
                    actions={
                      <Button
                        disabled={busy || !username || !password}
                        onClick={() => void change('subtitles.signIn', { username, password })}
                      >
                        {t('Subtitles.signIn')}
                      </Button>
                    }
                  >
                    <TextField
                      type="password"
                      aria-label={t('Subtitles.password')}
                      value={password}
                      onChange={setPassword}
                      isDisabled={busy}
                      autoComplete="off"
                    />
                  </FormField>
                </>
              ))}
          </>
        )}
      </FormLayout>
    </Card>
  );
}
export function SubtitleSearchDialog({
  filmId,
  partId,
  title,
  visible,
  onClose,
  onLoad,
}: {
  filmId: string;
  partId?: string;
  title: string;
  visible: boolean;
  onClose(): void;
  onLoad(file: SubtitleFile): Promise<void>;
}) {
  const [query, setQuery] = useState(title),
    [language, setLanguage] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Search>(),
    [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  const identity = filmId + ':' + partId;
  const current = useRef(identity);
  current.current = identity;
  const run = useRef(0);
  const reload = async () => {
    const value = await call<MediaStructure>('media.resources.get', { filmId });
    if (current.current === identity)
      setSaved(
        value.resourceSets
          .filter(s => s.partId === partId)
          .flatMap(s => s.files.filter(f => /\.srt$/i.test(f.path)).map(f => ({ id: f.id, name: s.name }))),
      );
  };
  useEffect(() => {
    run.current++;
    setBusy(false);
    setResult(undefined);
    setSaved([]);
    setQuery(title);
    if (visible) void reload().catch(notifyError);
    return () => {
      run.current++;
    };
  }, [identity, visible]);
  const search = async (page = 1) => {
    const ticket = ++run.current;
    setBusy(true);
    try {
      const found = await call<Search>('subtitles.search', { filmId, partId, query, language, page });
      if (ticket === run.current) setResult(found);
    } catch (e) {
      notifyError(e);
    } finally {
      if (ticket === run.current) setBusy(false);
    }
  };
  const load = async (method: RpcMethod, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      const file = await call<SubtitleFile>(method, args);
      if (current.current === identity && file.filmId === filmId && file.partId === partId) {
        await onLoad(file);
        await reload();
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      mode="modeless"
      title={t('Subtitles.search')}
      visible={visible}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('PlayerPage.done')}</Button>}
    >
      <FormLayout>
        <FormField label={t('Subtitles.query')}>
          <Input
            aria-label={t('Subtitles.query')}
            value={query}
            onChange={v => {
              setQuery(v);
              setResult(undefined);
            }}
            disabled={busy}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && query.trim()) void search();
            }}
          />
        </FormField>
        <FormField
          label={t('Subtitles.language')}
          description={t('Subtitles.languageHelp')}
          actions={
            <Button disabled={busy || !query.trim() || !partId} onClick={() => void search()}>
              {t('Subtitles.search')}
            </Button>
          }
        >
          <Input
            aria-label={t('Subtitles.language')}
            value={language}
            onChange={v => {
              setLanguage(v);
              setResult(undefined);
            }}
            disabled={busy}
          />
        </FormField>
        <p className="form-help">{t('Subtitles.searchHelp')}</p>
        {result && (
          <FormField
            label={t('Subtitles.results')}
            description={result.matches.length === 0 ? t('Subtitles.empty') : undefined}
          >
            <div className="form-layout">
              {result.matches.map(item => (
                <Card key={item.fileId} title={item.name}>
                  <p className="form-help">
                    {item.language} · {t('Subtitles.downloadCount', { count: item.downloads })}
                    {item.hearingImpaired ? ' · ' + t('Subtitles.hearingImpaired') : ''}
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => void load('subtitles.download', { ticket: result.ticket, fileId: item.fileId })}
                  >
                    {t('Subtitles.download')}
                  </Button>
                </Card>
              ))}
            </div>
            <Space>
              <Button disabled={busy || result.page <= 1} onClick={() => void search(result.page - 1)}>
                {t('PlayerPage.previousPage')}
              </Button>
              <span>
                {result.page} / {result.pages}
              </span>
              <Button disabled={busy || result.page >= result.pages} onClick={() => void search(result.page + 1)}>
                {t('PlayerPage.nextPage')}
              </Button>
            </Space>
          </FormField>
        )}
        {saved.length > 0 && (
          <FormField label={t('Subtitles.saved')}>
            <Space wrap>
              {saved.map(file => (
                <Button
                  key={file.id}
                  disabled={busy}
                  onClick={() => void load('subtitles.read', { filmId, partId, fileId: file.id })}
                >
                  {file.name}
                </Button>
              ))}
            </Space>
          </FormField>
        )}
      </FormLayout>
    </Modal>
  );
}
