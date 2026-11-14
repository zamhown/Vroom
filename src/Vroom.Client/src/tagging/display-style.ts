import { translate } from '../i18n';
import { localize } from './i18n';
import type { Definition, TagPackage } from './types';

export function displayStyleLabel(definition: Definition, key: string, locale: string, catalog: TagPackage): string {
  return (
    localize(definition.display?.[key]?.label, locale, catalog) ||
    translate(key === 'default' ? 'DefinitionDesigner.defaultDisplay' : 'DisplayStyle.unnamed', locale, {
      number: Object.keys(definition.display ?? {}).indexOf(key) + 1,
    })
  );
}
export const displayStylePositions = (definition: Definition, key: string) =>
  definition.placements.filter(p => p.view === 'display.' + key);
