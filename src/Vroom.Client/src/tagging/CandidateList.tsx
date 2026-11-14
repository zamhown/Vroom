import { EvidenceDetails } from './EvidenceDetails';
import { FieldInfo } from './FieldInfo';
import { Button, Space } from '../ui';
import { call } from '../api';
import { action, useApp } from '../context';
import { formatValue, localize, ui } from './i18n';
import type { AnnotationRecord, Candidate } from './types';

export function CandidateList({
  candidates,
  values,
  onChanged,
}: {
  candidates: Candidate[];
  values: Record<string, AnnotationRecord>;
  onChanged(): Promise<void>;
}) {
  const app = useApp(),
    pack = app.data.tagging.package;
  return (
    <section className="schema-section">
      {candidates.map(candidate => {
        const d = pack.definitions.find(d => d.key === candidate.tagKey);
        if (!d) return null;
        return (
          <div className="schema-candidate" key={candidate.id}>
            <span>
              {localize(d.label, app.locale, pack)}
              <FieldInfo definition={d} />
            </span>
            <span>
              {candidate.entities && Array.isArray(candidate.value)
                ? candidate.value.map(item => String((item as { label?: string }).label ?? '')).join(' · ')
                : candidate.createOptions
                  ? String(candidate.value)
                  : formatValue(d, candidate.value, app.locale, pack)}
            </span>
            <EvidenceDetails evidence={candidate.evidence} />
            <Space>
              {[true, false].map(accept => (
                <Button
                  key={String(accept)}
                  onClick={() =>
                    action(async () => {
                      await call('candidates.resolve', {
                        id: candidate.id,
                        accept,
                        expectedGeneration: app.data.tagging.generation,
                        expectedRevision: values[d.key]?.revision ?? 0,
                      });
                      await app.refresh();
                      await onChanged();
                    })
                  }
                >
                  {ui(accept ? 'accept' : 'reject', app.locale)}
                </Button>
              ))}
            </Space>
          </div>
        );
      })}
    </section>
  );
}
