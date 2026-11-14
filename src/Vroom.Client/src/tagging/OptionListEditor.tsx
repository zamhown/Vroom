import { translate } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { useState } from 'react';
import { ActionButton, ActionButtonGroup, ListView, ListViewItem, Text } from '@react-spectrum/s2';
import { Button, Input, Modal, Select, Space } from '../ui';
import { IconEdit, IconList, IconPlus, IconSetting, IconTag } from '../icons';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { InfoPopover } from '../components/InfoPopover';
import { action, useApp } from '../context';
import { call } from '../api';
import { localize } from './i18n';
import { changeVocabulary } from './definition-designer';
import { optionListTerms, privateOptionList, stageOption, type RelatedConfigChange } from './option-list';
import type { Definition, Term } from './types';

export function OptionListEditor({
  definition: d,
  vocabularies,
  onChange,
}: {
  definition: Definition;
  vocabularies: Record<string, any>;
  onChange(d: Definition, related?: RelatedConfigChange): void;
}) {
  const app = useApp(),
    published = app.data.tagging.package,
    locale = app.locale;
  const pack = { ...published, vocabularies },
    vocabulary = d.value.vocabulary ?? '';
  const collection = vocabularies[vocabulary],
    isPublished = !!published.vocabularies?.[vocabulary];
  const tr = (key: string) => translate(key, locale),
    t = (v: any) => localize(v, locale, pack);
  const [name, setName] = useState(''),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(100),
    [editing, setEditing] = useState<Term>(),
    [busy, setBusy] = useState(false);
  const [listSettings, setListSettings] = useState(false);
  const all = optionListTerms(pack, vocabulary),
    filtered = all.filter(item =>
      `${t(item.label)} ${item.aliases?.join(' ') ?? ''}`
        .toLocaleLowerCase(locale)
        .includes(search.toLocaleLowerCase(locale)),
    );
  const visible = filtered.slice(0, limit),
    lastVisibleId = visible.at(-1)?.id;
  const users = published.definitions.filter(field => field.key !== d.key && field.value.vocabulary === vocabulary);
  const put = async (term: Term) => {
    if (isPublished) {
      await call('terms.put', {
        term,
        expectedRevision: term.revision,
        expectedGeneration: app.data.tagging.generation,
      });
      await app.refresh();
    } else {
      onChange(d, {
        kind: 'vocabularies',
        key: vocabulary,
        value: stageOption(collection, { ...term, revision: Math.max(1, term.revision) }),
      });
    }
  };
  const save = (term: Term, done?: () => void) =>
    action(async () => {
      setBusy(true);
      try {
        await put(term);
        done?.();
      } finally {
        setBusy(false);
      }
    });
  const add = () => {
    if (!name.trim() || busy || !collection) return;
    save(
      {
        id: 'user.term.' + crypto.randomUUID().replaceAll('-', ''),
        revision: 0,
        enabled: true,
        label: { [pack.i18n.defaultLocale]: name.trim() },
        vocabularyIds: [vocabulary],
      },
      () => setName(''),
    );
  };
  return (
    <div className="option-list-editor">
      <div className="option-list-toolbar">
        <div className="option-list-identity">
          <IconList />
          <span className="option-list-name" title={t(collection?.label)}>
            {t(collection?.label) || tr('OptionListEditor.optionList')}
          </span>
          <small>
            {all.length} {tr('OptionListEditor.items')} ·{' '}
            {isPublished ? tr('OptionListEditor.savesImmediately') : tr('OptionListEditor.unpublished')}
          </small>
          {users.length > 0 && <small>{tr('OptionListEditor.shared')}</small>}
          <InfoPopover label={tr('OptionListEditor.optionSavingAndSharing')}>
            <p>
              {isPublished
                ? tr('OptionListEditor.optionChangesAreSavedImmediately')
                : tr('OptionListEditor.optionsPublishWithThisField')}
            </p>
            {users.length > 0 && (
              <p>
                {tr('OptionListEditor.alsoUsedBy')}
                {users.map(field => t(field.label)).join('、')}
              </p>
            )}
          </InfoPopover>
        </div>
        <Button size="S" icon={<IconSetting />} onClick={() => setListSettings(true)}>
          {tr('OptionListEditor.listSettings')}
        </Button>
      </div>
      {all.length > 5 && (
        <Input
          size="S"
          showClear
          aria-label={tr('OptionListEditor.searchOptions')}
          placeholder={tr('OptionListEditor.searchOptions')}
          value={search}
          onChange={value => {
            setSearch(value);
            setLimit(100);
          }}
        />
      )}
      {all.length > 0 && (
        <ListView
          aria-label={tr('OptionListEditor.availableOptions')}
          selectionMode="none"
          items={visible}
          dependencies={[lastVisibleId, busy, locale]}
          UNSAFE_className="option-list-items"
          onAction={id => {
            const term = all.find(item => item.id === id);
            if (term && !busy) setEditing(structuredClone(term));
          }}
          renderEmptyState={() => <span className="option-list-empty">{tr('OptionListEditor.noMatchingOptions')}</span>}
        >
          {term => (
            <ListViewItem
              id={term.id}
              textValue={t(term.label)}
              isDisabled={busy}
              data-last-option={term.id === lastVisibleId || undefined}
            >
              <IconTag slot="icon" />
              <Text slot="label">{t(term.label)}</Text>
              {!term.enabled && <Text slot="description">{tr('OptionListEditor.disabled')}</Text>}
              <ActionButtonGroup aria-label={tr('OptionListEditor.optionActions') + t(term.label)}>
                <ActionButton
                  aria-label={tr('OptionListEditor.editOption') + t(term.label)}
                  isDisabled={busy}
                  onPress={() => setEditing(structuredClone(term))}
                >
                  <IconEdit />
                </ActionButton>
                <ActionButton
                  aria-label={
                    (term.enabled ? tr('OptionListEditor.disableOption') : tr('OptionListEditor.enableOption')) +
                    t(term.label)
                  }
                  isDisabled={busy}
                  onPress={() => save({ ...term, enabled: !term.enabled })}
                >
                  {term.enabled ? tr('OptionListEditor.disable') : tr('OptionListEditor.enable')}
                </ActionButton>
              </ActionButtonGroup>
            </ListViewItem>
          )}
        </ListView>
      )}
      {filtered.length > limit && (
        <Button size="S" onClick={() => setLimit(limit + 100)}>
          {tr('OptionListEditor.loadMore')} ({limit}/{filtered.length})
        </Button>
      )}
      <FormField layout="row" className="option-list-add-field" label={tr('OptionListEditor.newOption')}>
        <div
          className="option-list-add"
          onKeyDown={e => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
        >
          <Input
            size="S"
            aria-label={tr('OptionListEditor.newOptionName')}
            placeholder={tr('OptionListEditor.enterAName')}
            value={name}
            onChange={setName}
          />
          <Button size="S" icon={<IconPlus />} disabled={busy || !name.trim() || !collection} onClick={add}>
            {tr('OptionListEditor.add')}
          </Button>
        </div>
      </FormField>
      <Modal
        mode="exclusive"
        title={tr('OptionListEditor.optionListSettings')}
        visible={listSettings}
        onCancel={() => setListSettings(false)}
        footer={<Button onClick={() => setListSettings(false)}>{tr('OptionListEditor.done')}</Button>}
      >
        <FormLayout>
          <FormField
            label={tr('OptionListEditor.currentOptionList')}
            description={tr('OptionListEditor.sharedListsKeepOptionNamesAndProfiles')}
            actions={
              <Button
                size="S"
                icon={<IconPlus />}
                onClick={() => {
                  const next = privateOptionList(d);
                  onChange(next.definition, next.collection);
                  setSearch('');
                }}
              >
                {tr('OptionListEditor.createAndUseAnEmptyList')}
              </Button>
            }
          >
            <Select
              aria-label={tr('OptionListEditor.currentOptionList')}
              value={vocabulary}
              optionList={Object.entries(vocabularies)
                .filter(([, v]) => v.enabled !== false)
                .map(([value, v]) => ({ value, label: t(v.label) }))}
              onChange={v => {
                onChange(changeVocabulary(d, String(v)));
                setSearch('');
              }}
            />
          </FormField>
        </FormLayout>
      </Modal>
      <Modal
        mode="exclusive"
        title={tr('OptionListEditor.editOption_9')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        footer={
          <Space>
            <Button disabled={busy} onClick={() => setEditing(undefined)}>
              {tr('OptionListEditor.cancel')}
            </Button>
            <Button
              theme="solid"
              disabled={busy || !editing || !t(editing.label).trim()}
              onClick={() => editing && save(editing, () => setEditing(undefined))}
            >
              {tr('OptionListEditor.save')}
            </Button>
          </Space>
        }
      >
        {editing && (
          <FormLayout>
            <FormField layout="row" label={tr('OptionListEditor.name')}>
              <LocalizedTextField
                label={tr('OptionListEditor.name')}
                value={editing.label}
                locale={locale}
                onChange={label => setEditing({ ...editing, label })}
              />
            </FormField>
            <FormField layout="row" label={tr('OptionListEditor.description')}>
              <LocalizedTextField
                label={tr('OptionListEditor.description')}
                value={editing.description}
                locale={locale}
                multiline
                onChange={description => setEditing({ ...editing, description })}
              />
            </FormField>
          </FormLayout>
        )}
      </Modal>
    </div>
  );
}
