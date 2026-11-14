import { IconPicker } from '../components/IconPicker';
import { useWindowDocument } from '../window-environment';
import { t as appText, translate } from '../i18n';
import { FormField } from '../components/FormLayout';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Checkbox } from '@react-spectrum/s2';
import { Button as AriaButton, Tree, TreeItem, TreeItemContent } from 'react-aria-components';
import { Button, Input, InputNumber, Select, Space, Banner } from '../ui';
import { IconPlus, IconClose, IconChevronRight, IconChevronDown, IconFolder, IconList, IconGridView } from '../icons';
import { TagSelect } from '../components/TagSelect';
import { LocalizedTextField } from '../components/LocalizedTextField';
import { InfoPopover } from '../components/InfoPopover';
import { useApp } from '../context';
import { call } from '../api';
import { localize } from './i18n';
import {
  componentLabel,
  configEnumLabel,
  configFieldLabel,
  configFieldMetadata,
  configText,
  editConfigPath,
  editorGuidance,
} from './config-editor';
import {
  buildConfigTree,
  configNodeTrail,
  filterConfigTree,
  indexConfigTree,
  isConfigObject as objectValue,
  isLocalizedConfig as localized,
  isLocalizedSchema,
  resolveConfigNode,
  type ConfigTreeNode,
  type ConfigNavigationState,
} from './config-tree';
import { configNodeId, type ConfigPath } from './config-tree';
import { SchemaIcon } from '../icon-catalog';
import registry from '../../../../resources/tagging/host-capabilities.json';
import { AnnotationTargetPicker } from './AnnotationTargetPicker';
import {
  configDependency,
  configShape,
  configChoiceValues,
  configWarnings,
  getConfigValue,
  relatedConfigPaths,
} from './config-dependencies';

