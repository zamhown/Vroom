import { Button, Space } from '../ui';
import { t } from '../i18n';
import { call } from '../api';
import { action, useApp } from '../context';
import { sizeLabel, type Job } from '../types';
import { BatchEnrichmentResults, SourceResults } from './EnrichmentResults';
import type { SourceOutcome } from './enrichment-results';
import { openTermProfile } from '../tagging/field-links';
export function parseResult(value?: string): any {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

export function JobOutcome({ job, compact = false }: { job: Job; compact?: boolean }) {
  const app = useApp(),
    result = parseResult(job.resultJson),
    args = parseResult(job.payload) ?? {},
    libraryId = result?.libraryId ?? args.libraryId ?? (job.kind === 'library.scan' ? args.id : undefined);
  const library = app.data.libraries.find(l => l.id === libraryId),
    source = app.workspace.tabs.find(t => t.id === job.origin?.tabId);
  const sources = result?.sources as SourceOutcome[] | undefined;
  return (
    <>
      {job.kind === 'metadata.batch' && result?.counts && <BatchEnrichmentResults result={result} compact={compact} />}
      {['metadata.enrich', 'sources.subscription'].includes(job.kind) &&
        (['completed', 'failed'] as string[]).includes(job.state) &&
        typeof result?.found === 'boolean' && (
          <div className="job-enrichment-result">
            <p>{t(result.found ? 'Enrichment.found' : 'Enrichment.notFound')}</p>
            {sources?.length === 0 && <p>{t('Enrichment.noSources')}</p>}
            {!compact && !!sources?.length && <SourceResults sources={sources} />}
          </div>
        )}
      <Space className="job-outcome" wrap>
        {job.kind === 'media.relink.preview' && job.state === 'completed' && result?.previewToken && (
          <div>
            <p>{t('MediaIdentity.preview')}</p>
            <p>
              {t('MediaIdentity.oldPath')}: {result.from}
            </p>
            <p>
              {t('MediaIdentity.newPath')}: {result.to}
            </p>
            <p className="form-help">{t('MediaIdentity.previewHelp')}</p>
            <Button onClick={() => action(() => call('media.identity.commit', { previewToken: result.previewToken }))}>
              {t('MediaIdentity.confirm')}
            </Button>
          </div>
        )}
        {job.state === 'completed' && typeof result?.bytes === 'number' && <span>{sizeLabel(result.bytes)}</span>}
        {job.state === 'completed' &&
          Array.isArray(result?.counts) &&
          result.counts.map((c: any) => (
            <span key={c.state}>
              {t('Journey.batch.' + c.state)} {c.count}
            </span>
          ))}
        {!!result?.failures?.length && (
          <span className="error-text">{t('Journey.failedCount', { count: result.failures.length })}</span>
        )}
        {library && (
          <Button
            size="S"
            onClick={() =>
              app.open({
                id: 'library:' + library.id,
                kind: 'library',
                title: library.name,
                params: { libraryId: library.id },
              })
            }
          >
            {t('Journey.openResults')}
          </Button>
        )}
        {['media.probe', 'metadata.enrich', 'sources.subscription'].includes(job.kind) && args.id && (
          <Button
            size="S"
            onClick={() =>
              action(async () => {
                if ((args.subjectKind ?? args.kind) === 'term') {
                  const { term } = await call<any>('terms.get', { id: args.id });
                  openTermProfile(app, term.id, term.vocabularyIds[0]);
                } else {
                  const { film } = await call<any>('film.get', { id: args.id, partId: args.partId });
                  app.open({
                    id: 'film:' + film.id,
                    kind: 'film',
                    title: film.presentation.tabTitle,
                    params: { filmId: film.id },
                  });
                }
              })
            }
          >
            {t('Journey.openResults')}
          </Button>
        )}
        {job.kind === 'media.export' && job.state === 'completed' && (
          <Button size="S" onClick={() => action(() => call('export.reveal', { jobId: job.id }))}>
            {t('Journey.showOutput')}
          </Button>
        )}
        {source && app.workspace.activeId !== source.id && (
          <Button size="S" theme="borderless" onClick={() => app.activate(source.id)}>
            {t('Journey.returnTo', { name: source.title })}
          </Button>
        )}
        {!compact && job.canRetry && (['cancelled', 'failed', 'interrupted'] as string[]).includes(job.state) && (
          <Button size="S" onClick={() => action(() => call('job.resume', { id: job.id }))}>
            {t('ManagementPages.retry')}
          </Button>
        )}
      </Space>
    </>
  );
}
