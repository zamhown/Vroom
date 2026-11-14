import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { notifyError, useApp, useTabState } from '../context';
import { t } from '../i18n';
import { Button, Space, Spin } from '../ui';
import { ToggleButton, Text } from '@react-spectrum/s2';
import { IconChevronLeft, IconChevronRight } from '../icons';
import { JobNotice } from '../components';
import { localize, formatValue } from '../tagging/i18n';
import { FieldInfo } from '../tagging/FieldInfo';
import { EvidenceDetails } from '../tagging/EvidenceDetails';
import type { AnnotationRecord } from '../tagging/types';
import type { WorkspaceTab } from '../workspace';
import { activityLayout, type ActivityCursor, type ActivityItem, type ActivityPage } from './activity';

export function ActivitySidebar({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const layout = activityLayout(app.data.tagging.package, tab.kind);
  // The page DOM is always a sibling of this region; changing layout cannot remount a player or draft.
  return layout ? <ActivityPanel tab={tab} title={layout.title} sources={layout.config.sources} /> : null;
}

function ActivityPanel({
  tab,
  title,
  sources,
}: {
  tab: WorkspaceTab;
  title: Parameters<typeof localize>[0];
  sources: string[];
}) {
  const app = useApp();
  const [state, set] = useTabState(tab, { activityCollapsed: false, activityFilter: 'all' });
  const [page, setPage] = useState<ActivityPage>();
  const [before, setBefore] = useState<ActivityCursor>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const sourcesKey = sources.join(',');
  const queryKey = JSON.stringify([sourcesKey, state.activityFilter, before]);
  const currentQuery = useRef(queryKey);
  currentQuery.current = queryKey;
  const lastQuery = useRef('');
  const reload = () => setRetry(n => n + 1);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let queued = false;
    const load = async () => {
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      setLoading(true);
      try {
        const result = await call<ActivityPage>('activity.list', {
          sources: sourcesKey.split(','),
          filter: state.activityFilter,
          before,
          limit: 20,
        });
        if (!stopped && currentQuery.current === queryKey) {
          setPage(result);
          lastQuery.current = queryKey;
          setError(false);
        }
      } catch {
        if (!stopped) setError(true);
      } finally {
        busy = false;
        if (!stopped) {
          setLoading(false);
          if (queued) {
            queued = false;
            void load();
          }
        }
      }
    };
    // One shared active sidebar reads durable state; hidden tabs never create polling loops.
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [queryKey, sourcesKey, state.activityFilter, before, retry]);
  const label = localize(title, app.locale, app.data.tagging.package) || t('Activity.title');
  const fresh = lastQuery.current === queryKey;
  return (
    <aside className="activity-sidebar" data-collapsed={state.activityCollapsed || undefined} aria-label={label}>
      <header className="activity-heading">
        <Button
          size="S"
          theme="borderless"
          aria-expanded={!state.activityCollapsed}
          aria-controls="workspace-activity-content"
          aria-label={
            state.activityCollapsed ? t('Activity.expand', { count: page?.attention ?? 0 }) : t('Activity.collapse')
          }
          title={
            state.activityCollapsed ? t('Activity.expand', { count: page?.attention ?? 0 }) : t('Activity.collapse')
          }
          icon={state.activityCollapsed ? <IconChevronLeft /> : <IconChevronRight />}
          onClick={() => set({ activityCollapsed: !state.activityCollapsed })}
        />
        {!state.activityCollapsed && <h2>{label}</h2>}
        {state.activityCollapsed && !!page?.attention && <span className="activity-count">{page.attention}</span>}
      </header>
      <div id="workspace-activity-content" className="activity-content" hidden={state.activityCollapsed}>
        <div className="activity-toolbar">
          <p className="form-help">{t('Activity.catalog')}</p>
          <Space wrap>
            {(['all', 'attention'] as const).map(filter => (
              <ToggleButton
                key={filter}
                isSelected={state.activityFilter === filter}
                onChange={() => {
                  setBefore(undefined);
                  set({ activityFilter: filter });
                }}
              >
                <Text>{t('Activity.' + filter, { count: page?.attention ?? 0 })}</Text>
              </ToggleButton>
            ))}
          </Space>
        </div>
        <div className="activity-scroll" aria-busy={loading}>
          {error && (
            <div className="activity-message" role="alert">
              <p>{t('Activity.error')}</p>
              <Button size="S" onClick={reload}>
                {t('Activity.retry')}
              </Button>
            </div>
          )}
          {!page && loading && <p role="status">{t('Activity.loading')}</p>}
          {page && fresh && !page.items.length && (
            <p className="activity-message">
              {t(state.activityFilter === 'attention' ? 'Activity.clear' : 'Activity.empty')}
            </p>
          )}
          <ol className="activity-list">
            {page?.items.map(item => (
              <li key={item.id} className="activity-card" data-attention={item.attention || undefined}>
                <div className="activity-card-meta">
                  <time dateTime={item.updated || undefined}>
                    {item.updated ? new Date(item.updated).toLocaleString(app.locale) : t('Activity.unknownTime')}
                  </time>
                  {item.kind === 'candidate' && <span>{t('Activity.pending')}</span>}
                </div>
                {item.kind === 'job' ? (
                  <JobNotice job={item.data} />
                ) : (
                  <CandidateActivity key={item.updated} item={item} onChanged={reload} />
                )}
              </li>
            ))}
          </ol>
          <Space className="activity-pagination" wrap>
            {before && (
              <Button size="S" onClick={() => setBefore(undefined)}>
                {t('Activity.latest')}
              </Button>
            )}
            {page?.next && (
              <Button size="S" disabled={loading || !fresh} onClick={() => setBefore(page.next!)}>
                {t('Activity.older')}
              </Button>
            )}
          </Space>
        </div>
      </div>
    </aside>
  );
}

