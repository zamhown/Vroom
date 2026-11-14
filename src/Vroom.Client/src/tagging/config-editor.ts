import { translate, defaultLocale, installedLanguages } from '../i18n';
import { translationLocales, matchLanguage } from '../i18n/locale';
import { isMessageReference, type LocalizedLiteral, type LocalizedText } from './types';
import capabilities from '../../../../resources/tagging/host-capabilities.json';
import guidance from '../../../../resources/tagging/editor-guidance.json';

export const editorGuidance = guidance;
export function configFieldMetadata(path: (string | number)[]) {
  const fields = guidance.fields as Record<
    string,
    { label: LocalizedText; description: LocalizedText; schema?: any; readOnly?: boolean }
  >;
  return fields[path.join('.')] ?? fields[path.map(p => (typeof p === 'number' ? '*' : p)).join('.')];
}

export const componentLabels = Object.fromEntries(
  Object.entries(capabilities.components).map(([id, c]) => [id, c.label]),
);
// Protocol-level kinds are developer tools; everyday configuration shows task-oriented kinds only.
// Value collections are managed in the Values section, so their raw kind is a developer view too.
export const advancedConfigKinds = new Set([
  'vocabularies',
  'ui.placementOrder',
  'ui.surfaceBindings',
  'ui.actions',
  'ui.agentHints',
  'eventBindings',
  'message',
]);
export const configKindLabels: Record<string, string> = {
  definition: 'config.definition.tagDefinitions',
  groups: 'config.groups.configurationGroups',
  vocabularies: 'config.vocabularies.vocabularies',
  catalogPolicy: 'config.catalogPolicy.catalogRules',
  'ui.layouts': 'config.ui.layouts.pageLayouts',
  'ui.placementOrder': 'config.ui.placementOrder.regionOrder',
  'ui.surfaceBindings': 'config.ui.surfaceBindings.surfaceBindings',
  'ui.actions': 'config.ui.actions.actions',
  'ui.identity': 'config.ui.identity.filmIdentity',
  'ui.naming': 'config.ui.naming.uiNames',
  'ui.agentHints': 'config.ui.agentHints.agentHints',
  rules: 'config.rules.parsingRules',
  sources: 'config.sources.enrichmentSources',
  eventBindings: 'config.eventBindings.eventBindings',
  message: 'config.message.translations',
};
const fieldLabels: Record<string, string> = {
  browser: 'config.browser.browser',
  allowedHosts: 'config.allowedHosts.allowedHosts',
  readySelector: 'config.readySelector.readySelector',
  pageTimeoutSeconds: 'config.pageTimeoutSeconds.pageTimeoutSeconds',
  verificationTimeoutSeconds: 'config.verificationTimeoutSeconds.verificationTimeoutSeconds',
  failureCooldownSeconds: 'config.failureCooldownSeconds.failureCooldownSeconds',
  maxCooldownSeconds: 'config.maxCooldownSeconds.maxCooldownSeconds',
  key: 'config.key.key',
  revision: 'config.revision.revision',
  enabled: 'config.enabled.enabled',
  label: 'config.label.name',
  description: 'config.description.description',
  parents: 'config.parents.definitionHierarchy',
  group: 'config.group.configurationGroup',
  subjectVocabularies: 'config.subjectVocabularies.subjectVocabularies',
  vocabulary: 'config.vocabulary.vocabulary',
  vocabularyIds: 'config.vocabularyIds.vocabularyMemberships',
  targets: 'config.targets.subjects',
  value: 'config.value.valueContract',
  schema: 'config.schema.validation',
  cardinality: 'config.cardinality.cardinality',
  semanticVersion: 'config.semanticVersion.valueVersion',
  unit: 'config.unit.unit',
  type: 'config.type.dataType',
  minimum: 'config.minimum.minimum',
  maximum: 'config.maximum.maximum',
  multipleOf: 'config.multipleOf.step',
  enum: 'config.enum.allowedValues',
  items: 'config.items.items',
  uniqueItems: 'config.uniqueItems.uniqueItems',
  input: 'config.input.input',
  component: 'config.component.component',
  props: 'config.props.settings',
  compact: 'config.compact.compactMode',
  display: 'config.display.display',
  placements: 'config.placements.placements',
  options: 'config.options.options',
  from: 'config.from.source',
  descendantsOf: 'config.descendantsOf.descendantsOf',
  create: 'config.create.createOptions',
  namespace: 'config.namespace.namespace',
  id: 'config.id.id',
  slot: 'config.slot.region',
  view: 'config.view.view',
  mode: 'config.mode.mode',
  order: 'config.order.order',
  priority: 'config.priority.priority',
  query: 'config.query.queries',
  filter: 'config.filter.filterable',
  sort: 'config.sort.sortable',
  groupBy: 'config.groupBy.grouping',
  deduplicate: 'config.deduplicate.deduplicate',
  writes: 'config.writes.editing',
  manual: 'config.manual.manualEdits',
  navigation: 'config.navigation.navigation',
  facets: 'config.facets.facets',
  initialization: 'config.initialization.initialization',
  enrichment: 'config.enrichment.enrichment',
  automation: 'config.automation.automation',
  aliases: 'config.aliases.aliases',
  extensions: 'config.extensions.extensions',
  title: 'config.title.title',
  surface: 'config.surface.surface',
  root: 'config.root.layout',
  children: 'config.children.children',
  region: 'config.region.region',
  actions: 'config.actions.actions',
  actionsPlacement: 'config.actionsPlacement.actionPlacement',
  commitMode: 'config.commitMode.saveMode',
  gap: 'config.gap.spacing',
  tracks: 'config.tracks.columns',
  subjectKind: 'config.subjectKind.subjectType',
  command: 'config.command.command',
  icon: 'config.icon.icon',
  appearance: 'config.appearance.appearance',
  presentation: 'config.presentation.presentation',
  defaultLocale: 'config.defaultLocale.defaultLanguage',
  values: 'config.values.translations',
  message: 'config.message.messageReference',
  args: 'config.args.arguments',
  required: 'config.required.requiredFields',
  format: 'config.format.format',
  pattern: 'config.pattern.pattern',
  minLength: 'config.minLength.minimumLength',
  maxLength: 'config.maxLength.maximumLength',
  maxSymbols: 'config.maxSymbols.starCount',
  rows: 'config.rows.rows',
  step: 'config.step.step',
  placeholder: 'config.placeholder.placeholder',
  layout: 'config.layout.layout',
  span: 'config.span.columnSpan',
  manualClearBlocksAutomatic: 'config.manualClearBlocksAutomatic.manualClearingBlocksAutomaticValues',
  expression: 'config.expression.expression',
  normalize: 'config.normalize.textNormalization',
  selector: 'config.selector.elementSelector',
  pointer: 'config.pointer.jsonPointer',
  extract: 'config.extract.extract',
  normalizeWith: 'config.normalizeWith.normalizationRule',
  matchAliases: 'config.matchAliases.matchAliases',
  representative: 'config.representative.representativeValue',
  transport: 'config.transport.sourceType',
  request: 'config.request.request',
  extension: 'config.extension.fileExtension',
  parse: 'config.parse.parsing',
  fields: 'config.fields.resultFields',
  limits: 'config.limits.requestLimits',
  urlTemplate: 'config.urlTemplate.urlTemplate',
  method: 'config.method.method',
  parameters: 'config.parameters.requestParameters',
  exclusiveMinimum: 'config.exclusiveMinimum.exclusiveMinimum',
  exclusiveMaximum: 'config.exclusiveMaximum.exclusiveMaximum',
  additionalProperties: 'config.additionalProperties.additionalProperties',
  properties: 'config.properties.objectProperties',
  min: 'config.min.minimum',
  max: 'config.max.maximum',
  allowCreate: 'config.allowCreate.allowNewOptions',
  allowClear: 'config.allowClear.allowClearing',
  prefix: 'config.prefix.prefix',
  suffix: 'config.suffix.suffix',
  precision: 'config.precision.precision',
  readOnly: 'config.readOnly.readOnly',
  trueLabel: 'config.trueLabel.trueLabel',
  falseLabel: 'config.falseLabel.falseLabel',
  trueIcon: 'config.trueIcon.trueIcon',
  falseIcon: 'config.falseIcon.falseIcon',
  minItems: 'config.minItems.minimumItems',
  maxItems: 'config.maxItems.maximumItems',
  maxWidth: 'config.maxWidth.maximumWidth',
  unitsPerSymbol: 'config.unitsPerSymbol.unitsPerSymbol',
  commit: 'config.commit.interactionCommit',
  showValue: 'config.showValue.showNumericValue',
  emptyText: 'config.emptyText.emptyValueText',
  default: 'config.default.defaultStyle',
  overlay: 'config.overlay.overlayStyle',
  event: 'config.event.triggerEvent',
  executor: 'config.executor.executor',
  apply: 'config.apply.writePolicy',
  inputs: 'config.inputs.inputs',
  output: 'config.output.output',
  match: 'config.match.matchMode',
  onMultiple: 'config.onMultiple.multipleMatches',
  createOptions: 'config.createOptions.createOptions',
  facet: 'config.facet.facet',
  selection: 'config.selection.selection',
  symbols: 'config.symbols.symbolCount',
  showMissingInMenu: 'config.showMissingInMenu.showUnsetEntry',
  open: 'config.open.openPage',
  kind: 'config.kind.kind',
  op: 'config.op.operator',
  tag: 'config.tag.targetTag',
  source: 'config.source.enrichmentSource',
  field: 'config.field.sourceField',
  requiresIdentityMatch: 'config.requiresIdentityMatch.requireIdentityMatch',
  ignoreEventsBeforeManualRevision: 'config.ignoreEventsBeforeManualRevision.ignoreEventsPrecedingManualEdits',
  path: 'config.path.readPath',
  patterns: 'config.patterns.patterns',
  rule: 'config.rule.ruleReference',
  bands: 'config.bands.valueBands',
  missing: 'config.missing.unsetBand',
  when: 'config.when.condition',
  scope: 'config.scope.scope',
  sourcePriority: 'config.sourcePriority.sourcePriority',
};
const enumLabels: Record<string, string> = {
  auto: 'config.auto.automatic',
  full: 'config.full.fullRow',
  null: 'config.null.null',
  one: 'config.one.oneValue',
  many: 'config.many.multipleValues',
  string: 'config.string.text',
  number: 'config.number.number',
  integer: 'config.integer.integer',
  boolean: 'config.boolean.boolean',
  array: 'config.array.list',
  object: 'config.object.object',
  input: 'config.input.input_2',
  display: 'config.display.display_3',
  edit: 'config.edit.editable',
  read: 'config.read.readOnly',
  whole: 'config.whole.wholeFilm',
  point: 'config.point.point',
  interval: 'config.interval.interval',
  append: 'config.append.append',
  replace: 'config.replace.replace',
  merge: 'config.merge.merge',
};
Object.assign(enumLabels, {
  film: 'config.film.film',
  term: 'config.term.valueEntity',
  reference: 'config.reference.entityReference',
  tag: 'config.tag.tag',
  'if-unset': 'config.if-unset.onlyWhenUnset',
  'replace-same-source': 'config.replace-same-source.replaceSameSource',
  'prefer-source': 'config.prefer-source.preferSourcePriority',
  union: 'config.union.unionOfValues',
  navigate: 'config.navigate.navigation',
  true: 'config.true.yes',
  false: 'config.false.no',
  'change-end': 'config.change-end.afterInteraction',
  'value.constant@1': 'config.value.constant@1.constantValue',
  'fact.copy@1': 'config.fact.copy@1.copyMediaFact',
  'path.facet-alias-match@1': 'config.path.facet-alias-match@1.matchPathFacet',
  'regex.extract@1': 'config.regex.extract@1.regularExpression',
  'dictionary.match@1': 'config.dictionary.match@1.dictionaryMatch',
  'expression@1': 'config.expression@1.expression',
});
Object.assign(enumLabels, {
  browser: 'config.browser.browser',
  'suggest-only': 'config.suggest-only.suggestOnly',
  'unless-locked': 'config.unless-locked.updateUnlessLocked',
  sidecar: 'config.sidecar.localSidecar',
  http: 'config.http.networkRequest',
});
export const configEnumLabel = (value: string, locale: string) =>
  enumLabels[value] ? configText(enumLabels[value], locale) : value;
