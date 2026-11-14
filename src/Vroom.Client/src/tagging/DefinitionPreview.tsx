import { t as appText, translate } from '../i18n';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Select, Modal } from '../ui';
import {
  IconClose,
  IconRefresh,
  IconVideo,
  IconPlay,
  IconList,
  IconFullscreen,
  IconVolume,
  IconTag,
  IconTimePoint,
  IconTimeRange,
} from '../icons';
import { PreviewSurface } from './PreviewSurface';
import { InfoPopover } from '../components/InfoPopover';
import { FormField } from '../components/FormLayout';
import { useApp } from '../context';
import { TagInput, TagValue, SchemaIcon, Stars } from './Inputs';
import { localize } from './i18n';
import { configText, editorGuidance } from './config-editor';
import { previewContext, previewValue, type PreviewContext } from './preview-context';
import type { Definition, Json, LayoutNode, LocalizedText, TagPackage } from './types';

const surfaceNames: Record<string, string> = {
  'film.details': 'DefinitionPreview.filmDetails',
  'player.inspector': 'DefinitionPreview.playerSidebar',
  'term.details': 'DefinitionPreview.valueDetails',
  'film.card': 'DefinitionPreview.filmCard',
  'film.table': 'DefinitionPreview.filmTable',
  navigation: 'DefinitionPreview.navigation',
  library: 'DefinitionPreview.filmLibrary',
  player: 'DefinitionPreview.player',
};

