import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { QueryBuilder } from '../components/QueryBuilder';
import { FormField } from '../components/FormLayout';
import { IconCheck, IconClose, IconInfo } from '../icons';
import { TagInput } from './Inputs';
import { previewValue } from './preview-context';
import { compareValue } from './operators';
import type { Definition, Json, TagPackage } from './types';
import type { Predicate } from '../query';

export function QueryPreview({
  definition: d,
  catalog,
  docked = false,
}: {
  definition: Definition;
  catalog: TagPackage;
  docked?: boolean;
}) {
  const [value, setValue] = useState<Json>(() => previewValue(d, catalog, t('DefinitionPreview.exampleText')));
  const [condition, setCondition] = useState<Predicate | undefined>({ op: 'exists', tag: d.key });
  useEffect(() => {
    setValue(previewValue(d, catalog, t('DefinitionPreview.exampleText')));
    setCondition({ op: 'exists', tag: d.key });
  }, [d.key, JSON.stringify([d.value, d.value.vocabulary])]);
  const evaluate = (p?: Predicate): boolean | null => {
    if (!p) return true;
    if (p.op === 'and' || p.op === 'or') {
      const a = p.args.map(evaluate);
      return p.op === 'and'
        ? a.includes(false)
          ? false
          : a.includes(null)
            ? null
            : true
        : a.includes(true)
          ? true
          : a.includes(null)
            ? null
            : false;
    }
    if (p.op === 'not') {
      const v = evaluate(p.arg);
      return v == null ? null : !v;
    }
    if ('tag' in p && p.tag === d.key) {
      if ('values' in p) {
        if (d.value.cardinality === 'many' && Array.isArray(value)) {
          const matches = p.values.map(v => compareValue('has', value, v));
          const found = matches.includes(true) ? true : matches.includes(null) ? null : false;
          return p.op === 'not-in' ? (found === null ? null : !found) : found;
        }
        return compareValue(p.op, value, p.values);
      }
      if ('value' in p) {
        if (Array.isArray(p.value) && p.op.endsWith('between'))
          return compareValue(p.op, value, p.value[0], p.value[1]);
        return compareValue(p.op, value, p.value);
      }
      if (p.op === 'exists' || p.op === 'missing') return compareValue(p.op, value);
    }
    return null;
  };
  // Use the draft, including its flags/type; never issue requests or touch real annotations.
  const pack = { ...catalog, definitions: [{ ...d, targets: ['film-whole'] }] };
  const match = evaluate(condition);
  return (
    <section
      className={'definition-preview query-preview' + (docked ? ' query-preview-docked' : '')}
      aria-label={t('DefinitionPreview.queryPreview')}
    >
      {!docked && (
        <header className="definition-preview-heading">
          <h3>{t('DefinitionPreview.queryPreview')}</h3>
          <span className="muted">{t('DefinitionPreview.previewOnly')}</span>
        </header>
      )}
      {d.query?.filter !== false ? (
        <>
          <FormField layout="row" label={t('DefinitionPreview.sampleValue')}>
            <TagInput definition={d} catalog={catalog} value={value} onChange={setValue} allowCreate={false} />
          </FormField>
          <QueryBuilder value={condition} catalog={pack} onlyField={d.key} onChange={setCondition} preview />
          <output
            className={'query-preview-result ' + (match === null ? 'is-unknown' : match ? 'is-match' : 'is-no-match')}
            aria-live="polite"
          >
            {match === null ? <IconInfo /> : match ? <IconCheck /> : <IconClose />}
            <span>
              {t(
                match === null
                  ? 'DefinitionPreview.unknown'
                  : match
                    ? 'DefinitionPreview.matched'
                    : 'DefinitionPreview.notMatched',
              )}
            </span>
          </output>
        </>
      ) : (
        <p className="form-help">{t('DefinitionPreview.filterDisabled')}</p>
      )}
    </section>
  );
}
