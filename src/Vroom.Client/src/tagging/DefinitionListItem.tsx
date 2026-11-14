import type { LocalizedText } from './types';
import { Tooltip, TooltipTrigger } from '@react-spectrum/s2';
import { Button } from 'react-aria-components';
import { IconSetting } from '../icons';
import { annotationTargets, definitionTargets } from './annotation-targets';
import { AnnotationTargetIcon } from './AnnotationTargetPicker';
import { localize } from './i18n';
import { useApp } from '../context';
import { componentLabel, configText } from './config-editor';

export function DefinitionListItem({
  label,
  component,
  enabled,
  definition,
  isDefinition,
  dirty,
  selected,
  locale,
  onSelect,
}: {
  label: string;
  component: string;
  enabled: boolean;
  definition?: unknown;
  isDefinition: boolean;
  dirty: boolean;
  selected: boolean;
  locale: string;
  onSelect(): void;
}) {
  const app = useApp();
  const active = definitionTargets(definition);
  const applicable = isDefinition ? annotationTargets.filter(t => active.includes(t.id)) : [];
  const scopeLabel = (text: LocalizedText | undefined) => localize(text, locale, app.data.tagging.package);
  const translate = (key: string) => configText(key, locale);
  const type = component ? componentLabel(component, locale) : translate('DefinitionListItem.configuration');
  const status = enabled ? type : translate('DefinitionListItem.disabled');
  const accessibleLabel = [
    label,
    type,
    ...applicable.map(s => scopeLabel(s.label)),
    ...(!enabled ? [status] : []),
    ...(dirty ? [translate('DefinitionListItem.unpublishedChanges')] : []),
  ].join(', ');

  return (
    <TooltipTrigger delay={500} placement="end">
      <Button
        data-context-resource=""
        className={'definition-list-item' + (selected ? ' is-current' : '')}
        data-dirty={dirty || undefined}
        aria-label={accessibleLabel}
        aria-pressed={selected}
        onPress={onSelect}
      >
        <span className="schema-definition-name">
          <span>{label}</span>
          {dirty && <span className="definition-dirty" aria-hidden="true" />}
        </span>
        <small>{status}</small>
        <span className="definition-scope-icons" aria-hidden="true">
          {applicable.map(t => (
            <span key={t.id} data-scope={t.id}>
              <AnnotationTargetIcon icon={t.icon} />
            </span>
          ))}
          {!isDefinition && (
            <span>
              <IconSetting />
            </span>
          )}
        </span>
      </Button>
      <Tooltip>
        <div className="definition-scope-tooltip">
          <strong>{label}</strong>
          <span>
            {type}
            {!enabled ? ` · ${status}` : ''}
          </span>
          {applicable.map(t => (
            <span className="definition-scope-description" key={t.id}>
              <AnnotationTargetIcon icon={t.icon} />
              {scopeLabel(t.label)}
            </span>
          ))}
        </div>
      </Tooltip>
    </TooltipTrigger>
  );
}
