import { describe, expect, it } from 'vitest';
import { groupEnrichmentItems, type EnrichmentItem } from './enrichment-results';

const item = (id: string): EnrichmentItem => ({
  state: 'failed',
  target: {
    id,
    ordinal: 1,
    result: {
      sources: [
        { sourceId: 'strange.local', status: 'sidecar-unavailable', fieldCount: 0 },
        {
          sourceId: 'strange.remote',
          status: 'cooldown',
          fieldCount: 0,
          error: 'host.SourceAccess.cooldown',
          cause: 'host.SourceAccess.browserDisconnected',
          retryAt: '2026-11-12T08:00:00Z',
        },
      ],
    },
  },
});

describe('batch enrichment outage display', () => {
  it('groups repeated failures once without losing target identities or the original cause', () => {
    const input = Array.from({ length: 34 }, (_, index) => item('film-' + index));
    input[1].target.result!.sources.reverse();
    const groups = groupEnrichmentItems(input);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(i => i.target.id)).toEqual(input.map(i => i.target.id));
    expect(groups[0].sources[1]).toMatchObject({
      cause: 'host.SourceAccess.browserDisconnected',
      retryAt: '2026-11-12T08:00:00Z',
    });
  });
  it('does not merge different reasons, retry times, conflicts or successful results', () => {
    const input = Array.from({ length: 5 }, (_, index) => item(String(index)));
    input[1].target.result!.sources[1].cause = 'host.SourceAccess.rateLimited';
    input[2].target.result!.sources[1].retryAt = '2026-11-12T09:00:00Z';
    input[3].state = 'completed';
    input[4].state = 'conflict';
    expect(groupEnrichmentItems(input)).toHaveLength(5);
  });
});