function CandidateActivity({
  item,
  onChanged,
}: {
  item: Extract<ActivityItem, { kind: 'candidate' }>;
  onChanged(): void;
}) {
  const app = useApp(),
    pack = app.data.tagging.package,
    candidate = item.data;
  const definition = pack.definitions.find(d => d.key === candidate.tagKey);
  const [review, setReview] = useState<{ generation: number; values: Record<string, AnnotationRecord> }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const label =
    typeof item.subjectLabel === 'string' ? item.subjectLabel : localize(item.subjectLabel, app.locale, pack);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setReview(await call('annotations.get', { subject: { kind: candidate.subjectKind, id: candidate.subjectId } }));
    } catch {
      setError('Activity.loadFailed');
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (accept: boolean) => {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      await call('candidates.resolve', {
        id: candidate.id,
        accept,
        expectedGeneration: review.generation,
        expectedRevision: review.values[candidate.tagKey]?.revision ?? 0,
      });
      setReview(undefined);
      onChanged();
      void app.refresh().catch(notifyError);
    } catch {
      setError('Activity.resolveFailed');
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  };
  if (!definition) return null;
  const value =
    candidate.entities && Array.isArray(candidate.value)
      ? candidate.value.map(v => String((v as { label?: string }).label ?? '')).join(' · ')
      : candidate.createOptions
        ? String(candidate.value)
        : formatValue(definition, candidate.value, app.locale, pack);
  return (
    <div className="activity-suggestion">
      <h3>{t('Activity.suggestion')}</h3>
      <p>{label}</p>
      <div className="activity-field-name">
        {localize(definition.label, app.locale, pack)}
        <FieldInfo definition={definition} />
      </div>
      <dl className="activity-comparison">
        {review && (
          <>
            <dt>{t('Activity.current')}</dt>
            <dd>
              {review.values[candidate.tagKey]
                ? formatValue(definition, review.values[candidate.tagKey].value, app.locale, pack)
                : t('Activity.unset')}
            </dd>
          </>
        )}
        <dt>{t('Activity.proposed')}</dt>
        <dd>{value}</dd>
      </dl>
      {review && <EvidenceDetails evidence={candidate.evidence} />}
      {error && (
        <p className="error-text" role="alert">
          {t(error)}
        </p>
      )}
      <Space wrap>
        {review ? (
          <>
            <Button size="S" disabled={busy} onClick={() => void resolve(true)}>
              {t('Activity.accept')}
            </Button>
            <Button size="S" disabled={busy} onClick={() => void resolve(false)}>
              {t('Activity.reject')}
            </Button>
            <Button size="S" disabled={busy} onClick={() => setReview(undefined)}>
              {t('Activity.closeReview')}
            </Button>
          </>
        ) : (
          <Button size="S" disabled={busy} onClick={() => void load()}>
            {t('Activity.review')}
          </Button>
        )}
        {candidate.subjectKind === 'film' && (
          <Button
            size="S"
            onClick={() =>
              app.open({
                id: 'film:' + candidate.subjectId,
                kind: 'film',
                title: label,
                params: { filmId: candidate.subjectId },
              })
            }
          >
            {t('Activity.openSubject')}
          </Button>
        )}
        {busy && <Spin />}
      </Space>
    </div>
  );
}
