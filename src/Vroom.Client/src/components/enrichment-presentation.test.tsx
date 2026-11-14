import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { BatchEnrichmentResults } from './EnrichmentResults';
import { JobNotice } from '../components';
import { setLanguage } from '../i18n';
import type { Job } from '../types';

vi.mock('../api', () => ({ call: vi.fn(), nativeComposition: false }));
vi.mock('../context', () => ({
  useApp: () => ({
    locale: 'en',
    data: {
      libraries: [],
      settings: {},
      tagging: {
        package: {
          sources: { 'unfamiliar.web': { label: { en: 'Remote archive' } } },
          i18n: { defaultLocale: 'en' },
        },
      },
    },
    workspace: { tabs: [] },
  }),
}));
vi.mock('../ui', () => ({
  Space: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  Progress: () => <div role="progressbar" />,
}));
vi.mock('../ContextMenu', () => ({ openContextMenu: vi.fn() }));
vi.mock('../icons', () => ({ IconFolder: () => null, IconPlay: () => null, IconVideo: () => null }));
vi.mock('../tagging/Surface', () => ({ Slot: () => null }));

const result = {
  counts: { completed: 34 },
  items: Array.from({ length: 34 }, (_, ordinal) => ({
    state: 'completed',
    target: {
      id: 'film-' + ordinal,
      ordinal,
      result: { sources: [{ sourceId: 'unfamiliar.web', status: 'found', fieldCount: 5 }] },
    },
  })),
};
beforeEach(() => setLanguage('en'));

describe('task summary and result hierarchy', () => {
  it('keeps completed page feedback compact with one status and no finished progress bar or source details', () => {
    const html = renderToStaticMarkup(
      <JobNotice
        job={
          {
            name: 'host.BackgroundOperations.enrichMetadataInBulk',
            state: 'completed',
            detail: 'types.completed',
            kind: 'metadata.batch',
            completed: 34,
            total: 34,
            resultJson: JSON.stringify(result),
          } as Job
        }
      />,
    );
    expect(html.match(/Completed/g)).toHaveLength(1);
    expect(html.match(/34 films processed/g)).toHaveLength(1);
    expect(html).not.toContain('progressbar');
    expect(html).not.toContain('Remote archive');
    expect(html).not.toContain('<details');
  });
  it('keeps active progress visible', () => {
    const html = renderToStaticMarkup(
      <JobNotice
        job={
          {
            name: 'host.BackgroundOperations.enrichMetadataInBulk',
            state: 'running',
            kind: 'metadata.batch',
            completed: 7,
            total: 34,
          } as Job
        }
      />,
    );
    expect(html).toContain('progressbar');
    expect(html).toContain('7 / 34');
  });
  it('shows source names and results in paired rows without repeating a single group count or irrelevant truncation help', () => {
    const html = renderToStaticMarkup(<BatchEnrichmentResults result={result} />);
    expect(html).toContain('<dt>Remote archive</dt>');
    expect(html.match(/34 films processed/g)).toHaveLength(1);
    expect(html).not.toContain('Showing');
    expect(html).toContain('enrichment-targets');
  });
  it('explains partial result lists only when some films are omitted', () => {
    const html = renderToStaticMarkup(<BatchEnrichmentResults result={{ ...result, counts: { completed: 150 } }} />);
    expect(html).toContain('Showing 34 of 150 films');
  });
});
