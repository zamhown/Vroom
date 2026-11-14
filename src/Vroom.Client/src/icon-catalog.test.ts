import { describe, expect, it } from 'vitest';
import registry from '../../../resources/tagging/host-capabilities.json';
import core from '../../../resources/tagging/core.tagdefs.json';

const used = (node: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) node.forEach(item => used(item, found));
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node))
      if (key === 'icon' && typeof value === 'string') found.add(value);
      else used(value, found);
  return found;
};

// icon-catalog.tsx is type-checked against registry.icons; this test covers the public resources.
describe('icon registry', () => {
  it('only references registered icons from public resources', () => {
    const known = new Set(Object.keys(registry.icons));
    expect([...used(registry), ...used(core)].filter(name => !known.has(name))).toEqual([]);
  });
});
