import type { LocalizedText } from './tagging/types';
export interface EncodingOption {
  key: string;
  group: string;
  arity: 'none' | 'optional' | 'required';
  valueType: string;
  choices: string[];
  label: LocalizedText;
  help: LocalizedText;
}
export interface EngineCapabilities {
  executable: string;
  version: string;
  fingerprint: string;
  options: EncodingOption[];
  presets: { name: string; category: string }[];
}
export interface ExportSource {
  key: string;
  name: string;
  path: string;
  filmId?: string;
  partId?: string;
  sourcePath?: string;
}
export interface ExportPreview {
  schedule?: { priority: number; notBefore?: string | null };
  previewToken: string;
  executable: string;
  engineFingerprint: string;
  preset: Record<string, any>;
  options: Record<string, string | null>;
  targets: { jobId: string; name: string; source: { path: string; bytes: number }; outputPath: string }[];
}
export interface PresetSummaryField {
  id: string;
  label: LocalizedText;
  paths: string[];
  separator?: string;
  values?: Record<string, LocalizedText | undefined>;
  when?: { path: string; value: unknown };
}
/** Resolve the public summary against the engine's effective preset, including nested track lists. */
export function presetSummary(
  preset: Record<string, any>,
  fields: PresetSummaryField[],
  localize: (text: LocalizedText) => string,
  empty: string,
) {
  const read = (path: string): unknown[] =>
    path
      .split('.')
      .reduce<unknown[]>(
        (values, key) =>
          values.flatMap(value =>
            key === '*'
              ? Array.isArray(value)
                ? value
                : []
              : value && typeof value === 'object'
                ? [(value as Record<string, unknown>)[key]]
                : [],
          ),
        [preset],
      );
  return fields
    .filter(field => !field.when || read(field.when.path)[0] === field.when.value)
    .map(field => ({
      id: field.id,
      label: localize(field.label),
      value: field.paths
        .map(
          path =>
            read(path)
              .filter(value => value !== undefined && value !== null && value !== '')
              .map(value => (field.values?.[String(value)] ? localize(field.values[String(value)]!) : String(value)))
              .join(', ') || empty,
        )
        .join(field.separator ?? ' · '),
    }));
}
export function matchingExportProfile(
  profiles: { id: string; preset: string; options: Record<string, string | null> }[],
  preset: string,
  userPreset: string,
  options: Record<string, string | null>,
) {
  return userPreset
    ? undefined
    : profiles.find(
        profile =>
          profile.preset === preset &&
          Object.keys(profile.options).length === Object.keys(options).length &&
          Object.entries(profile.options).every(([key, value]) => options[key] === value),
      )?.id;
}
export function updateEncodingOption(
  options: Record<string, string | null>,
  key: string,
  value: string | null | undefined,
) {
  const next = { ...options };
  if (value === undefined) delete next[key];
  else {
    next[key] = value;
    delete next[key.startsWith('no-') ? key.slice(3) : 'no-' + key];
    for (const exclusive of [
      ['vfr', 'cfr', 'pfr'],
      ['quality', 'vb'],
      ['all-audio', 'first-audio', 'audio'],
      ['all-subtitles', 'first-subtitle', 'subtitle'],
    ])
      if (exclusive.includes(key)) for (const other of exclusive) if (other !== key) delete next[other];
  }
  return next;
}
export function exportDestination(directory: string, source: string, suffix: string, format: string) {
  const file =
    source
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || '';
  const stem = file.replace(/\.[^.]+$/, '');
  const extension: Record<string, string> = { av_mp4: 'mp4', av_mov: 'mov', av_mkv: 'mkv', av_webm: 'webm' };
  if (!extension[format] || !directory.trim() || /[\\/:*?"<>|]/.test(suffix)) return '';
  return (
    directory.replace(/[\\/]+$/, '') + (directory.includes('\\') ? '\\' : '/') + stem + suffix + '.' + extension[format]
  );
}
export function presetNames(document: Record<string, any>): string[] {
  const walk = (items: any[], depth = 0): string[] =>
    depth > 12
      ? []
      : items.flatMap(item =>
          item.Folder
            ? walk(item.ChildrenArray ?? [], depth + 1)
            : typeof item.PresetName === 'string'
              ? [item.PresetName]
              : [],
        );
  return walk(document.PresetList ?? []);
}