export const configText = translate;
export const componentLabel = (key: string, locale: string) => {
  const text = componentLabels[key];
  const values = text as Record<string, string> | undefined;
  return values
    ? (values[matchLanguage([locale], Object.keys(values), defaultLocale)] ?? key)
    : key.replace(/@\d+$/, '');
};
export const configFieldLabel = (key: string, locale: string) =>
  fieldLabels[key] ? configText(fieldLabels[key], locale) : key;

/** Replace only the edited path; unknown extensions and translations survive both editor modes. */
export function editConfigPath(value: any, path: (string | number)[], next: any): any {
  if (!path.length) return next;
  const [key, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    if (!rest.length && next === undefined) copy.splice(Number(key), 1);
    else copy[Number(key)] = editConfigPath(value[Number(key)], rest, next);
    return copy;
  }
  const copy = { ...value };
  if (!rest.length && next === undefined) delete copy[key];
  else
    Object.defineProperty(copy, key, {
      value: editConfigPath(value?.[key], rest, next),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  return copy;
}
export function updateLocalizedText(value: LocalizedText | undefined, locale: string, text: string): LocalizedLiteral {
  return { ...(value && !isMessageReference(value) ? value : {}), [locale]: text };
}

/** The package default is the only editing preference; UI locale and document provenance do not override it. */
export function updateDefaultLocalizedText(
  value: LocalizedText | undefined,
  defaultLocale: string,
  text: string,
): LocalizedText {
  if (isMessageReference(value)) throw new Error(translate('editor.sharedReference'));
  return updateLocalizedText(value, defaultLocale, text);
}

/** Removes one translation; the package default language and the last translation always stay. */
export function removeLocalizedText(value: LocalizedLiteral, locale: string, defaultLocale: string): LocalizedLiteral {
  if (locale === defaultLocale || Object.keys(value).length <= 1) return value;
  const next = { ...value };
  delete next[locale];
  return next;
}
export const translationLanguages = (document: unknown) =>
  translationLocales(
    document,
    installedLanguages().map(pack => pack.locale),
  );
export function availableTranslationLanguages(value: LocalizedLiteral, document: unknown = value) {
  return translationLanguages([document, value]).filter(language => !Object.hasOwn(value, language));
}
