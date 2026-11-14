import { Checkbox } from '@react-spectrum/s2';
import { Button } from '../ui';
import { t } from '../i18n';
import { useApp } from '../context';
import { MediaCondition } from './ConditionRules';
import { conditionReady, emptyCondition } from './rule-condition';

export function RunConditionEditor({
  value,
  event,
  onChange,
}: {
  value: any;
  event: string;
  onChange(value: any): void;
}) {
  const { data } = useApp();
  const always = value === undefined || value?.literal === true;
  return (
    <section className="rule-run-condition" aria-label={t('RuleFlow.runOnlyIf')}>
      <Checkbox isSelected={!always} onChange={checked => onChange(checked ? emptyCondition() : undefined)}>
        {t('RuleFlow.runOnlyIf')}
      </Checkbox>
      {always ? (
        <p className="form-help">{t('RuleFlow.everyEvent')}</p>
      ) : (
        <>
          {value?.literal === false ? (
            <div className="form-field-value">
              <span>{t('RuleFlow.neverRuns')}</span>
              <Button size="S" onClick={() => onChange(emptyCondition())}>
                {t('Journey.addCondition')}
              </Button>
            </div>
          ) : (
            <MediaCondition value={value} event={event} onChange={onChange} />
          )}
          {!conditionReady(value, data.tagging.package, event) && (
            <p className="query-validation" role="status">
              {t('RuleFlow.finishCondition')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
