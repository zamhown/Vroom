import { useState } from 'react';
import { FileTrigger, ActionButton, Text, SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2';
import registry from '../../../resources/tagging/playback-capabilities.json';
import { t } from './i18n';
import { notifyError } from './context';
import { FormField, FormLayout } from './components/FormLayout';
import { Button, InputNumber, Select, Switch } from './ui';
import type { NativeController, NativeValues } from './useNativePlayback';
import type { NativeCapabilities } from './pages/EnginePlayerPage';

type Setting = {
  type?: string;
  default: string | number | boolean;
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  'x-group': string;
  'x-step'?: number;
  'x-labels'?: string[];
};
export const nativeSettings = registry.nativePlayback.settings.properties as Record<string, Setting>;
export function EnginePicker({
  value,
  change,
  capabilities,
}: {
  value: string;
  change(engine: string): void;
  capabilities?: NativeCapabilities;
}) {
  return (
    <FormLayout>
      <FormField
        layout="row"
        label={t('Mpv.engine')}
        description={t(capabilities?.available ? 'Mpv.engineHelp' : 'Mpv.installHelp')}
      >
        <Select
          aria-label={t('Mpv.engine')}
          value={value}
          onChange={v => change(String(v))}
          optionList={[
            { value: 'auto', label: t('Mpv.automatic') },
            { value: 'mpv', label: t('Mpv.mpv'), disabled: !capabilities?.available },
            { value: 'browser', label: t('Mpv.browser') },
          ]}
        />
      </FormField>
    </FormLayout>
  );
}
export function NativePlaybackSettings({
  native,
  values,
  change,
  position,
  duration,
  seek,
  repeat,
  seekStep,
  navigation,
}: {
  native: NativeController;
  values: NativeValues;
  change(values: NativeValues): void;
  position: number;
  duration: number;
  seek(position: number): void;
  repeat: string;
  seekStep: number;
  navigation(value: { repeat?: string; seekStep?: number }): void;
}) {
  const [group, setGroup] = useState('playback'),
    [busy, setBusy] = useState(false);
  const apply = async (patch: NativeValues) => {
    setBusy(true);
    try {
      await native.apply(patch);
      change(patch);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const act = (method: string, args: Record<string, unknown>) => {
    void native.command(method, args).catch(notifyError);
  };
  const track = (kind: 'aid' | 'sid' | 'secondary-sid' | 'vid', type: string) => (
    <FormField key={kind} layout="row" label={t('Mpv.' + kind)}>
      <Select
        aria-label={t('Mpv.' + kind)}
        value={native.status[kind] || 'no'}
        onChange={track => act('track', { kind, track })}
        optionList={[
          { value: 'auto', label: t('Mpv.automatic') },
          { value: 'no', label: t('Mpv.off') },
          ...(native.status['track-list'] ?? [])
            .filter(track => track.type === type)
            .map(track => ({
              value: track.id,
              label: [t('Playback.trackNumber', { number: track.id }), track.title, track.lang, track.codec]
                .filter(Boolean)
                .join(' · '),
            })),
        ]}
      />
    </FormField>
  );
  return (
    <div className="native-playback-settings">
      <SegmentedControl
        aria-label={t('Mpv.settingsGroup')}
        selectedKey={group}
        onSelectionChange={key => setGroup(String(key))}
      >
        {registry.nativePlayback.groups.map(id => (
          <SegmentedControlItem key={id} id={id}>
            {t('Mpv.' + id)}
          </SegmentedControlItem>
        ))}
        <SegmentedControlItem id="diagnostics">{t('Mpv.diagnostics')}</SegmentedControlItem>
      </SegmentedControl>
      <FormLayout>
        {group === 'playback' && (
          <>
            <FormField layout="row" label={t('Playback.jump')}>
              <InputNumber
                aria-label={t('Playback.jump')}
                value={Math.floor(position)}
                min={0}
                max={duration}
                onChange={v => {
                  if (Number.isFinite(v)) seek(v);
                }}
              />
            </FormField>
            {!!native.status['chapter-list']?.length && (
              <FormField layout="row" label={t('Playback.chapter')}>
                <Select
                  aria-label={t('Playback.chapter')}
                  value={native.status.chapter}
                  onChange={v => act('chapter', { index: Number(v) })}
                  optionList={native.status['chapter-list'].map((c, i) => ({
                    value: i,
                    label: c.title || t('Playback.chapterNumber', { number: i + 1 }),
                  }))}
                />
              </FormField>
            )}
            <FormField layout="row" label={t('Playback.seekStep')}>
              <InputNumber
                aria-label={t('Playback.seekStep')}
                value={seekStep}
                min={1}
                max={120}
                onChange={v => {
                  if (Number.isFinite(v)) navigation({ seekStep: v });
                }}
              />
            </FormField>
            <FormField layout="row" label={t('Playback.repeat')}>
              <Select
                aria-label={t('Playback.repeat')}
                value={repeat}
                onChange={v => navigation({ repeat: String(v) })}
                optionList={['off', 'one', 'queue'].map(value => ({ value, label: t('Playback.' + value) }))}
              />
            </FormField>
          </>
        )}
        {group === 'audio' && (
          <>
            {track('aid', 'audio')}
            <FormField layout="row" label={t('Mpv.audioDevice')}>
              <Select
                aria-label={t('Mpv.audioDevice')}
                value={native.status['audio-device']}
                onChange={v => act('device', { device: String(v) })}
                optionList={(native.status['audio-device-list'] ?? []).map(device => ({
                  value: device.name,
                  label: device.description,
                }))}
              />
            </FormField>
          </>
        )}
        {group === 'subtitles' && (
          <>
            {track('sid', 'sub')}
            {track('secondary-sid', 'sub')}
            <FormField layout="row" label={t('Mpv.externalSubtitle')} description={t('Mpv.subtitleHelp')}>
              <FileTrigger
                acceptedFileTypes={['.srt', '.vtt', '.ass', '.ssa', '.sup']}
                onSelect={files => {
                  const file = files?.[0];
                  if (!file) return;
                  if (file.size > 5000000) {
                    notifyError(new Error(t('PlayerPage.subtitleFileIsTooLarge')));
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => act('subtitle', { name: file.name, data: String(reader.result).split(',')[1] });
                  reader.onerror = () => notifyError(reader.error);
                  reader.readAsDataURL(file);
                }}
              >
                <ActionButton>
                  <Text>{t('Mpv.loadSubtitle')}</Text>
                </ActionButton>
              </FileTrigger>
            </FormField>
          </>
        )}
        {group === 'image' && track('vid', 'video')}
        {Object.entries(nativeSettings)
          .filter(([, schema]) => schema['x-group'] === group)
          .map(([key, schema]) => {
            const value = values[key] ?? schema.default,
              label = t('Mpv.' + key);
            return (
              <FormField key={key} layout="row" label={label}>
                {schema.enum ? (
                  <Select
                    aria-label={label}
                    value={value as string | number}
                    disabled={busy}
                    onChange={v => void apply({ [key]: v as string | number })}
                    optionList={schema.enum.map((value, index) => ({
                      value,
                      label: schema['x-labels'] ? t('Mpv.' + schema['x-labels'][index]) : String(value),
                    }))}
                  />
                ) : schema.type === 'boolean' ? (
                  <Switch aria-label={label} checked={!!value} disabled={busy} onChange={v => void apply({ [key]: v })}>
                    {label}
                  </Switch>
                ) : (
                  <InputNumber
                    aria-label={label}
                    value={Number(value)}
                    min={schema.minimum}
                    max={schema.maximum}
                    step={schema['x-step'] ?? 1}
                    disabled={busy}
                    onChange={v => {
                      if (Number.isFinite(v)) void apply({ [key]: v });
                    }}
                  />
                )}
              </FormField>
            );
          })}
        {group === 'diagnostics' && (
          <dl className="description-list">
            <dt>{t('Mpv.engine')}</dt>
            <dd>{native.status['mpv-version'] || registry.nativePlayback.version}</dd>
            <dt>{t('Mpv.decoder')}</dt>
            <dd>{native.status['hwdec-current'] || t('Mpv.software')}</dd>
            <dt>{t('Mpv.frameRate')}</dt>
            <dd>{(native.status['estimated-vf-fps'] ?? 0).toFixed(3)}</dd>
            <dt>{t('Mpv.avsync')}</dt>
            <dd>{t('Mpv.milliseconds', { value: ((native.status.avsync ?? 0) * 1000).toFixed(1) })}</dd>
            <dt>{t('Mpv.dropped')}</dt>
            <dd>{native.status['frame-drop-count'] ?? 0}</dd>
            <dt>{t('Mpv.resolution')}</dt>
            <dd>
              {String(native.status['video-params']?.w ?? 0)} × {String(native.status['video-params']?.h ?? 0)}
            </dd>
            <dt>{t('Mpv.colorSpace')}</dt>
            <dd>
              {String(native.status['video-params']?.colormatrix ?? '—')} ·{' '}
              {String(native.status['video-params']?.gamma ?? '—')} ·{' '}
              {String(native.status['video-params']?.primaries ?? '—')}
            </dd>
            <dt>{t('Mpv.audioFormat')}</dt>
            <dd>
              {String(native.status['audio-params']?.samplerate ?? 0)} Hz ·{' '}
              {String(native.status['audio-params']?.channels ?? '—')}
            </dd>
          </dl>
        )}
      </FormLayout>
      {group !== 'diagnostics' && (
        <Button
          disabled={busy}
          onClick={() =>
            void apply(
              Object.fromEntries(
                Object.entries(nativeSettings)
                  .filter(([, s]) => s['x-group'] === group)
                  .map(([k, s]) => [k, s.default]),
              ),
            )
          }
        >
          {t('Playback.reset')}
        </Button>
      )}
    </div>
  );
}
