import { useState } from 'react';
import { Button, Modal, InputNumber, Select, Space, Banner } from '../ui';
import { t } from '../i18n';
import { useApp } from '../context';
import { localize, termOptions } from './i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { rangeCases } from './numeric-rules';
import type { Definition, TagPackage } from './types';
import registry from '../../../../resources/tagging/host-capabilities.json';

export function NumericRuleDialog({
  definition,
  catalog,
  apply,
  close,
}: {
  definition: Definition;
  catalog: TagPackage;
  apply(cases: any[]): void;
  close(): void;
}) {
  const app = useApp(),
    facts = Object.entries(registry.facts).filter(([, f]) => ['number', 'integer'].includes(f.type));
  const options = termOptions(definition, catalog).map(o => ({ ...o, label: localize(o.label, app.locale, catalog) }));
  const [fact, setFact] = useState(facts[0][0]),
    [unit, setUnit] = useState(''),
    [boundaries, setBoundaries] = useState(options.slice(1).map((_, i) => (i + 1) * 10));
  const meta = (registry.facts as any)[fact],
    units = meta.unit?.choices ?? [],
    selected = units.find((u: any) => u.key === unit) ?? units[0];
  const cases = rangeCases(
    fact,
    boundaries,
    options.map(o => (definition.value.cardinality === 'many' ? [o.value] : o.value)),
    selected?.factor ?? 1,
  );
  return (
    <Modal
      mode="exclusive"
      visible
      width={680}
      title={t('Journey.numericRanges')}
      onCancel={close}
      footer={
        <Space>
          <Button onClick={close}>{t('AgentPage.cancel')}</Button>
          <Button
            theme="solid"
            disabled={!cases}
            onClick={() => {
              apply(cases!);
              close();
            }}
          >
            {t('Journey.useRanges')}
          </Button>
        </Space>
      }
    >
      <FormLayout>
        <FormField layout="row" label={t('Journey.readProperty')}>
          <Select
            value={fact}
            onChange={v => {
              setFact(String(v));
              setUnit('');
            }}
            optionList={facts.map(([value, f]) => ({ value, label: localize(f.label, app.locale, catalog) }))}
          />
        </FormField>
        {!!units.length && (
          <FormField layout="row" label={t('Journey.unit')}>
            <Select
              value={selected.key}
              onChange={v => setUnit(String(v))}
              optionList={units.map((u: any) => ({ value: u.key, label: localize(u.label, app.locale, catalog) }))}
            />
          </FormField>
        )}
        <table className="range-table">
          <thead>
            <tr>
              <th>{t('Journey.atLeast')}</th>
              <th>{t('Journey.lessThan')}</th>
              <th>{t('Journey.fillWith')}</th>
            </tr>
          </thead>
          <tbody>
            {options.map((o, i) => (
              <tr key={o.id}>
                <td>{i ? (Number.isFinite(boundaries[i - 1]) ? boundaries[i - 1] : '—') : 0}</td>
                <td>
                  {i < boundaries.length ? (
                    <InputNumber
                      aria-label={t('Journey.upperBoundary', { name: o.label })}
                      value={boundaries[i]}
                      onChange={v => setBoundaries(boundaries.map((n, j) => (j === i ? v : n)))}
                    />
                  ) : (
                    t('Journey.noUpperLimit')
                  )}
                </td>
                <td>{o.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!cases && <Banner description={t('Journey.increasingBoundaries')} />}
      </FormLayout>
    </Modal>
  );
}
