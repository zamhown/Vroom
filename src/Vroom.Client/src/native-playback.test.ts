import { describe, expect, it } from 'vitest';
import registry from '../../../resources/tagging/playback-capabilities.json';
import { bundledPacks } from './i18n';

describe('native playback public presentation', () => {
  it('localizes every registered control, group and choice in every bundled language', () => {
    const keys = new Set(registry.nativePlayback.groups);
    for (const [key, schema] of Object.entries(registry.nativePlayback.settings.properties)) {
      keys.add(key);
      if ('x-labels' in schema) for (const label of schema['x-labels']) keys.add(label);
      expect(registry.nativePlayback.groups).toContain(schema['x-group']);
    }
    for (const pack of bundledPacks)
      for (const key of keys) expect(pack.messages['Mpv.' + key], pack.locale + ': ' + key).toBeTruthy();
  });
});
