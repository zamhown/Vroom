import { t as appText, translate } from '../i18n';
import { useRef, useState } from 'react';
import {
  bundledPacks,
  installedLanguages,
  rejectedLanguagePacks,
  setInstalledPacks,
  validateLanguagePack,
  type LanguagePack,
} from '../i18n';
import { action, useApp, useJob } from '../context';
import { call } from '../api';
import { Banner, Button, Card, Modal, Select } from '../ui';
import { terminal } from '../types';
import { translationLanguages } from '../tagging/config-editor';
import { FormField, FormLayout } from './FormLayout';

/** A single package-wide language setting, published through the normal configuration transaction. */
export function LanguageSettings() {
  const app = useApp(),
    tr = (key: string) => translate(key, app.locale),
    current = app.data.tagging.package.i18n.defaultLocale;
  const [preview, setPreview] = useState<any>(),
    [jobId, setJobId] = useState(''),
    [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const reloadPacks = async () => {
    const state = await call<{ installed: LanguagePack[] }>('language.state');
    setInstalledPacks(state.installed);
  };
  const install = (file?: File) =>
    action(async () => {
      if (!file) return;
      if (file.size > 2_000_000) throw new Error(appText('language.packTooLarge'));
      let pack: unknown;
      try {
        pack = JSON.parse(await file.text());
      } catch (cause) {
        throw new Error('error.LANGUAGE_PACK_INVALID', { cause });
      }
      validateLanguagePack(pack);
      if (bundledPacks.some(p => p.locale === pack.locale)) throw new Error(appText('language.builtinProtected'));
      await call('language.install', pack);
      await reloadPacks();
    });
  const job = useJob(jobId, () => {
    void app.refresh();
  });
  const pending = busy || !!preview || (!!jobId && (!job || !terminal(job.state))),
    languageName = (id: string) => {
      try {
        return new Intl.DisplayNames([app.locale], { type: 'language' }).of(id) ?? id;
      } catch {
        return id;
      }
    };
  const prepare = (locale: string) =>
    action(async () => {
      if (locale === current) return;
      setBusy(true);
      try {
        const result = await call<any>('config.preview', {
          layer: 'user',
          expectedGeneration: app.data.tagging.generation,
          changes: [{ kind: 'i18n', key: 'defaultLocale', value: locale }],
        });
        setPreview({ ...result, locale });
      } finally {
        setBusy(false);
      }
    });
  return (
    <Card title={tr('LanguageSettings.languages')}>
      <FormLayout>
        <FormField
          layout="row"
          label={tr('LanguageSettings.interfaceLanguage')}
          description={appText('language.firstLaunch')}
        >
          <Select
            aria-label={tr('LanguageSettings.interfaceLanguage')}
            value={app.locale}
            optionList={installedLanguages().map(pack => ({ value: pack.locale, label: pack.displayName }))}
            onChange={value => app.setLocale(String(value))}
          />
        </FormField>
        <FormField
          layout="row"
          label={appText('language.installedPacks')}
          description={appText('language.packHelp')}
          actions={
            <Button size="S" onClick={() => upload.current?.click()}>
              {appText('language.install')}
            </Button>
          }
        >
          <input
            ref={upload}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={event => {
              install(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <div className="language-pack-list">
            {installedLanguages().map(pack => (
              <div className="language-pack-row" key={pack.locale}>
                <span>{pack.displayName}</span>
                <small>{pack.locale}</small>
                {bundledPacks.some(p => p.locale === pack.locale) ? (
                  <small>{appText('language.builtin')}</small>
                ) : (
                  <Button
                    size="S"
                    theme="borderless"
                    onClick={() =>
                      action(async () => {
                        await call('language.remove', { locale: pack.locale });
                        await reloadPacks();
                        if (app.locale === pack.locale) app.setLocale(app.locale);
                      })
                    }
                  >
                    {appText('language.remove')}
                  </Button>
                )}
              </div>
            ))}
            {rejectedLanguagePacks().map(pack => (
              <div className="language-pack-row" key={pack.locale}>
                <span>{pack.displayName || pack.locale}</span>
                <small>{appText('language.invalidPack')}</small>
                <Button
                  size="S"
                  onClick={() =>
                    action(async () => {
                      await call('language.remove', { locale: pack.locale });
                      await reloadPacks();
                    })
                  }
                >
                  {appText('language.remove')}
                </Button>
              </div>
            ))}
          </div>
        </FormField>
        <FormField
          layout="row"
          label={tr('LanguageSettings.defaultTextLanguage')}
          description={tr('LanguageSettings.usedThroughoutTheAppForNewText')}
        >
          <Select
            filter
            disabled={pending}
            aria-label={tr('LanguageSettings.defaultTextLanguage')}
            value={current}
            optionList={translationLanguages(app.data.tagging.package).map(id => ({
              value: id,
              label: languageName(id) + ' · ' + id,
            }))}
            onChange={value => prepare(String(value))}
          />
          {busy && !preview && (
            <p className="form-help" role="status">
              {appText('Settings.preparingChange')}
            </p>
          )}
        </FormField>
        {job && !terminal(job.state) && (
          <p className="form-help" role="status">
            {tr('LanguageSettings.applyingLanguageSettings')}
          </p>
        )}
        {job && terminal(job.state) && job.state !== 'completed' && (
          <Banner
            type="danger"
            description={
              job.error
                ? appText(job.error, job.errorArgs)
                : tr('LanguageSettings.languageSettingsWereNotAppliedPreviewAgain')
            }
          />
        )}
      </FormLayout>
      <Modal
        mode="exclusive"
        title={tr('LanguageSettings.changeDefaultTextLanguage')}
        visible={!!preview}
        onCancel={() => {
          if (!busy) setPreview(undefined);
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setPreview(undefined)}>
              {appText('ui.cancel')}
            </Button>
            <Button
              theme="solid"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  setBusy(true);
                  try {
                    const result = await call<{ jobId: string }>('config.apply', {
                      previewToken: preview.previewToken,
                      expectedGeneration: preview.generation,
                    });
                    setJobId(result.jobId);
                    setPreview(undefined);
                  } finally {
                    setBusy(false);
                  }
                })
              }
            >
              {tr('LanguageSettings.applyThroughoutTheApp')}
            </Button>
          </>
        }
      >
        <FormLayout>
          <FormField layout="row" label={tr('LanguageSettings.currentLanguage')}>
            <span>
              {languageName(current)} · {current}
            </span>
          </FormField>
          <FormField layout="row" label={tr('LanguageSettings.changeTo')}>
            <span>
              {preview && languageName(preview.locale)} · {preview?.locale}
            </span>
          </FormField>
          <p className="form-help">{appText('Settings.languageChangeCost')}</p>
        </FormLayout>
      </Modal>
    </Card>
  );
}