export function DefinitionPreview({
  definition: d,
  catalog,
  purpose,
  docked = false,
}: {
  definition: Definition;
  catalog?: TagPackage;
  purpose?: 'edit' | 'display';
  docked?: boolean;
}) {
  const app = useApp(),
    pack = catalog ?? app.data.tagging.package,
    locale = app.locale;
  const tr = (key: string) => translate(key, locale),
    t = (text: any) => localize(text, locale, pack);
  const sample = () => previewValue(d, pack, tr('DefinitionPreview.exampleText'));
  const [value, setValue] = useState<Json>(sample),
    [location, setLocation] = useState(''),
    [expanded, setExpanded] = useState(false);
  const contract = JSON.stringify([d.value, d.value.vocabulary]);
  useEffect(() => setValue(sample()), [contract]);
  const placements = (d.placements ?? []).filter(p => !purpose || p.mode === purpose),
    placement = placements.find(p => p.id === location) ?? placements[0];
  const context = previewContext(pack, placement);
  const slotName = (key: string) => t((editorGuidance.slots as Record<string, LocalizedText>)[key]) || key;
  const spec = d.display?.[placement?.view.split('.')[1]] ?? d.display?.default;
  const editing = (placement?.mode === 'edit' || (purpose === 'edit' && !placement)) && d.writes?.manual !== false;
  const inputView = editing && (!context || (context.kind === 'layout' && context.path.at(-1)?.mode !== 'display'));
  const toggleView = editing && context?.kind !== 'layout' && spec?.component === 'icon-toggle@1';
  const heading = context
    ? configText(surfaceNames[context.surface] ?? context.surface, locale)
    : tr('DefinitionPreview.controlTrial');
  const fieldLabel = t(d.label),
    empty = value == null || (Array.isArray(value) && !value.length);
  const input = (
    <TagInput
      definition={d}
      value={value}
      onChange={setValue}
      allowCreate={false}
      showState
      catalog={pack}
      compact={placement?.view === 'input.compact' || context?.surface === 'player.inspector'}
    />
  );
  let display: ReactNode = empty ? (
    <span className="muted">{tr('DefinitionPreview.empty')}</span>
  ) : (
    <TagValue definition={d} value={value} spec={spec} catalog={pack} />
  );
  if (toggleView)
    display = (
      <Button
        theme="borderless"
        aria-label={t(value ? spec.props?.trueLabel : spec.props?.falseLabel) || fieldLabel}
        aria-pressed={Boolean(value)}
        icon={<SchemaIcon name={value ? spec.props?.trueIcon : spec.props?.falseIcon} />}
        onClick={() => setValue(!value)}
      />
    );
  if (placement?.mode === 'navigate' && d.navigation) {
    const nav = d.navigation,
      bands = d.facets?.[nav.props?.facet]?.bands;
    display =
      nav.component === 'rating-band-navigation@1' && bands ? (
        <div className="preview-navigation-bands">
          {bands.map((band: any, index: number) => (
            <span key={band.id} title={t(band.label)}>
              <Stars value={index + 1} maximum={bands.length} symbols={1} label={t(band.label)} />
            </span>
          ))}
        </div>
      ) : (
        <span className="preview-navigation-entry">
          <SchemaIcon name={nav.props?.icon} />
          {t(nav.props?.label ?? d.label)}
        </span>
      );
  }
  const previewTitle = tr(
    purpose === 'edit'
      ? 'DefinitionPreview.editPreview'
      : purpose === 'display'
        ? 'DefinitionPreview.displayPreview'
        : 'DefinitionPreview.pagePreview',
  );
  const pagePreview = (
    <Modal
      mode="modeless"
      title={placement ? slotName(placement.slot) : heading}
      visible={expanded}
      width={1000}
      onCancel={() => setExpanded(false)}
      footer={<Button onClick={() => setExpanded(false)}>{tr('DefinitionPreview.close')}</Button>}
    >
      {context && placement && (
        <div className="preview-expanded">
          <div className="preview-map is-expanded">
            {context.kind === 'layout' ? (
              <PreviewSurface
                root={context.root}
                catalog={pack}
                currentKey={d.key}
                region={placement.slot}
                field={inputView ? input : display}
              />
            ) : (
              <ContextMap
                context={context}
                region={placement.slot}
                label={fieldLabel}
                text={t}
                tr={tr}
                field={inputView ? input : display}
              />
            )}
          </div>
          <p className="muted">{tr('DefinitionPreview.tryTheHighlightedFieldTrialValuesAre')}</p>
        </div>
      )}
    </Modal>
  );
  if (docked)
    return (
      <section
        className={'definition-preview definition-preview-docked preview-trial-' + purpose}
        aria-label={previewTitle}
      >
        <div className="preview-sample-control">
          <FormField
            label={purpose === 'edit' ? fieldLabel : tr('DefinitionPreview.exampleValue')}
            description={
              purpose === 'edit' && d.writes?.manual === false ? tr('DefinitionPreview.manualDisabled') : undefined
            }
          >
            <TagInput
              definition={d}
              value={value}
              onChange={setValue}
              disabled={purpose === 'edit' && d.writes?.manual === false}
              allowCreate={false}
              catalog={pack}
            />
          </FormField>
          {(purpose !== 'edit' || d.writes?.manual !== false) && (
            <div className="preview-trial-actions">
              <Button
                theme="borderless"
                size="S"
                aria-label={tr('DefinitionPreview.resetExample')}
                title={tr('DefinitionPreview.resetExample')}
                icon={<IconRefresh />}
                onClick={() => setValue(sample())}
              />
              <Button
                theme="borderless"
                size="S"
                aria-label={tr('DefinitionPreview.clearTrialValue')}
                title={tr('DefinitionPreview.clearTrialValue')}
                disabled={empty}
                icon={<IconClose />}
                onClick={() => setValue(null)}
              />
            </div>
          )}
        </div>
        {purpose === 'display' && (
          <div className="preview-output">
            <span className="preview-transform" aria-hidden="true">
              →
            </span>
            <FormField label={tr('DefinitionPreview.renderedResult')}>
              <output className="preview-rendered-value" aria-live="polite">
                {display}
              </output>
            </FormField>
          </div>
        )}
        {placement && (
          <div className="preview-placement-context">
            {placements.length > 1 ? (
              <Select
                aria-label={tr('DefinitionPreview.previewPlacement')}
                value={placement.id}
                optionList={placements.map(p => ({ value: p.id, label: slotName(p.slot) }))}
                onChange={v => setLocation(String(v))}
              />
            ) : (
              <span>{slotName(placement.slot)}</span>
            )}
            {context && (
              <Button size="S" theme="borderless" icon={<IconFullscreen />} onClick={() => setExpanded(true)}>
                {tr('DefinitionPreview.viewInPage')}
              </Button>
            )}
          </div>
        )}
        {pagePreview}
      </section>
    );
  return (
    <section className={'definition-preview' + (docked ? ' definition-preview-docked' : '')} aria-label={previewTitle}>
      {!docked && (
        <header className="definition-preview-heading">
          <h3>{previewTitle}</h3>
          <InfoPopover label={tr('DefinitionPreview.aboutThisPreview')}>
            <p>{tr('DefinitionPreview.theHighlightedRegionLocatesThisFieldIn')}</p>
          </InfoPopover>
        </header>
      )}
      <Select
        aria-label={tr('DefinitionPreview.previewPlacement')}
        disabled={!placements.length}
        value={placement?.id ?? 'default'}
        optionList={
          placements.length
            ? placements.map(p => ({ value: p.id, label: slotName(p.slot) }))
            : [{ value: 'default', label: tr('DefinitionPreview.noPlacementConfigured') }]
        }
        onChange={v => setLocation(String(v))}
      />
      <figure className="preview-scene">
        <figcaption>
          <strong>{heading}</strong>
          {context && (
            <Button
              theme="borderless"
              size="S"
              icon={<IconFullscreen />}
              aria-label={tr('DefinitionPreview.expandPagePreview')}
              title={tr('DefinitionPreview.expandPagePreview')}
              onClick={() => setExpanded(true)}
            />
          )}
        </figcaption>
        {!docked && context && placement ? (
          <div className="preview-map" aria-label={slotName(placement.slot)}>
            <ContextMap context={context} region={placement.slot} label={fieldLabel} text={t} tr={tr} />
          </div>
        ) : (
          !purpose && (
            <div className="preview-unplaced">
              <IconList />
              <span>
                {placement
                  ? appText('DefinitionPreview.thisRegionIsNotBoundToAn')
                  : appText('DefinitionPreview.addAPlacementToLocateTheField')}
              </span>
            </div>
          )
        )}
        <div className="preview-live-region">
          <div className="preview-live-label">
            <strong>{fieldLabel}</strong>
            <span>
              {inputView
                ? appText('DefinitionPreview.tryIt')
                : toggleView
                  ? appText('DefinitionPreview.tryClicking')
                  : appText('DefinitionPreview.display')}
            </span>
          </div>
          {inputView ? input : <div className="preview-live-value">{display}</div>}
        </div>
      </figure>
      {!inputView && !toggleView && placement?.mode !== 'navigate' && (
        <details className="preview-trial form-disclosure">
          <summary>{tr('DefinitionPreview.editTrialValue')}</summary>
          <div>{input}</div>
        </details>
      )}
      {placement?.mode !== 'navigate' && (
        <div className="preview-trial-actions">
          {!docked && <span className="muted">{tr('DefinitionPreview.previewOnly')}</span>}
          <Button
            theme="borderless"
            size="S"
            aria-label={tr('DefinitionPreview.resetExample')}
            title={tr('DefinitionPreview.resetExample')}
            icon={<IconRefresh />}
            onClick={() => setValue(sample())}
          />
          <Button
            theme="borderless"
            size="S"
            aria-label={tr('DefinitionPreview.clearTrialValue')}
            title={tr('DefinitionPreview.clearTrialValue')}
            disabled={empty}
            icon={<IconClose />}
            onClick={() => setValue(null)}
          />
        </div>
      )}
      {pagePreview}
    </section>
  );
}

