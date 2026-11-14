import { openContextMenu } from './ContextMenu';
import { JobOutcome } from './components/JobOutcome';
import { t as appText } from './i18n';
import { useState, type ComponentPropsWithRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react';
import { posterLayout, type PosterLayout } from './poster-layout';
import { Button, Space, Progress } from './ui';
import { IconFolder, IconInfo, IconPlay, IconVideo } from './icons';
import { useApp } from './context';
import { call } from './api';
import { jobStateLabel, terminal, type Film, type Job } from './types';
import { Slot } from './tagging/Surface';
import { PageToolbarContext } from './components/page-toolbar-context';
export function Page({
  children,
  className = '',
  variant,
  header,
  ...props
}: ComponentPropsWithRef<'div'> & { variant?: 'workspace'; header?: ReactNode }) {
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  return (
    <PageToolbarContext.Provider value={toolbarHost}>
      <div className="page-frame">
        <div className="page-header">
          <div className="page-header-content" ref={setToolbarHost}>
            {header}
          </div>
        </div>
        <div {...props} className={['page-scroll', variant && 'page-' + variant, className].filter(Boolean).join(' ')}>
          <div className="page-content">{children}</div>
        </div>
      </div>
    </PageToolbarContext.Provider>
  );
}
export function PageHeading({
  title,
  meta,
  navigation,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  meta?: ReactNode;
  navigation?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-title">
        <h1>{title}</h1>
        {meta != null && <span className="page-heading-meta">{meta}</span>}
      </div>
      {navigation && <div className="page-heading-navigation">{navigation}</div>}
      {children && (
        <Space className="page-heading-actions" wrap>
          {children}
        </Space>
      )}
    </header>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <IconFolder />
      </div>
      <h3>{title}</h3>
      {description && <p className="form-help">{description}</p>}
      {children}
    </div>
  );
}
export function JobNotice({ job }: { job?: Job }) {
  const app = useApp();
  if (!job) return null;
  const active = !terminal(job.state);
  return (
    <div className={'job-notice ' + ((['failed', 'interrupted'] as string[]).includes(job.state) ? 'has-error' : '')}>
      <header className="job-notice-heading">
        <div className="job-notice-title">
          <span>{appText(job.name, job.nameArgs)}</span>
          <span className="job-notice-state" role="status">
            {jobStateLabel(job.state)}
          </span>
        </div>
        <Button
          size="S"
          onClick={() => {
            app.open({ id: 'jobs', kind: 'jobs', title: appText('components.backgroundTasks') });
            app.patchState('jobs', previous => ({ ...previous, detailJobId: job.id }));
          }}
        >
          {appText('components.viewTask')}
        </Button>
      </header>
      {(job.error || (active && job.detail)) && (
        <p
          className={job.error ? 'job-notice-detail error-text' : 'job-notice-detail'}
          role={job.error ? 'alert' : undefined}
        >
          {job.error ? appText(job.error, job.errorArgs) : appText(job.detail, job.detailArgs)}
        </p>
      )}
      {active && job.total != null && job.total > 0 && (
        <div className="job-notice-progress">
          <Progress percent={Math.min(100, (job.completed / job.total) * 100)} />
          <span>{appText('jobs.progressCount', { completed: job.completed, total: job.total })}</span>
        </div>
      )}
      <JobOutcome job={job} compact />
    </div>
  );
}
export function FilmCard({
  film,
  onPlay,
  onDetail,
}: {
  film: Film;
  onPlay(): void;
  onDetail(): void;
  compact?: boolean;
}) {
  const app = useApp();
  const { image, frameAt, imageSize, imagePresentation } = film.presentation;
  const src = image
    ? app.data.mediaBase + '/poster/' + film.id
    : frameAt != null
      ? app.data.mediaBase + '/thumb/' + film.id + '?at=' + frameAt
      : undefined;
  // Reported sizes keep each card's width stable while its image loads; the loaded image wins.
  const reported = image
    ? imageSize && imageSize.width / imageSize.height
    : src && film.width > 0 && film.height > 0
      ? film.width / film.height
      : undefined;
  const source = image || (src ? 'frame:' + frameAt : '');
  const [measured, setMeasured] = useState<{ source: string; aspect: number }>();
  const layout = posterLayout(
    image ? imagePresentation : undefined,
    measured?.source === source ? measured.aspect : reported,
  );
  const loaded = ({ currentTarget: img }: SyntheticEvent<HTMLImageElement>) => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0)
      setMeasured({ source, aspect: img.naturalWidth / img.naturalHeight });
  };
  const isCase = !!src && layout.kind === 'case';
  return (
    <article
      data-context-resource=""
      data-poster={isCase ? 'case' : undefined}
      className="film-card"
      style={{ '--poster-ratio': layout.ratio } as CSSProperties}
      onContextMenu={event =>
        openContextMenu(event, [
          { id: 'play', label: appText('components.play'), run: onPlay },
          { id: 'details', label: appText('components.details'), run: onDetail },
          { id: 'locate', label: appText('Journey.locateFile'), run: () => call('platform.reveal', { id: film.id }) },
          { id: 'copy', label: appText('ContextMenu.copyPath'), run: () => navigator.clipboard.writeText(film.path) },
        ])
      }
    >
      <div className="film-cover" data-poster={src ? layout.kind : undefined}>
        {!src ? (
          <div className="poster-placeholder">
            <IconVideo />
            <span>{film.presentation.tabTitle}</span>
          </div>
        ) : layout.kind === 'case' ? (
          <DiscCase src={src} layout={layout} onLoad={loaded} />
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            data-side={layout.kind === 'cover' ? layout.side : undefined}
            onLoad={loaded}
          />
        )}
        <Button
          className="film-cover-open"
          theme="borderless"
          aria-label={appText('components.details')}
          onClick={onDetail}
        />
        {film.position > 0 && (
          <div
            className="cover-resume"
            style={{ width: Math.min(100, (film.position / Math.max(1, film.duration)) * 100) + '%' }}
          />
        )}
      </div>
      <div className="film-caption">
        <Button className="film-title" theme="borderless" onClick={onDetail}>
          {film.presentation.title}
        </Button>
      </div>
      <div className="film-card-footer">
        <div className="film-meta film-card-summary">
          {film.missingSince && (
            <span className="chip missing-chip" title={appText('components.missingHelp')}>
              {appText('components.missing')}
            </span>
          )}
          <Slot film={film} region="film.card.overlay.top-left" className="film-meta-leading" />
          <Slot film={film} region="film.card.overlay.bottom" className="film-meta-cover" />
        </div>
        <div className="film-meta">
          <Slot film={film} region="film.card.meta.leading" className="film-meta-leading" />
          <Slot film={film} region="film.card.meta.trailing" className="film-meta-trailing" />
        </div>
        <div className="film-card-commands">
          <Slot film={film} region="film.card.overlay.top-right" className="film-card-annotations" actionSize="S" />
          <div className="film-card-primary">
            <Button
              theme="borderless"
              size="S"
              icon={<IconPlay />}
              aria-label={appText('components.play')}
              title={appText('components.play')}
              onClick={onPlay}
            />
            <Button
              theme="borderless"
              size="S"
              icon={<IconInfo />}
              aria-label={appText('components.details')}
              title={appText('components.details')}
              onClick={onDetail}
            />
          </div>
        </div>
      </div>
    </article>
  );
}
/** An unfolded case image (back | spine | front) folded into a turned 3D case. */
function DiscCase({
  src,
  layout,
  onLoad,
}: {
  src: string;
  layout: Extract<PosterLayout, { kind: 'case' }>;
  onLoad(event: SyntheticEvent<HTMLImageElement>): void;
}) {
  const size = { '--case-width': layout.width, '--case-height': layout.height, '--case-depth': layout.depth };
  return (
    <div className="disc-stage">
      <div className="disc-case" style={size as CSSProperties}>
        {(['back', 'spine', 'front'] as const).map(face => (
          <span key={face} className="disc-case-face" data-face={face}>
            <img src={src} alt="" loading="lazy" decoding="async" onLoad={face === 'front' ? onLoad : undefined} />
          </span>
        ))}
        {['top', 'bottom', 'fore'].map(edge => (
          <span key={edge} className="disc-case-edge" data-edge={edge} />
        ))}
      </div>
    </div>
  );
}