const definitionSections = [
  {
    id: 'basic',
    label: 'ConfigForm.basics',
    keys: ['label', 'description', 'group', 'parents', 'targets', 'subjectVocabularies', 'value'],
  },
  { id: 'input', label: 'DefinitionDesigner.input', keys: ['input', 'writes', 'display', 'placements'] },
  { id: 'query', label: 'DefinitionDesigner.query', keys: ['query', 'navigation', 'facets'] },
  {
    id: 'automation',
    label: 'DefinitionDesigner.automation',
    keys: ['initialization', 'aliases', 'enrichment', 'automation'],
  },
  { id: 'advanced', label: 'ConfigForm.advanced', keys: [] },
] as const;
export function ConfigForm({
  kind,
  value: rawValue,
  onChange,
  lockedKey,
  navigation,
  onNavigationChange,
}: {
  kind: string;
  value: any;
  onChange(value: any): void;
  lockedKey?: boolean;
  navigation?: ConfigNavigationState;
  onNavigationChange?(state: ConfigNavigationState): void;
}) {
  const window = useWindowDocument().defaultView!;
  const app = useApp(),
    locale = app.locale,
    pack = app.data.tagging.package;
  const value = rawValue;
  const tr = (key: string) => translate(key, locale),
    t = (text: any) => localize(text, locale, pack);
  const [schema, setSchema] = useState<any>(),
    [failure, setFailure] = useState('');
  const [localNavigation, setLocalNavigation] = useState<ConfigNavigationState>({});
  const nav = navigation ?? localNavigation;
  const navigate = (next: ConfigNavigationState) => {
    setLocalNavigation(next);
    onNavigationChange?.(next);
  };
  const treeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const viewport = tree.closest<HTMLElement>('.definition-editor-content');
    const reveal = () => {
      const bottom = Math.min(viewport?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight) - 20;
      tree.style.setProperty(
        '--config-tree-available-height',
        Math.max(80, bottom - tree.getBoundingClientRect().top) + 'px',
      );
      const selected = tree.querySelector<HTMLElement>('[data-selected]');
      if (!selected) return;
      const item = selected.getBoundingClientRect(),
        box = tree.getBoundingClientRect();
      if (item.top < box.top + 4) tree.scrollTop -= box.top + 4 - item.top;
      else if (item.bottom > box.top + tree.clientHeight - 4)
        tree.scrollTop += item.bottom - (box.top + tree.clientHeight - 4);
    };
    reveal();
    // React Aria commits its collection after the outer form has mounted.
    const observer = new MutationObserver(reveal);
    observer.observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-selected'] });
    const resize = new ResizeObserver(reveal);
    if (viewport) resize.observe(viewport);
    window.addEventListener('resize', reveal);
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', reveal);
    };
  }, [nav.selected, nav.search, schema]);
  useEffect(() => {
    let alive = true;
    setSchema(undefined);
    setFailure('');
    call('schema.get', { kind })
      .then(s => {
        if (alive) setSchema(s);
      })
      .catch(e => {
        if (alive) setFailure(String(e));
      });
    return () => {
      alive = false;
    };
  }, [kind]);
  const resolve = (node: any): any => {
    if (!objectValue(node)) return {};
    if (node.$ref?.startsWith('#/')) {
      const { $ref, ...rest } = node;
      return {
        ...resolve(
          $ref
            .slice(2)
            .split('/')
            .reduce((v: any, k: string) => v?.[k], schema),
        ),
        ...rest,
      };
    }
    return node;
  };
  const shape = (path: (string | number)[], raw: any) => {
    const s = { ...resolve(raw), ...(kind === 'definition' ? configFieldMetadata(path)?.schema : {}) };
    // The public editor vocabulary enriches permissive extension objects, without restricting JSON.
    if (kind === 'definition' && path.length > 0 && (!s.type || s.type === 'object'))
      for (const [key, metadata] of Object.entries(editorGuidance.fields)) {
        const parts = key.split('.');
        if (parts.length === path.length + 1 && parts.slice(0, -1).join('.') === path.join('.') && 'schema' in metadata)
          s.properties = { ...s.properties, [parts.at(-1)!]: metadata.schema };
      }
    if (path.at(-2) === 'schema' && path.at(-1) === 'type')
      return { ...s, enum: ['string', 'number', 'integer', 'boolean', 'array', 'object'] };
    return configShape(kind, value, path, s);
  };
  const initial = (node: any): any => {
    const s = resolve(node);
    if (isLocalizedSchema(s)) return { [pack.i18n.defaultLocale]: '' };
    if (s.oneOf?.length) return initial(s.oneOf[0]);
    if (s.default !== undefined) return structuredClone(s.default);
    if (s.enum) return s.enum[0];
    if (s.type === 'array') return [];
    if (s.type === 'boolean') return false;
    if (['number', 'integer'].includes(s.type)) return s.minimum ?? 0;
    if (s.type === 'object' || s.properties)
      return Object.fromEntries((s.required ?? []).map((key: string) => [key, initial(s.properties?.[key])]));
    return '';
  };
  const change = (path: (string | number)[], next: any) => onChange(editConfigPath(value, path, next));
  const meta = (path: (string | number)[]) => (kind === 'definition' ? configFieldMetadata(path) : undefined);
  const nameFor = (path: (string | number)[]) =>
    meta(path) ? t(meta(path)!.label) : configFieldLabel(String(path.at(-1)), locale);
  const leaf = (current: any, path: (string | number)[], s: any, title: string, readOnly: boolean): ReactNode => {
    const key = String(path.at(-1) ?? '');
    if (kind === 'definition' && path.length === 1 && key === 'targets')
      return (
        <AnnotationTargetPicker
          value={Array.isArray(current) ? current : []}
          label={title}
          disabled={readOnly}
          onChange={next => change(path, next)}
        />
      );
    if (s.format === 'icon')
      return <IconPicker label={title} value={current} disabled={readOnly} onChange={v => change(path, v)} />;
    const choices = configChoiceValues(kind, value, path, pack);
    if (choices)
      return (
        <div className="config-dependent-choice">
          <Select
            aria-label={title}
            disabled={readOnly}
            value={current ?? ''}
            placeholder={tr('ConfigForm.select')}
            optionList={[...choices, ...(current && !choices.includes(current) ? [current] : [])].map(v => ({
              value: v,
              label:
                (v === 'input'
                  ? tr('ConfigForm.inputControl')
                  : t(pack.sources?.[v]?.label) ||
                    t(editorGuidance.slots[v as keyof typeof editorGuidance.slots]) ||
                    v) + (v && !choices.includes(v) ? tr('ConfigForm.unavailable') : ''),
              disabled: !choices.includes(v),
            }))}
            onChange={v => change(path, v)}
          />
          {current && !choices.includes(current) && (
            <span role="status" className="config-dependency-note">
              {tr('ConfigForm.theUpstreamSettingChangedChooseAValid')}
            </span>
          )}
          {!choices.length && (
            <span className="config-dependency-note">
              {tr('ConfigForm.configureTheCorrespondingSourceOrDisplayComponent')}
            </span>
          )}
        </div>
      );
    if (localized(current, s))
      return (
        <LocalizedTextField
          value={current}
          onChange={next => change(path, next)}
          label={title}
          locale={locale}
          multiline={['description', 'help', 'emptyText'].includes(key)}
          disabled={readOnly}
        />
      );
    if (key === 'group' || key === 'vocabulary')
      return (
        <Select
          aria-label={title}
          value={current ?? ''}
          disabled={readOnly}
          optionList={Object.entries((key === 'group' ? pack.groups : pack.vocabularies) ?? {}).map(([value, v]) => ({
            value,
            label: t(v.label),
          }))}
          onChange={v => change(path, v)}
        />
      );
    if (key === 'subjectVocabularies' || key === 'vocabularyIds')
      return (
        <TagSelect
          label={title}
          multiple
          disabled={readOnly}
          options={Object.entries(pack.vocabularies ?? {}).map(([id, v]) => ({ id, label: t(v.label), value: id }))}
          value={current ?? []}
          placeholder={title}
          emptyText={tr('ConfigForm.noVocabularies')}
          createLabel={s => s}
          onChange={items =>
            change(
              path,
              items.map(i => i.id),
            )
          }
        />
      );
    if (kind === 'definition' && path.length === 1 && key === 'parents')
      return (
        <TagSelect
          label={title}
          disabled={readOnly}
          multiple
          options={pack.definitions
            .filter(d => d.key !== value.key)
            .map(d => ({ id: d.key, label: t(d.label), value: d.key }))}
          value={current ?? []}
          placeholder={tr('ConfigForm.chooseParents')}
          emptyText={tr('ConfigForm.noMatchingTags')}
          createLabel={s => s}
          onChange={items =>
            change(
              path,
              items.map(i => i.id),
            )
          }
        />
      );
    if (Array.isArray(current) && s.items?.enum)
      return (
        <Select
          multiple
          disabled={readOnly}
          aria-label={title}
          value={current}
          optionList={s.items.enum.map((v: string) => ({ value: v, label: configEnumLabel(v, locale) }))}
          onChange={items => change(path, items)}
        />
      );
    if (readOnly)
      return (
        <span className="property-readonly">
          {typeof current === 'boolean'
            ? current
              ? appText('ConfigForm.yes')
              : appText('ConfigForm.no')
            : configEnumLabel(String(current ?? '—'), locale)}
        </span>
      );
    if (s.enum) {
      const choices = s.enum.some((v: any) => String(v) === String(current)) ? s.enum : [...s.enum, current];
      return (
        <Select
          aria-label={title}
          value={String(current ?? '')}
          optionList={choices.map((v: any) => ({
            value: String(v),
            label: key === 'component' ? componentLabel(String(v), locale) : configEnumLabel(String(v), locale),
            ...(key === 'component'
              ? {
                  icon: <SchemaIcon slot="icon" name={(registry.components as Record<string, any>)[String(v)]?.icon} />,
                }
              : {}),
          }))}
          onChange={next =>
            change(
              path,
              choices.find((v: any) => String(v) === next),
            )
          }
        />
      );
    }
    if (typeof current === 'boolean' || s.type === 'boolean')
      return (
        <Checkbox aria-label={title} isSelected={Boolean(current)} onChange={v => change(path, v)}>
          {current ? appText('ConfigForm.enabled') : appText('ConfigForm.disabled')}
        </Checkbox>
      );
    if (typeof current === 'number' || ['number', 'integer'].includes(s.type))
      return (
        <InputNumber
          aria-label={title}
          value={current}
          min={s.minimum}
          max={s.maximum}
          step={s.type === 'integer' ? 1 : undefined}
          onChange={v => {
            if (Number.isFinite(v)) change(path, v);
          }}
        />
      );
    if (current === null)
      return (
        <Select
          aria-label={title}
          value="null"
          optionList={['null', 'string', 'number', 'boolean', 'object', 'array'].map(v => ({
            value: v,
            label: v === 'null' ? tr('ConfigForm.unset') : configEnumLabel(v, locale),
          }))}
          onChange={v =>
            change(
              path,
              v === 'null'
                ? null
                : v === 'object'
                  ? {}
                  : v === 'array'
                    ? []
                    : v === 'number'
                      ? 0
                      : v === 'boolean'
                        ? false
                        : '',
            )
          }
        />
      );
    return <Input aria-label={title} value={String(current ?? '')} onChange={v => change(path, v)} />;
  };
  if (failure) return <Banner type="danger" description={failure} />;
  if (!schema) return <p className="muted">{tr('ConfigForm.loadingConfigurationForm')}</p>;
  const known = new Set<string>(['enabled', ...definitionSections.flatMap(s => [...s.keys])]);
  const roots = buildConfigTree(value, schema, {
    roots:
      kind === 'definition' && objectValue(value) && !Array.isArray(value)
        ? definitionSections.map(s => ({
            id: 'section:' + s.id,
            label: configText(s.label, locale),
            keys: s.id === 'advanced' ? Object.keys(value).filter(k => !known.has(k)) : s.keys,
            allowCustom: s.id === 'advanced',
          }))
        : [{ id: 'root', label: tr('ConfigForm.configuration') }],
    shape,
    label: (path, current) =>
      typeof path.at(-1) === 'number'
        ? tr('ConfigForm.item') +
          ' ' +
          (Number(path.at(-1)) + 1) +
          (typeof current?.id === 'string' ? ' · ' + current.id : '')
        : nameFor(path),
    atomic: (path, current, s) =>
      localized(current, s) ||
      (Array.isArray(current) &&
        (!!s.items?.enum ||
          (kind === 'definition' &&
            path.length === 1 &&
            ['parents', 'subjectVocabularies', 'vocabularyIds'].includes(String(path[0]))))),
    readOnly: path =>
      meta(path)?.readOnly === true ||
      Boolean(configDependency(kind, value, path)) ||
      Boolean(lockedKey && path.length === 1 && path[0] === 'key'),
  });
  const index = indexConfigTree(roots),
    selected = resolveConfigNode(roots, nav.selected),
    trail = configNodeTrail(index, selected);
  const expanded = new Set(nav.expanded ?? roots.map(n => n.id)),
    query = nav.search ?? '',
    filtered = filterConfigTree(roots, query);
  const visibleIndex = indexConfigTree(filtered);
  const visibleExpanded = query
    ? new Set([...visibleIndex.values()].filter(n => n.children.length).map(n => n.id))
    : expanded;
  const choose = (node: ConfigTreeNode, clearSearch = false) =>
    navigate({
      ...nav,
      selected: node.id,
      expanded: [...new Set([...expanded, ...configNodeTrail(index, node).map(n => n.id)])],
      search: clearSearch ? '' : query,
    });
  const nodeSummary = (node: ConfigTreeNode) =>
    node.branch
      ? translate(Array.isArray(node.value) ? 'config.itemCount' : 'config.propertyCount', locale, {
          count: node.children.length,
        })
      : tr('ConfigForm.field');
  const nodeIcon = (node: ConfigTreeNode) =>
    node.virtual ? (
      <IconGridView />
    ) : node.branch ? (
      Array.isArray(node.value) ? (
        <IconList />
      ) : (
        <IconFolder />
      )
    ) : (
      <span className="config-tree-field-icon" />
    );
  const isLast = (node: ConfigTreeNode) =>
    (node.parentId ? visibleIndex.get(node.parentId)?.children : filtered)?.at(-1)?.id === node.id;
  const renderNode = (node: ConfigTreeNode): ReactNode => (
    <TreeItem
      key={node.id}
      id={node.id}
      textValue={node.label}
      aria-label={node.label + (configDependency(kind, value, node.path) ? tr('ConfigForm.currentlyInactive') : '')}
      className="config-tree-item"
      data-node-id={node.id}
      data-inactive={!!configDependency(kind, value, node.path) || undefined}
      data-ancestor={(trail.some(n => n.id === node.id) && node.id !== selected.id) || undefined}
    >
      <TreeItemContent>
        {({ isExpanded, hasChildItems, level }) => (
          <div className="config-tree-row" style={{ '--config-tree-depth': level - 1 } as CSSProperties}>
            <span className="config-tree-guides" aria-hidden="true">
              {Array.from({ length: level - 1 }, (_, i) => {
                const direct = i === level - 2;
                return (
                  <i
                    key={i}
                    style={{
                      left: 13 + i * 18,
                      bottom: direct && isLast(node) ? '50%' : 0,
                      visibility: !direct && isLast(configNodeTrail(visibleIndex, node)[i + 1]) ? 'hidden' : undefined,
                    }}
                  />
                );
              })}
            </span>
            <AriaButton
              slot="chevron"
              className="config-tree-chevron"
              aria-label={isExpanded ? appText('ConfigForm.collapse') : appText('ConfigForm.expand')}
              style={{ visibility: hasChildItems ? 'visible' : 'hidden' }}
            >
              {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
            </AriaButton>
            <span className="config-tree-icon" aria-hidden="true">
              {nodeIcon(node)}
            </span>
            <span className="config-tree-label" title={node.label}>
              {node.label}
            </span>
          </div>
        )}
      </TreeItemContent>
      {node.children.map(renderNode)}
    </TreeItem>
  );
  const remove = (node: ConfigTreeNode) => {
    if (node.id === selected.id && node.parentId) choose(index.get(node.parentId)!, true);
    change(node.path, undefined);
  };
  const propertyRow = (node: ConfigTreeNode) => {
    const description = t(meta(node.path)?.description);
    const dependency = configDependency(kind, value, node.path);
    const translations = localized(node.value, node.schema);
    return (
      <tr className="property-row" key={node.id} data-inactive={!!dependency || undefined}>
        <th scope="row">
          <div className="property-label">
            <span>{node.label}</span>
            {(description || dependency) && (
              <InfoPopover label={node.label + ' · ' + tr('ConfigForm.help')}>
                <strong>{node.label}</strong>
                <p>{dependency ? t(dependency.reason) : description}</p>
              </InfoPopover>
            )}
          </div>
        </th>
        <td>
          <div className="property-value">
            <div>
              {translations ? (
                <LocalizedTextField
                  value={node.value}
                  onChange={next => change(node.path, next)}
                  label={node.label}
                  locale={locale}
                  multiline={String(node.path.at(-1)) === 'description'}
                  disabled={node.readOnly}
                />
              ) : node.branch ? (
                <AriaButton
                  className="property-child-link"
                  aria-label={tr('ConfigForm.edit') + node.label}
                  onPress={() => choose(node, true)}
                >
                  {!translations && <span className="config-tree-icon">{nodeIcon(node)}</span>}
                  <span className="property-child-summary">
                    {dependency
                      ? tr('ConfigForm.inactiveValueRetained')
                      : translations
                        ? t(node.value) || tr('ConfigForm.empty')
                        : nodeSummary(node)}
                  </span>
                  <span className="property-child-open">
                    {translations ? appText('ConfigForm.translations') : appText('ConfigForm.open')}
                    <IconChevronRight />
                  </span>
                </AriaButton>
              ) : (
                leaf(node.value, node.path, node.schema, node.label, node.readOnly)
              )}
            </div>
            <span className="property-remove">
              {node.removable && (
                <Button
                  theme="borderless"
                  size="S"
                  aria-label={tr('ConfigForm.remove') + node.label}
                  icon={<IconClose />}
                  onClick={() => remove(node)}
                />
              )}
            </span>
          </div>
        </td>
      </tr>
    );
  };
  const description = t(meta(selected.path)?.description),
    array = Array.isArray(selected.value),
    keys = Object.keys(selected.value ?? {});
  const dependency = configDependency(kind, value, selected.path),
    related = relatedConfigPaths(kind, value, selected.path),
    warnings = configWarnings(kind, value);
  const openPath = (path: ConfigPath) => {
    const existing = index.get(configNodeId(path));
    if (existing) {
      choose(existing, true);
      return;
    }
    const parent =
      index.get(configNodeId(path.slice(0, -1))) ?? roots.find(n => n.schema.properties?.[String(path[0])]);
    const raw = parent?.schema.properties?.[String(path.at(-1))];
    change(path, raw ? initial(raw) : {});
    navigate({
      ...nav,
      selected: configNodeId(path),
      expanded: [...new Set([...expanded, ...(parent ? configNodeTrail(index, parent).map(n => n.id) : [])])],
      search: '',
    });
  };
  return (
    <div className="config-form config-explorer">
      <aside className="config-outline" aria-label={tr('ConfigForm.configurationStructure')}>
        <div className="config-outline-heading">
          <strong>{tr('ConfigForm.structure')}</strong>
          <AriaButton
            className="config-tree-all"
            onPress={() =>
              navigate({
                ...nav,
                selected: visibleExpanded.size ? trail[0].id : selected.id,
                expanded: visibleExpanded.size ? [] : [...index.values()].filter(n => n.children.length).map(n => n.id),
                search: '',
              })
            }
          >
            {visibleExpanded.size ? appText('ConfigForm.collapseAll') : appText('ConfigForm.expandAll')}
          </AriaButton>
        </div>
        <Input
          showClear
          aria-label={tr('ConfigForm.findConfigurationProperty')}
          placeholder={tr('ConfigForm.findProperty')}
          value={query}
          onChange={search => navigate({ ...nav, search })}
        />
        <div className="config-tree-scroll" ref={treeRef}>
          <Tree
            aria-label={tr('ConfigForm.configurationHierarchy')}
            className="config-tree"
            selectionMode="single"
            selectionBehavior="replace"
            disallowEmptySelection
            selectedKeys={new Set([selected.id])}
            expandedKeys={visibleExpanded}
            onExpandedChange={keys => {
              const next = new Set([...keys].map(String));
              const collapsed = trail.find(n => n.children.length && visibleExpanded.has(n.id) && !next.has(n.id));
              navigate({ ...nav, expanded: [...next], ...(collapsed ? { selected: collapsed.id } : {}) });
            }}
            onSelectionChange={keys => {
              if (keys !== 'all') {
                const key = keys.values().next().value;
                if (key != null && index.has(String(key))) choose(index.get(String(key))!);
              }
            }}
            renderEmptyState={() => <p className="muted">{tr('ConfigForm.noMatchingProperty')}</p>}
          >
            {filtered.map(renderNode)}
          </Tree>
        </div>
      </aside>
      <section className="config-inspector" aria-label={tr('ConfigForm.selectedNodeProperties')}>
        {trail.length > 1 && (
          <nav className="config-breadcrumb" aria-label={tr('ConfigForm.configurationPath')}>
            <ol>
              {trail.map((node, i) => (
                <li key={node.id}>
                  {i > 0 && <IconChevronRight />}
                  {i === trail.length - 1 ? (
                    <span aria-current="location">{node.label}</span>
                  ) : (
                    <AriaButton onPress={() => choose(node, true)}>{node.label}</AriaButton>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <header className="config-node-heading">
          <div>
            <h3>{selected.label}</h3>
            {selected.branch && <span>{nodeSummary(selected)}</span>}
          </div>
          <div>
            {selected.readOnly && <span className="chip">{tr('ConfigForm.readOnly')}</span>}
            {!selected.branch && selected.removable && (
              <Button
                theme="borderless"
                aria-label={tr('ConfigForm.remove') + selected.label}
                icon={<IconClose />}
                onClick={() => remove(selected)}
              />
            )}
          </div>
        </header>
        {description && <p className="config-node-description">{description}</p>}
        {dependency && (
          <div className="config-dependency-notice" role="status">
            <span>{t(dependency.reason)}</span>
            <Button size="S" theme="borderless" onClick={() => openPath(dependency.controller)}>
              {tr('ConfigForm.change') + nameFor(dependency.controller)}
            </Button>
          </div>
        )}
        {warnings.length > 0 && ['input', 'value', 'writes'].includes(String(selected.path[0])) && (
          <div className="config-dependency-warnings">
            {warnings.map((warning, i) => (
              <div key={i} role="status">
                <span>{t(warning.message)}</span>
                <Button size="S" theme="borderless" onClick={() => openPath(warning.path)}>
                  {tr('ConfigForm.review') + nameFor(warning.path)}
                </Button>
              </div>
            ))}
          </div>
        )}
        {selected.branch ? (
          <table className="property-table" aria-label={selected.label + ' · ' + tr('ConfigForm.properties')}>
            <colgroup>
              <col className="property-name-column" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{tr('ConfigForm.property')}</th>
                <th scope="col">{tr('ConfigForm.value')}</th>
              </tr>
            </thead>
            <tbody>
              {selected.children.map(propertyRow)}
              {selected.branch && !selected.children.length && (
                <tr>
                  <td colSpan={2} className="property-empty">
                    {tr('ConfigForm.thisNodeIsEmptyAddAProperty')}
                  </td>
                </tr>
              )}
              {selected.branch && !selected.readOnly && (
                <AddProperty
                  key={selected.id}
                  array={array}
                  candidates={Object.keys(selected.schema.properties ?? {}).filter(k => !keys.includes(k))}
                  allowCustom={array || selected.schema.additionalProperties !== false}
                  locale={locale}
                  title={selected.label}
                  nameLabel={key => nameFor([...selected.path, key])}
                  onAdd={(name, type) => {
                    const k = array ? selected.value.length : name,
                      itemSchema = array ? selected.schema.items : selected.schema.properties?.[name];
                    change(
                      [...selected.path, k],
                      itemSchema
                        ? initial(itemSchema)
                        : type === 'object'
                          ? {}
                          : type === 'array'
                            ? []
                            : type === 'boolean'
                              ? false
                              : type === 'number'
                                ? 0
                                : '',
                    );
                  }}
                />
              )}
            </tbody>
          </table>
        ) : (
          <div className="config-leaf-editor">
            {leaf(selected.value, selected.path, selected.schema, selected.label, selected.readOnly)}
          </div>
        )}
        {related.length > 0 && (
          <section className="config-related">
            <h4>{tr('ConfigForm.relatedSettings')}</h4>
            {related.map(path => {
              const inactive = configDependency(kind, value, path),
                present = getConfigValue(value, path) !== undefined;
              return (
                <div key={configNodeId(path)}>
                  <Button
                    theme="borderless"
                    icon={<IconChevronRight />}
                    disabled={!!inactive && !present}
                    onClick={() => openPath(path)}
                  >
                    {(present ? '' : tr('ConfigForm.configure')) + nameFor(path)}
                  </Button>
                  {inactive && <span>{t(inactive.reason)}</span>}
                </div>
              );
            })}
          </section>
        )}
      </section>
    </div>
  );
}
function AddProperty({
  array,
  candidates,
  allowCustom,
  locale,
  onAdd,
  title,
  nameLabel,
}: {
  array: boolean;
  candidates: string[];
  allowCustom: boolean;
  locale: string;
  onAdd(name: string, type: string): void;
  title: string;
  nameLabel(key: string): string;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [type, setType] = useState('string');
  const tr = (key: string) => translate(key, locale);
  if (!array && !candidates.length && !allowCustom) return null;
  return (
    <tr className="property-add">
      <td colSpan={2}>
        {!open ? (
          <Button
            theme="borderless"
            size="S"
            icon={<IconPlus />}
            onClick={() => (array ? onAdd('', 'string') : setOpen(true))}
          >
            {array ? appText('ConfigForm.addItem') : appText('ConfigForm.addProperty') + ' · ' + title}
          </Button>
        ) : (
          <Space className="config-add" wrap>
            <FormField label={tr('ConfigForm.propertyName')}>
              <Select
                allowCreate={allowCustom}
                aria-label={tr('ConfigForm.propertyName')}
                placeholder={tr('ConfigForm.chooseAProperty')}
                value={name}
                optionList={candidates.map(k => ({ value: k, label: nameLabel(k) }))}
                onChange={v => setName(String(v))}
              />
            </FormField>
            {!candidates.includes(name) && (
              <FormField label={tr('ConfigForm.dataType')}>
                <Select
                  aria-label={tr('ConfigForm.dataType')}
                  value={type}
                  optionList={['string', 'number', 'boolean', 'object', 'array'].map(v => ({
                    value: v,
                    label: configEnumLabel(v, locale),
                  }))}
                  onChange={v => setType(String(v))}
                />
              </FormField>
            )}
            <Button
              disabled={!name.trim() || ['__proto__', 'prototype', 'constructor'].includes(name)}
              onClick={() => {
                onAdd(name.trim(), type);
                setName('');
                setOpen(false);
              }}
            >
              {tr('ConfigForm.add')}
            </Button>
            <Button
              theme="borderless"
              icon={<IconClose />}
              aria-label={tr('ConfigForm.cancel')}
              onClick={() => setOpen(false)}
            />
          </Space>
        )}
      </td>
    </tr>
  );
}
