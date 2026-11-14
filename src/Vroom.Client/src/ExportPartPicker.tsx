import { useEffect, useState } from 'react';
import { Select } from './ui';
import { FormField } from './components/FormLayout';
import { call } from './api';
import { notifyError } from './context';
import { t } from './i18n';
import type { MediaStructure } from './MediaResources';
import type { ExportSource } from './media-export';
export function ExportPartPicker({
  source,
  disabled,
  change,
}: {
  source: ExportSource;
  disabled: boolean;
  change(part: { id: string; path: string }): void;
}) {
  const [data, setData] = useState<MediaStructure>();
  useEffect(() => {
    let cancelled = false;
    void call<MediaStructure>('media.resources.get', { filmId: source.filmId })
      .then(value => {
        if (!cancelled) setData(value);
      })
      .catch(notifyError);
    return () => {
      cancelled = true;
    };
  }, [source.filmId]);
  if (!data) return null;
  return (
    <FormField label={t('MediaResources.playPart')}>
      <Select
        disabled={disabled}
        value={source.partId ?? data.selectedPartId}
        onChange={value => {
          const part = data.versions.flatMap(v => v.parts).find(p => p.id === value);
          if (part) change({ id: part.id, path: part.file.path });
        }}
        optionList={data.versions.flatMap(v =>
          v.parts.map((p, i) => ({
            value: p.id,
            label: (v.name || t('MediaResources.defaultVersion')) + ' · ' + t('MediaResources.part', { number: i + 1 }),
          })),
        )}
      />
    </FormField>
  );
}
