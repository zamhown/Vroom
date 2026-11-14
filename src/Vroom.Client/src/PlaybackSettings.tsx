import { t } from './i18n';
import { FormField, FormLayout } from './components/FormLayout';
import { Button, InputNumber, Select, Switch } from './ui';

export const playbackDefaults = {
  fit: 'contain',
  rotation: 0,
  zoom: 1,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  mirror: false,
  preservePitch: true,
  subtitleDelay: 0,
  subtitleSize: 100,
  audioStream: -1,
  audioFilm: '',
  audioDelay: 0,
  channels: 'source',
  deinterlace: false,
  repeat: 'off',
  seekStep: 10,
};
export type PlaybackPreferences = typeof playbackDefaults;
export type PlaybackInfo = {
  tracks: { index: number; kind: string; codec?: string; language?: string; title?: string; channels: number }[];
  chapters: { start: number; end: number; title?: string }[];
};
export function PlaybackSettings({
  value,
  change,
  info,
  filmId,
  position,
  duration,
  seek,
}: {
  value: PlaybackPreferences;
  change(patch: Partial<PlaybackPreferences>): void;
  info?: PlaybackInfo;
  filmId: string;
  position: number;
  duration: number;
  seek(at: number): void;
}) {
  const number = (key: keyof PlaybackPreferences, min: number, max: number, step: number) => (
    <FormField layout="row" label={t('Playback.' + key)}>
      <InputNumber
        aria-label={t('Playback.' + key)}
        value={Number(value[key])}
        min={min}
        max={max}
        step={step}
        onChange={v => {
          if (Number.isFinite(v)) change({ [key]: Math.min(max, Math.max(min, v)) });
        }}
      />
    </FormField>
  );
  const select = (key: keyof PlaybackPreferences, options: string[]) => (
    <FormField layout="row" label={t('Playback.' + key)}>
      <Select
        aria-label={t('Playback.' + key)}
        value={String(value[key])}
        onChange={v => change({ [key]: String(v) })}
        optionList={options.map(id => ({ value: id, label: t('Playback.' + id) }))}
      />
    </FormField>
  );
  return (
    <>
      <details className="form-disclosure" open>
        <summary>{t('Playback.navigation')}</summary>
        <FormLayout>
          <FormField layout="row" label={t('Playback.jump')}>
            <InputNumber
              aria-label={t('Playback.jump')}
              min={0}
              max={duration}
              value={Math.floor(position)}
              onChange={v => {
                if (Number.isFinite(v)) seek(v);
              }}
            />
          </FormField>
          {!!info?.chapters.length && (
            <FormField layout="row" label={t('Playback.chapter')}>
              <Select
                aria-label={t('Playback.chapter')}
                onChange={v => seek(Number(v))}
                optionList={info.chapters.map((c, i) => ({
                  value: c.start,
                  label: c.title || t('Playback.chapterNumber', { number: i + 1 }),
                }))}
              />
            </FormField>
          )}
          {number('seekStep', 1, 120, 1)}
          {select('repeat', ['off', 'one', 'queue'])}
          <FormField layout="row" label={t('Playback.preservePitch')}>
            <Switch checked={value.preservePitch} onChange={preservePitch => change({ preservePitch })}>
              {t('Playback.preservePitch')}
            </Switch>
          </FormField>
        </FormLayout>
      </details>
      <details className="form-disclosure">
        <summary>{t('Playback.image')}</summary>
        <FormLayout>
          {select('fit', ['contain', 'cover', 'fill'])}
          <FormField layout="row" label={t('Playback.rotation')}>
            <Select
              aria-label={t('Playback.rotation')}
              value={value.rotation}
              onChange={v => change({ rotation: Number(v) })}
              optionList={[0, 90, 180, 270].map(value => ({ value, label: `${value}°` }))}
            />
          </FormField>
          {number('zoom', 0.5, 3, 0.1)}
          {number('brightness', 0.25, 2, 0.05)}
          {number('contrast', 0.25, 2, 0.05)}
          {number('saturation', 0, 2, 0.05)}
          <FormField layout="row" label={t('Playback.mirror')}>
            <Switch checked={value.mirror} onChange={mirror => change({ mirror })}>
              {t('Playback.mirror')}
            </Switch>
          </FormField>
        </FormLayout>
      </details>
      <details className="form-disclosure">
        <summary>{t('Playback.audio')}</summary>
        <FormLayout>
          <FormField layout="row" label={t('Playback.audioStream')} description={t('Playback.processingHelp')}>
            <Select
              aria-label={t('Playback.audioStream')}
              value={value.audioFilm === filmId ? value.audioStream : -1}
              onChange={v => change({ audioStream: Number(v), audioFilm: filmId })}
              optionList={[
                { value: -1, label: t('Playback.automatic') },
                ...(info?.tracks.filter(track => track.kind === 'audio') ?? []).map(track => ({
                  value: track.index,
                  label: [
                    t('Playback.trackNumber', { number: track.index }),
                    track.title,
                    track.language,
                    track.codec,
                    t('Playback.channelCount', { count: track.channels }),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                })),
              ]}
            />
          </FormField>
          {number('audioDelay', -5, 5, 0.1)}
          {select('channels', ['source', 'stereo', 'mono'])}
          <FormField layout="row" label={t('Playback.deinterlace')}>
            <Switch checked={value.deinterlace} onChange={deinterlace => change({ deinterlace })}>
              {t('Playback.deinterlace')}
            </Switch>
          </FormField>
        </FormLayout>
      </details>
      <details className="form-disclosure">
        <summary>{t('PlayerPage.subtitles')}</summary>
        <FormLayout>
          {number('subtitleDelay', -120, 120, 0.1)}
          {number('subtitleSize', 50, 200, 10)}
        </FormLayout>
      </details>
      <Button onClick={() => change({ ...playbackDefaults })}>{t('Playback.reset')}</Button>
    </>
  );
}
