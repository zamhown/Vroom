import { describe, expect, it } from 'vitest';
import { editConfigPath } from './config-editor';
import {
  buildConfigTree,
  configNodeId,
  configNodeTrail,
  filterConfigTree,
  indexConfigTree,
  isLocalizedConfig,
  resolveConfigNode,
  type ConfigTreeOptions,
} from './config-tree';

const options: ConfigTreeOptions = {
  roots: [{ id: 'settings', label: 'Settings' }],
  shape: (_path, schema) => schema ?? {},
  label: path => String(path.at(-1) ?? 'Settings'),
  atomic: (_path, value) => isLocalizedConfig(value),
  readOnly: path => path[0] === 'compatibility',
};

describe('configuration hierarchy navigation', () => {
  it('retains every ancestor in deeply nested extensions and edits the selected full path only', () => {
    const document = {
      extension: { source: { mapping: { output: { format: { precision: 3, unknown: 9 } } } } },
      untouched: [1, 2],
    };
    const path = ['extension', 'source', 'mapping', 'output', 'format', 'precision'];
    const roots = buildConfigTree(document, {}, options),
      index = indexConfigTree(roots);
    const selected = resolveConfigNode(roots, configNodeId(path));
    expect(configNodeTrail(index, selected).map(node => node.label)).toEqual(['Settings', ...path]);
    expect(editConfigPath(document, selected.path, 5)).toEqual({
      extension: { source: { mapping: { output: { format: { precision: 5, unknown: 9 } } } } },
      untouched: [1, 2],
    });
    expect(document.extension.source.mapping.output.format.precision).toBe(3);
  });
  it('keeps punctuation and numeric object keys distinct from list indices', () => {
    const roots = buildConfigTree({ 'a/b': { '0': 7 }, a: { b: [8] }, 'a.b': 9 }, {}, options);
    const index = indexConfigTree(roots);
    expect(index.get(configNodeId(['a/b', '0']))?.value).toBe(7);
    expect(index.get(configNodeId(['a', 'b', 0]))?.value).toBe(8);
    expect(index.get(configNodeId(['a.b']))?.value).toBe(9);
    expect(index.size).toBe(7);
  });
  it('search reveals the full ancestor chain and hides unrelated branches', () => {
    const roots = buildConfigTree(
      { input: { props: { precision: 3, unit: 'pt' } }, display: { format: 'short' } },
      {},
      options,
    );
    const filtered = filterConfigTree(roots, 'PRECISION'),
      index = indexConfigTree(filtered);
    expect([...index.values()].map(node => node.label)).toEqual(['Settings', 'input', 'props', 'precision']);
    expect(filterConfigTree(roots, 'missing')).toEqual([]);
    expect(indexConfigTree(filterConfigTree(roots, 'props')).has(configNodeId(['input', 'props', 'unit']))).toBe(true);
  });
  it('treats translations as one field while keeping list entries as separate nested nodes', () => {
    const roots = buildConfigTree(
      {
        label: { fr: 'Texte', en: 'Text' },
        placements: [{ id: 'one', settings: { size: 4 } }],
      },
      {},
      options,
    );
    const index = indexConfigTree(roots);
    expect(index.get(configNodeId(['label']))?.branch).toBe(false);
    expect(index.has(configNodeId(['label', 'values']))).toBe(false);
    expect(index.get(configNodeId(['placements', 0, 'settings', 'size']))?.value).toBe(4);
  });
  it('falls back to the surviving parent when a selected node disappears in JSON mode', () => {
    const roots = buildConfigTree({ input: { props: {} } }, {}, options);
    expect(resolveConfigNode(roots, configNodeId(['input', 'props', 'removed'])).path).toEqual(['input', 'props']);
    expect(resolveConfigNode(roots, 'path:broken').id).toBe('settings');
  });
  it('propagates read-only constraints to descendants and respects required properties', () => {
    const roots = buildConfigTree(
      { compatibility: { transform: { factor: 2 } }, required: 'keep', optional: 'remove' },
      { required: ['required'] },
      options,
    );
    const index = indexConfigTree(roots);
    expect(index.get(configNodeId(['compatibility', 'transform', 'factor']))).toMatchObject({
      readOnly: true,
      removable: false,
    });
    expect(index.get(configNodeId(['required']))?.removable).toBe(false);
    expect(index.get(configNodeId(['optional']))?.removable).toBe(true);
  });
  it('virtual categories never change the JSON paths and allow empty containers to be populated', () => {
    const roots = buildConfigTree(
      { input: { props: {} }, extension: { later: [] } },
      {},
      {
        ...options,
        roots: [
          { id: 'entry', label: 'Entry', keys: ['input'] },
          { id: 'more', label: 'More', keys: ['extension'], allowCustom: true },
        ],
      },
    );
    const index = indexConfigTree(roots),
      selected = index.get(configNodeId(['input', 'props']))!;
    expect(configNodeTrail(index, selected).map(node => node.id)).toEqual([
      'entry',
      configNodeId(['input']),
      configNodeId(['input', 'props']),
    ]);
    expect(selected).toMatchObject({ branch: true, children: [], path: ['input', 'props'] });
    expect(editConfigPath({ input: { props: {} } }, selected.path.concat('future'), true)).toEqual({
      input: { props: { future: true } },
    });
  });
});
