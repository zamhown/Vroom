export interface SourceOutcome {
  sourceId: string;
  status: string;
  fieldCount: number;
  error?: string;
  retryAt?: string;
  cause?: string;
}

export interface EnrichmentItem {
  state: string;
  error?: string;
  target: { id: string; ordinal: number; result?: { sources: SourceOutcome[] } };
}

/** Present a shared source outage once, while retaining every available film link. */
export function groupEnrichmentItems(items: EnrichmentItem[]) {
  const groups = new Map<
    string,
    { key: string; state: string; error?: string; sources: SourceOutcome[]; items: EnrichmentItem[] }
  >();
  for (const item of items) {
    const sources = (item.target.result?.sources ?? [])
      .filter(source => !['disabled', 'no-rules', 'not-applicable'].includes(source.status))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const key = JSON.stringify([item.state, item.error, sources]);
    const group = groups.get(key) ?? {
      key,
      state: item.state,
      error: item.error,
      sources,
      items: [] as EnrichmentItem[],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
