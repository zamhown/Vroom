import { translate, type MessageArgs } from '../i18n';
import { useId, useState } from 'react';
import { Checkbox } from '@react-spectrum/s2';
import { Button, Input, Modal, Select, TextArea } from '../ui';
import { IconTranslate, IconPlus } from '../icons';
import { useApp } from '../context';
import {
  availableTranslationLanguages,
  removeLocalizedText,
  updateDefaultLocalizedText,
  updateLocalizedText,
} from '../tagging/config-editor';
import { localize } from '../tagging/i18n';
import { isMessageReference, type LocalizedText } from '../tagging/types';
import { FormField, FormLayout, FormRemoveAction } from './FormLayout';

/** Inline input edits the default text; translation management is a separate, explicit action. */
export function LocalizedTextField({
  value,
  onChange,
  label,
  locale,
  multiline = false,
  disabled = false,
}: {
  value?: LocalizedText;
  onChange(value: LocalizedText): void;
  label: string;
  locale: string;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const app = useApp(),
    pack = app.data.tagging.package,
    tr = (key: string, args?: MessageArgs) => translate(key, locale, args);
  const helpId = useId(),
    [draft, setDraft] = useState<LocalizedText>();
  const [search, setSearch] = useState(''),
    [missing, setMissing] = useState(false),
    [adding, setAdding] = useState(false);
  const literal = draft && !isMessageReference(draft) ? draft : undefined;
  const defaultLocale = pack.i18n.defaultLocale;
  const shared = isMessageReference(value);
  const languageName = (id: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(id) ?? id;
    } catch {
      return id;
    }
  };
  const open = () => {
    setDraft(structuredClone(value ?? { [defaultLocale]: '' }));
    setSearch('');
    setMissing(false);
    setAdding(false);
  };
  const languages = Object.keys(literal ?? {});
  const others = languages.filter(id => id !== defaultLocale);
  const filtered = others.filter(
    id =>
      (!missing || !literal?.[id]?.trim()) &&
      (id + ' ' + languageName(id)).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const complete = others.filter(id => literal?.[id]?.trim()).length;
  const languageLabel = (id: string) => (
    <span className="translation-locale-label">
      <span>{languageName(id)}</span>
      <small>{id}</small>
    </span>
  );
  const editTranslation = (id: string) => {
    const props = {
      'aria-label': label + ' · ' + id,
      value: literal?.[id] ?? '',
      onChange: (text: string) => literal && setDraft(updateLocalizedText(literal, id, text)),
    };
    return multiline ? <TextArea {...props} rows={3} /> : <Input {...props} />;
  };
  const inlineProps = {
    'aria-label': label,
    'aria-describedby': helpId,
    value: value && !isMessageReference(value) ? (value[defaultLocale] ?? '') : localize(value, defaultLocale, pack),
    disabled,
    readOnly: shared,
    placeholder: tr('LocalizedTextField.empty'),
    onChange: (text: string) => onChange(updateDefaultLocalizedText(value, defaultLocale, text)),
  };
  return (
    <>
      <div className="localized-field">
        <div className="localized-field-input">
          {multiline ? <TextArea {...inlineProps} rows={2} /> : <Input {...inlineProps} />}
          <Button
            theme="borderless"
            size="S"
            disabled={disabled}
            icon={<IconTranslate />}
            aria-label={tr('LocalizedTextField.edit', { label })}
            title={tr('LocalizedTextField.manageTranslations')}
            onClick={open}
          >
            {tr('LocalizedTextField.translations')}
          </Button>
        </div>
        <span id={helpId} className={shared ? 'form-help' : 'visually-hidden'}>
          {shared
            ? tr('LocalizedTextField.sharedMessageUseTranslationSettingsToMake')
            : tr('LocalizedTextField.editingTheDefaultLanguage', {
                language: languageName(defaultLocale),
                code: defaultLocale,
              })}
        </span>
      </div>
      <Modal
        mode="exclusive"
        title={tr('LocalizedTextField.translationsTitle', { label })}
        visible={!!draft}
        width={680}
        onCancel={() => setDraft(undefined)}
        footer={
          <>
            <Button onClick={() => setDraft(undefined)}>{tr('LocalizedTextField.cancel')}</Button>
            <Button
              theme="solid"
              onClick={() => {
                if (draft) onChange(draft);
                setDraft(undefined);
              }}
            >
              {tr('LocalizedTextField.apply')}
            </Button>
          </>
        }
      >
        {literal ? (
          <FormLayout compact className="translation-editor">
            <FormField
              layout="row"
              label={
                <span className="translation-locale-label">
                  <span>{tr('LocalizedTextField.defaultText')}</span>
                  <small>{defaultLocale}</small>
                </span>
              }
              description={tr('LocalizedTextField.defaultLanguage', { language: languageName(defaultLocale) })}
            >
              {editTranslation(defaultLocale)}
            </FormField>
            <section className="translation-secondary" aria-label={tr('LocalizedTextField.otherLanguages')}>
              <header className="translation-toolbar">
                <span>{tr('LocalizedTextField.otherLanguages')}</span>
                <small>{tr('LocalizedTextField.complete', { completed: complete, total: others.length })}</small>
                <Button
                  size="S"
                  icon={<IconPlus />}
                  disabled={adding || !availableTranslationLanguages(literal, pack).length}
                  onClick={() => setAdding(true)}
                >
                  {tr('LocalizedTextField.addLanguage')}
                </Button>
              </header>
              {(others.length > 5 || search || missing) && (
                <div className="translation-filters">
                  <Input
                    showClear
                    size="S"
                    aria-label={tr('LocalizedTextField.searchLanguages')}
                    placeholder={tr('LocalizedTextField.searchLanguages')}
                    value={search}
                    onChange={setSearch}
                  />
                  <Checkbox isSelected={missing} onChange={setMissing}>
                    {tr('LocalizedTextField.untranslatedOnly')}
                  </Checkbox>
                </div>
              )}
              <div className="translation-rows">
                <FormLayout compact>
                  {filtered.map(id => (
                    <FormField
                      key={id}
                      layout="row"
                      label={languageLabel(id)}
                      trailingActions={
                        <FormRemoveAction
                          label={tr('LocalizedTextField.removeLanguage', { language: languageName(id), code: id })}
                          onRemove={() => setDraft(removeLocalizedText(literal, id, defaultLocale))}
                        />
                      }
                    >
                      {editTranslation(id)}
                    </FormField>
                  ))}
                  {!filtered.length && (
                    <p className="form-help">
                      {others.length
                        ? tr('LocalizedTextField.noMatchingLanguages')
                        : tr('LocalizedTextField.noOtherLanguagesYet')}
                    </p>
                  )}
                </FormLayout>
              </div>
              {adding && (
                <FormField
                  layout="row"
                  label={tr('LocalizedTextField.addLanguage')}
                  trailingActions={
                    <FormRemoveAction
                      label={tr('LocalizedTextField.cancelAddingALanguage')}
                      onRemove={() => setAdding(false)}
                    />
                  }
                >
                  <Select
                    filter
                    aria-label={tr('LocalizedTextField.addLanguage')}
                    placeholder={tr('LocalizedTextField.chooseLanguage')}
                    optionList={availableTranslationLanguages(literal, pack).map(id => ({
                      value: id,
                      label: languageName(id) + ' · ' + id,
                    }))}
                    onChange={id => {
                      setDraft(updateLocalizedText(literal, String(id), ''));
                      setAdding(false);
                      setSearch('');
                      setMissing(false);
                    }}
                  />
                </FormField>
              )}
            </section>
          </FormLayout>
        ) : isMessageReference(draft) ? (
          <FormLayout compact>
            <FormField
              layout="row"
              label={tr('LocalizedTextField.sharedMessage')}
              description={tr('LocalizedTextField.changingThisReferenceDoesNotModifyThe')}
            >
              <Select
                filter
                aria-label={tr('LocalizedTextField.sharedMessage')}
                value={draft.message}
                optionList={Object.keys(pack.i18n.messages).map(id => ({
                  value: id,
                  label: localize({ message: id }, locale, pack) || id,
                }))}
                onChange={id => setDraft({ ...draft, message: String(id) })}
              />
            </FormField>
            <FormField layout="row" label={tr('LocalizedTextField.preview')}>
              <p className="translation-message-preview">{localize(draft, locale, pack)}</p>
            </FormField>
            <div className="form-actions">
              <Button
                onClick={() =>
                  setDraft(
                    Object.fromEntries(
                      [
                        ...new Set([
                          pack.i18n.defaultLocale,
                          ...Object.keys(pack.i18n.messages[draft.message]?.values ?? {}),
                        ]),
                      ].map(id => [id, localize(draft, id, pack)]),
                    ),
                  )
                }
              >
                {tr('LocalizedTextField.useIndependentText')}
              </Button>
            </div>
          </FormLayout>
        ) : null}
      </Modal>
    </>
  );
}
