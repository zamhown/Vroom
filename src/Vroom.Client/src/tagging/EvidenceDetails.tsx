import { t } from '../i18n';
import type { SourceEvidence } from './types';
export function EvidenceDetails({ evidence }: { evidence?: SourceEvidence[] }) {
  if (!evidence?.length) return null;
  return (
    <details className="form-disclosure">
      <summary>{t('Enrichment.evidence', { count: evidence.length })}</summary>
      {evidence.map((item, index) => (
        <div className="schema-field-source" key={index}>
          <p>
            {item.source} · {t('Enrichment.group', { group: item.group })}
          </p>
          <p>{item.location}</p>
          <p>
            {new Date(item.observedAt).toLocaleString()} ·{' '}
            {typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}
          </p>
        </div>
      ))}
    </details>
  );
}
