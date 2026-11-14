import { describe, expect, it } from 'vitest';
import {
  exportDestination,
  presetNames,
  presetSummary,
  matchingExportProfile,
  updateEncodingOption,
} from './media-export';
import contract from '../../../resources/tagging/media-export.json';
import { initialWorkspace, validateWorkspace, workspaceReducer } from './workspace';
describe('export controls', () => {
  it('only highlights a plan when the base preset and every override match', () => {
    const profiles = [
      { id: 'unfamiliar-plan', preset: 'Unfamiliar base', options: { 'future-flag': null, quality: '17' } },
    ];
    expect(matchingExportProfile(profiles, 'Unfamiliar base', '', { quality: '17', 'future-flag': null })).toBe(
      'unfamiliar-plan',
    );
    expect(matchingExportProfile(profiles, 'Other base', '', profiles[0].options)).toBeUndefined();
    expect(matchingExportProfile(profiles, 'Unfamiliar base', 'Imported', profiles[0].options)).toBeUndefined();
    expect(
      matchingExportProfile(profiles, 'Unfamiliar base', '', { ...profiles[0].options, quality: '18' }),
    ).toBeUndefined();
    expect(
      matchingExportProfile(profiles, 'Unfamiliar base', '', { ...profiles[0].options, cfr: null }),
    ).toBeUndefined();
  });
  it('renders resource-defined settings, modes, unknown codecs and zero values from effective engine data', () => {
    const text = (value: string) => ({ en: value });
    const fields = [
      { id: 'quality', label: text('Quality'), paths: ['detail.quality'], when: { path: 'mode', value: 2 } },
      { id: 'bitrate', label: text('Bitrate'), paths: ['detail.bitrate'], when: { path: 'mode', value: 1 } },
      { id: 'tracks', label: text('Tracks'), paths: ['tracks.*.codec'] },
      { id: 'limit', label: text('Limit'), paths: ['limit'], values: { '0': text('Unrestricted') } },
      { id: 'missing', label: text('Missing'), paths: ['unknown'] },
    ];
    const rows = presetSummary(
      { mode: 1, detail: { quality: 20, bitrate: 0 }, tracks: [{ codec: 'alien' }, { codec: 'future' }], limit: 0 },
      fields,
      t => (typeof t === 'object' && t && 'en' in t ? String(t.en) : ''),
      'Unset',
    );
    expect(rows).toEqual([
      { id: 'bitrate', label: 'Bitrate', value: '0' },
      { id: 'tracks', label: 'Tracks', value: 'alien, future' },
      { id: 'limit', label: 'Limit', value: 'Unrestricted' },
      { id: 'missing', label: 'Missing', value: 'Unset' },
    ]);
  });
  it('restores export drafts and active tab after application restart', () => {
    const tab = {
      id: 'export:source',
      kind: 'export' as const,
      title: 'Export',
      dirty: true,
      state: {
        sources: [{ filmId: 'source' }],
        options: { 'future-codec': 'value' },
        directory: 'D:/exports',
        notBefore: '2030-01-01T12:00',
      },
    };
    const workspace = workspaceReducer(initialWorkspace(), { type: 'open', tab });
    const restored = validateWorkspace(JSON.parse(JSON.stringify(workspace)));
    expect(restored.activeId).toBe('export');
    expect(restored.tabs.find(t => t.id === 'export')).toMatchObject({ ...tab, id: 'export' });
  });
  it('retains unfamiliar engine settings and distinguishes inherited values from no-value overrides', () => {
    const first = updateEncodingOption({ 'future-encoder-mode': 'alien', cfr: null }, 'vfr', null);
    expect(first).toEqual({ 'future-encoder-mode': 'alien', vfr: null });
    expect(updateEncodingOption(first, 'vfr', undefined)).toEqual({ 'future-encoder-mode': 'alien' });
    expect(updateEncodingOption({ quality: '20' }, 'vb', '1800')).toEqual({ vb: '1800' });
    expect(updateEncodingOption({ optimize: null }, 'no-optimize', null)).toEqual({ 'no-optimize': null });
  });
  it('builds explicit filenames for Windows, UNC and POSIX sources', () => {
    expect(exportDestination('D:\\out', 'C:\\视频\\a.b.mp4', '-mobile', 'av_mkv')).toBe('D:\\out\\a.b-mobile.mkv');
    expect(exportDestination('\\\\nas\\out', '/media/a.mov', '', 'av_webm')).toBe('\\\\nas\\out\\a.webm');
    expect(exportDestination('/exports', '/media/a.mp4', '-new', 'av_mov')).toBe('/exports/a-new.mov');
    expect(exportDestination('/exports', '/media/a.mp4', '/../bad', 'av_mp4')).toBe('');
  });
  it('supports nested native preset folders and uses localized public surface nodes', () => {
    expect(
      presetNames({ PresetList: [{ Folder: true, ChildrenArray: [{ PresetName: 'Unfamiliar codec profile' }] }] }),
    ).toEqual(['Unfamiliar codec profile']);
    expect(contract.layout.map(n => n.component)).toContain('handbrake-options@1');
    expect(Object.values(contract.copy).every(text => text.en && text['zh-CN'])).toBe(true);
  });
});
