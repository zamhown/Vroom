import { t as appText } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { useState } from 'react';
import { Button, Checkbox, Input, Modal, Select, Space } from '../ui';
import { IconPlay } from '../icons';
import { call, startJob } from '../api';
import { action, useApp, useJob, useTabState } from '../context';
import { EmptyState, JobNotice, Page, PageHeading } from '../components';
import { defaultQuery, terminal, type DuplicateSet, type Film } from '../types';
import type { WorkspaceTab } from '../workspace';
import { localize } from '../tagging/i18n';
import { placements } from '../tagging/LayoutFrame';
import { TagValue } from '../tagging/Inputs';
export function DuplicatesPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const pack = app.data.tagging.package;
  const policy = pack.catalogPolicy.dedup;
  const [state, set] = useTabState(tab, {
    keys: (policy?.keys ?? []).map((k: { tag: string }) => k.tag) as string[],
    jobId: '',
    selected: {} as Record<string, string[]>,
    resolved: [] as string[],
    groupNames: {} as Record<string, string>,
    reviewIndex: 0,
  });
  const [groups, setGroups] = useState<DuplicateSet[]>([]);
  const job = useJob<DuplicateSet[]>(state.jobId, setGroups);
  const remaining = groups.filter(g => !state.resolved.includes(g.key));
  const group = remaining[state.reviewIndex % Math.max(1, remaining.length)];
  const chosen = group ? (state.selected[group.key] ?? []) : [];
  const open = (film: Film, kind: 'player' | 'film') =>
    app.open({ id: kind + ':' + film.id, kind, title: film.presentation.tabTitle, params: { filmId: film.id } });
  const apply = () => {
    if (!group || !chosen.length) return;
    Modal.confirm({
      title: appText('DuplicatesPage.keepOther', { p0: chosen.length }),
      content:
        chosen.length > 1
          ? appText('DuplicatesPage.mergeAsVersions', { count: chosen.length })
          : appText('DuplicatesPage.otherRecordsWillChangeVisibilityAccordingTo'),
      onOk: async () => {
        const expectedRevisions = Object.fromEntries(
          group.films.map(f => [
            f.id,
            f.values[chosen.includes(f.id) ? policy.keptValue.tag : policy.excludedValue.tag]?.revision ?? 0,
          ]),
        );
        await call('duplicates.apply', {
          candidateIds: group.films.map(f => f.id),
          keepIds: chosen,
          expectedGeneration: app.data.tagging.generation,
          expectedRevisions,
          name: state.groupNames[group.key] || group.films[0].presentation.title,
        });
        set({ resolved: [...state.resolved, group.key], reviewIndex: 0 });
        await app.refresh();
      },
    });
  };
  return (
    <Page>
      <PageHeading title={appText('DuplicatesPage.duplicates')}>
        {policy?.excludedValue && (
          <Button
            onClick={() =>
              app.open({
                id: 'duplicates:excluded',
                kind: 'library',
                title: appText('DuplicatesPage.organizedRecords'),
                params: {
                  query: { ...defaultQuery(), where: { op: 'eq', ...policy.excludedValue }, ignoreDefaultQuery: true },
                },
              })
            }
          >
            {appText('DuplicatesPage.organizedRecords')}
          </Button>
        )}
        <Button
          theme="solid"
          disabled={!state.keys.length || (job != null && !terminal(job.state))}
          onClick={() =>
            action(async () => {
              setGroups([]);
              set({
                jobId: await startJob('duplicates.find', { keys: state.keys }),
                resolved: [],
                selected: {},
                reviewIndex: 0,
              });
            })
          }
        >
          {appText('DuplicatesPage.findDuplicates')}
        </Button>
      </PageHeading>
      <FormLayout>
        <FormField layout="row" label={appText('DuplicatesPage.compareFields')}>
          <Select
            multiple
            aria-label={appText('DuplicatesPage.deduplicationFields')}
            value={state.keys}
            onChange={v => set({ keys: v as string[] })}
            optionList={pack.definitions
              .filter(d => d.enabled && d.query?.deduplicate)
              .map(d => ({ value: d.key, label: localize(d.label, app.locale, pack) }))}
          />
        </FormField>
      </FormLayout>
      <JobNotice job={job} />
      {!group ? (
        <EmptyState
          title={appText(
            !state.jobId
              ? 'Journey.findVersions'
              : job && !terminal(job.state)
                ? 'Journey.checkingVersions'
                : 'DuplicatesPage.noDuplicatesToOrganize',
          )}
        />
      ) : (
        <>
          <div className="duplicate-heading">
            <h2>{group.films[0].presentation.tabTitle}</h2>
            <Button
              disabled={remaining.length < 2}
              onClick={() => set({ reviewIndex: (state.reviewIndex + 1) % remaining.length })}
            >
              {appText('DuplicatesPage.reviewLater')}
            </Button>
          </div>
          <div className="version-grid">
            {group.films.map(film => (
              <article
                data-context-resource=""
                className={'version-card' + (chosen.includes(film.id) ? ' selected' : '')}
                key={film.id}
              >
                <Checkbox
                  checked={chosen.includes(film.id)}
                  onChange={e =>
                    set({
                      selected: {
                        ...state.selected,
                        [group.key]: e.target.checked ? [...chosen, film.id] : chosen.filter(id => id !== film.id),
                      },
                    })
                  }
                >
                  {appText('DuplicatesPage.keepThisVersion')}
                </Checkbox>
                <h3>{film.presentation.title}</h3>
                <div className="schema-compare-values">
                  <dl className="description-list">
                    {placements(pack, 'film.details.facts').map(({ definition: d }) => (
                      <div key={d.key}>
                        <dt>{localize(d.label, app.locale, pack)}</dt>
                        <dd>
                          <TagValue definition={d} value={film.values[d.key]?.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <Space>
                  <Button icon={<IconPlay />} onClick={() => open(film, 'player')}>
                    {appText('DuplicatesPage.playToCompare')}
                  </Button>
                  <Button onClick={() => open(film, 'film')}>{appText('DuplicatesPage.filmDetails')}</Button>
                </Space>
              </article>
            ))}
          </div>
          <div className="review-decision">
            <b>
              {appText('DuplicatesPage.keep')}
              {chosen.length} {appText('DuplicatesPage.versions')}
            </b>
            {chosen.length > 1 && (
              <FormField label={appText('DuplicatesPage.filmGroupName')}>
                <Input
                  aria-label={appText('DuplicatesPage.filmGroupName')}
                  value={state.groupNames[group.key] || ''}
                  onChange={name => set({ groupNames: { ...state.groupNames, [group.key]: name } })}
                />
              </FormField>
            )}
            <Button theme="solid" disabled={!chosen.length} onClick={apply}>
              {appText('DuplicatesPage.applyOrganization')}
            </Button>
          </div>
        </>
      )}
    </Page>
  );
}