function Ghost({ short = false }: { short?: boolean }) {
  return <span className={'preview-ghost' + (short ? ' short' : '')} aria-hidden="true" />;
}
function ContextMap({
  context,
  region,
  label,
  text,
  tr,
  field,
}: {
  context: PreviewContext;
  region: string;
  label: string;
  text(value: any): string;
  tr(key: string): string;
  field?: ReactNode;
}) {
  const mark = field ? (
    <div className="preview-location-field">
      <strong>{label}</strong>
      {field}
    </div>
  ) : (
    <span className="preview-location-marker">{label}</span>
  );
  const node = (n: LayoutNode, depth = 0): ReactNode => {
    if (depth > 12) return <Ghost />;
    const regions = Array.isArray(n.region) ? n.region : [n.region];
    if (regions.includes(region))
      return (
        <div className="preview-map-target">
          {n.title && <small>{text(n.title)}</small>}
          {mark}
        </div>
      );
    if (n.children?.length) {
      const tracks = n.type === 'grid' ? (n.tracks?.regular ?? n.children.map(() => 1)) : undefined;
      return (
        <div
          className={'preview-layout-node preview-layout-' + n.type}
          style={
            tracks
              ? ({ '--layout-tracks': tracks.map((v: number) => 'minmax(0,' + v + 'fr)').join(' ') } as CSSProperties)
              : undefined
          }
        >
          {n.title && <small>{text(n.title)}</small>}
          {n.children.map(child => (
            <div key={child.id} className="preview-layout-child">
              {node(child, depth + 1)}
            </div>
          ))}
        </div>
      );
    }
    if (n.type === 'identity')
      return (
        <div className="preview-map-identity">
          <IconVideo />
          <Ghost />
        </div>
      );
    if (n.type === 'scope-picker')
      return (
        <div className="preview-scope">
          {(n.modes ?? ['whole', 'point', 'interval']).map((mode: string) => {
            const [Icon, name] =
              mode === 'whole'
                ? [IconVideo, tr('DefinitionPreview.whole')]
                : mode === 'point'
                  ? [IconTimePoint, tr('DefinitionPreview.point')]
                  : [IconTimeRange, tr('DefinitionPreview.range')];
            return (
              <span key={mode} title={name as string}>
                {typeof Icon !== 'string' && <Icon />}
                <span>{name as string}</span>
              </span>
            );
          })}
        </div>
      );
    if (n.type === 'time-range') return null;
    if (n.type === 'annotation-list')
      return (
        <div className="preview-map-placeholder">
          <small>{n.title ? text(n.title) : tr('DefinitionPreview.annotations')}</small>
          <Ghost />
          <Ghost short />
        </div>
      );
    return (
      <div className={'preview-map-placeholder' + (n.type === 'action-bar' ? ' inline' : '')}>
        {n.title && <small>{text(n.title)}</small>}
        <Ghost />
        <Ghost short />
      </div>
    );
  };
  if (context.kind === 'layout')
    return context.surface === 'player.inspector' ? (
      <PreviewPlayer
        tr={tr}
        aside={
          <>
            <header className="preview-inspector-heading">
              <IconTag />
              <span>{text(context.title) || tr('DefinitionPreview.annotations_6')}</span>
            </header>
            {node(context.root)}
          </>
        }
      />
    ) : (
      <div className="preview-layout-page">{node(context.root)}</div>
    );
  if (context.kind === 'card')
    return (
      <div className="preview-card-map">
        <div className="preview-card-cover">
          <IconVideo />
          <div className="preview-card-top">
            <span>{region === 'film.card.overlay.top-left' ? mark : <Ghost short />}</span>
            <span>{region === 'film.card.overlay.top-right' ? mark : null}</span>
          </div>
          <div className="preview-card-bottom">{region === 'film.card.overlay.bottom' ? mark : <Ghost short />}</div>
        </div>
        <div className="preview-card-title">{region === 'film.card.title' ? mark : <Ghost />}</div>
        <div className="preview-card-meta">
          <span>{region === 'film.card.meta.leading' ? mark : <Ghost short />}</span>
          <span>{region === 'film.card.meta.trailing' ? mark : <Ghost short />}</span>
        </div>
      </div>
    );
  if (context.kind === 'navigation')
    return (
      <div className="preview-nav-map">
        <div>
          <IconList />
          <Ghost />
          {mark}
          <Ghost />
          <Ghost />
        </div>
        <div className="preview-library-tiles">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  if (context.kind === 'table')
    return (
      <div className="preview-table-map">
        <div>
          <Ghost />
          {mark}
        </div>
        {[0, 1, 2].map(i => (
          <div key={i}>
            <Ghost />
            <Ghost short />
          </div>
        ))}
      </div>
    );
  if (context.kind === 'player')
    return (
      <PreviewPlayer
        tr={tr}
        aside={
          region === 'player.queue.item.trailing' ? (
            <div className="preview-queue">
              <small>{tr('DefinitionPreview.playlist')}</small>
              <Ghost />
              {mark}
              <Ghost />
            </div>
          ) : undefined
        }
        toolbar={region === 'player.toolbar.extensions' ? mark : undefined}
      />
    );
  return (
    <div className="preview-library-map">
      <div className="preview-controls">
        <Ghost short />
        {mark}
      </div>
      <div className="preview-library-tiles">
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function PreviewPlayer({ aside, toolbar, tr }: { aside?: ReactNode; toolbar?: ReactNode; tr(key: string): string }) {
  return (
    <div className={'preview-player-shell' + (aside ? ' with-aside' : '')}>
      <div className="preview-player-main">
        <div className="preview-player-picture">
          <IconVideo />
          <span>{tr('DefinitionPreview.video')}</span>
          <div className="preview-picture-frame" aria-hidden="true">
            <IconPlay />
          </div>
        </div>
        <div className="preview-player-controls" aria-label={tr('DefinitionPreview.playbackControlBarLocation')}>
          <div className="preview-progress">
            <i />
          </div>
          <div>
            <IconPlay />
            <span className="preview-time">00:42 / 02:00</span>
            <IconVolume />
            {toolbar}
            <span className="preview-control-spacer" />
            <IconTag />
            <IconFullscreen />
          </div>
        </div>
      </div>
      {aside && <aside className="preview-player-inspector">{aside}</aside>}
    </div>
  );
}
