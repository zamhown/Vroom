import { t } from '../i18n';
import { useApp, action } from '../context';
import { call } from '../api';
import { Button, Space } from '../ui';
import type { Film } from '../types';
import { localize } from '../tagging/i18n';
import { groupEnrichmentItems, type EnrichmentItem, type SourceOutcome } from './enrichment-results';

export function SourceResults({ sources, unapplied = false }: { sources: SourceOutcome[]; unapplied?: boolean }) {
  const app = useApp(),
    pack = app.data.tagging.package;
  return (
    <dl className="enrichment-sources">
      {sources.map(source => (
        <div key={source.sourceId} className="enrichment-source">
          <dt>{localize(pack.sources[source.sourceId]?.label, app.locale, pack) || source.sourceId}</dt>
          <dd>
            <p className={source.error ? 'error-text' : undefined}>
              {t(
                source.error ||
                  (unapplied && source.status === 'found'
                    ? 'Enrichment.batch.foundUnapplied'
                    : source.status === 'online-disabled' && app.data.settings.onlineMetadata
                      ? 'Enrichment.onlineEnabledSince'
                      : 'Enrichment.source.' + source.status),
                { count: source.fieldCount },
              )}
            </p>
            {source.cause && <p className="form-help">{t('Enrichment.cause', { reason: t(source.cause) })}</p>}
            {source.retryAt && (
              <p className="form-help">
                {t('Enrichment.retryAt', { time: new Date(source.retryAt).toLocaleString(app.locale) })}
              </p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function BatchEnrichmentResults({
  result,
  compact = false,
}: {
  result: { counts: Record<string, number>; items?: EnrichmentItem[] };
  compact?: boolean;
}) {
  const app = useApp();
  const groups = groupEnrichmentItems(result.items ?? []);
  const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
  const shown = result.items?.length ?? 0;
  return (
    <div className="job-enrichment-result">
      <div className="enrichment-summary">
        {Object.entries(result.counts)
          .filter(([, count]) => count > 0)
          .map(([state, count]) => (
            <span key={state} data-state={state}>
              {t('Enrichment.batch.' + state, { count })}
            </span>
          ))}
      </div>
      {!compact && (
        <div className="enrichment-groups">
          {shown < total && <p className="form-help">{t('Enrichment.batch.sample', { shown, total })}</p>}
          {groups.map(group => (
            <section key={group.key} className="enrichment-group">
              {(groups.length > 1 || shown < total) && (
                <h3>{t('Enrichment.batch.' + group.state, { count: group.items.length })}</h3>
              )}
              {group.error && !group.sources.some(source => source.error) && (
                <p className="error-text">{t(group.error)}</p>
              )}
              {['failed', 'deferred'].includes(group.state) && (
                <p className="form-help">
                  {t(group.state === 'deferred' ? 'Enrichment.batch.waitingHelp' : 'Enrichment.batch.unapplied')}
                </p>
              )}
              {!!group.sources.length && (
                <SourceResults sources={group.sources} unapplied={group.state !== 'completed'} />
              )}
              <details className="form-disclosure enrichment-targets">
                <summary>{t('Enrichment.batch.targets', { count: group.items.length })}</summary>
                <Space wrap>
                  {group.items.map(item => (
                    <Button
                      key={item.target.id}
                      size="S"
                      theme="borderless"
                      onClick={() =>
                        action(async () => {
                          const { film } = await call<{ film: Film }>('film.get', { id: item.target.id });
                          app.open({
                            id: 'film:' + film.id,
                            kind: 'film',
                            title: film.presentation.tabTitle,
                            params: { filmId: film.id },
                          });
                        })
                      }
                    >
                      {t('Enrichment.batch.item', { number: item.target.ordinal + 1 })}
                    </Button>
                  ))}
                </Space>
              </details>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
