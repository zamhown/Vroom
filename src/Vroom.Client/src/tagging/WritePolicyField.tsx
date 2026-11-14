import type { LocalizedText } from './types';
import { translate } from '../i18n';
import { Button, Select } from '../ui';
import { IconChevronDown, IconChevronUp, IconClose } from '../icons';
import { FormField } from '../components/FormLayout';
import { useApp } from '../context';
import { configEnumLabel } from './config-editor';
import type { Definition } from './types';
import { localize } from './i18n';
import registry from '../../../../resources/tagging/host-capabilities.json';

export function writePolicies(d: Definition, locale: string) {
  return [
    'if-unset',
    'suggest-only',
    'replace-same-source',
    'unless-locked',
    'prefer-source',
    ...(d.value.cardinality === 'many' ? ['union'] : []),
  ].map(value => ({ value, label: configEnumLabel(value, locale) }));
}
export function WritePolicyField({
  definition,
  value,
  onChange,
  onPriorityChange,
  suggestionsOnly = false,
}: {
  definition: Definition;
  value: string;
  onChange(value: string): void;
  onPriorityChange(value: string[]): void;
  suggestionsOnly?: boolean;
}) {
  const { locale, data } = useApp(),
    tr = (key: string) => translate(key, locale),
    priorities = definition.writes?.sourcePriority ?? [];
  const move = (index: number, offset: number) => {
    const next = [...priorities];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onPriorityChange(next);
  };
  return (
    <FormField layout="row" label={tr('RuleFlow.existingValue')} description={tr('RuleFlow.policy.' + value)}>
      <Select
        aria-label={tr('RuleFlow.existingValue')}
        value={value}
        optionList={writePolicies(definition, locale).map(p => ({
          ...p,
          disabled: suggestionsOnly && p.value !== 'suggest-only',
        }))}
        onChange={v => onChange(String(v))}
      />
      {value === 'prefer-source' && (
        <div className="source-priority-editor">
          {priorities.map((source, index) => (
            <div className="source-priority-row" key={source}>
              <span>
                {localize(
                  (registry.originLabels as Record<string, LocalizedText>)[source],
                  locale,
                  data.tagging.package,
                ) || source}
              </span>
              <Button
                size="S"
                theme="borderless"
                icon={<IconChevronUp />}
                aria-label={tr('RuleFlow.raisePriority')}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              />
              <Button
                size="S"
                theme="borderless"
                icon={<IconChevronDown />}
                aria-label={tr('RuleFlow.lowerPriority')}
                disabled={index === priorities.length - 1}
                onClick={() => move(index, 1)}
              />
              <Button
                size="S"
                theme="borderless"
                icon={<IconClose />}
                aria-label={tr('RuleFlow.removePriority')}
                onClick={() => onPriorityChange(priorities.filter(p => p !== source))}
              />
            </div>
          ))}
          <Select
            aria-label={tr('RuleFlow.addPriority')}
            placeholder={tr('RuleFlow.addPriority')}
            optionList={Object.entries(registry.originLabels)
              .filter(([key]) => !priorities.includes(key))
              .map(([value, label]) => ({ value, label: localize(label, locale, data.tagging.package) }))}
            onChange={source => onPriorityChange([...priorities, String(source)])}
          />
          {!priorities.length && <p className="form-help">{tr('RuleFlow.noPriority')}</p>}
        </div>
      )}
    </FormField>
  );
}

/** Protection belongs after the whole rule, not between a policy and its explanation. */
export function WriteProtectionNote() {
  const { locale } = useApp();
  return (
    <details className="form-disclosure rule-protection">
      <summary>{translate('RuleFlow.protectedContent', locale)}</summary>
      <p className="form-help">{translate('RuleFlow.protection', locale)}</p>
    </details>
  );
}
