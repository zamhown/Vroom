import { isLocaleMap } from '../i18n/locale';
export type ConfigPath = (string | number)[];
export interface ConfigTreeNode {
  id: string;
  path: ConfigPath;
  parentId?: string;
  label: string;
  value: any;
  schema: any;
  branch: boolean;
  virtual: boolean;
  readOnly: boolean;
  removable: boolean;
  children: ConfigTreeNode[];
}
export interface ConfigTreeRoot {
  id: string;
  label: string;
  keys?: readonly string[];
  allowCustom?: boolean;
}
export interface ConfigTreeOptions {
  roots: ConfigTreeRoot[];
  shape(path: ConfigPath, schema: any): any;
  label(path: ConfigPath, value: any): string;
  atomic(path: ConfigPath, value: any, schema: any): boolean;
  readOnly(path: ConfigPath): boolean;
}
export interface ConfigNavigationState {
  selected?: string;
  expanded?: string[];
  search?: string;
}

// JSON-encoded typed paths keep dotted/slashed extension keys and array indices distinct.
export const configNodeId = (path: ConfigPath) => 'path:' + JSON.stringify(path);
export const isConfigObject = (value: any) => value !== null && typeof value === 'object';
/** The public text schema: a locale map (propertyNames + string values) or a shared message reference. */
export const isLocalizedSchema = (schema: any) =>
  !!schema?.oneOf?.some((branch: any) => branch?.propertyNames && branch.additionalProperties?.type === 'string');
/** Localized text has no discriminator field, so the schema decides when it is known. */
export const isLocalizedConfig = (value: any, schema?: any) => {
  if (!isConfigObject(value) || Array.isArray(value)) return false;
  if (typeof value.message === 'string') return true;
  return schema ? isLocalizedSchema(schema) && isLocaleMap(value) : isLocaleMap(value);
};

/** The tree and inspector share the same nodes and full-document paths. */
export function buildConfigTree(value: any, schema: any, options: ConfigTreeOptions): ConfigTreeNode[] {
  const build = (
    current: any,
    path: ConfigPath,
    raw: any,
    parentId?: string,
    inheritedReadOnly = false,
    removable = false,
  ): ConfigTreeNode => {
    const shape = options.shape(path, raw);
    const node: ConfigTreeNode = {
      id: configNodeId(path),
      path,
      parentId,
      label: options.label(path, current),
      value: current,
      schema: shape,
      branch: isConfigObject(current) && !options.atomic(path, current, shape),
      virtual: false,
      readOnly: inheritedReadOnly || options.readOnly(path),
      removable,
      children: [],
    };
    node.removable &&= !node.readOnly;
    if (node.branch) node.children = children(current, path, shape, node.id, node.readOnly);
    return node;
  };
  const children = (current: any, path: ConfigPath, shape: any, parentId: string, readOnly: boolean) =>
    Object.keys(current).map(key => {
      const array = Array.isArray(current);
      return build(
        current[key],
        [...path, array ? Number(key) : key],
        array ? shape.items : (shape.properties?.[key] ?? shape.additionalProperties),
        parentId,
        readOnly,
        array || !shape.required?.includes(key),
      );
    });
  return options.roots.map(root => {
    const shape = options.shape([], schema);
    const data = root.keys
      ? Object.fromEntries(root.keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
      : value;
    const rootSchema = root.keys
      ? {
          ...shape,
          properties: Object.fromEntries(root.keys.map(key => [key, shape.properties?.[key] ?? {}])),
          additionalProperties: root.allowCustom === true,
        }
      : shape;
    const branch = isConfigObject(data) && !options.atomic([], data, rootSchema);
    return {
      id: root.id,
      path: [],
      label: root.label,
      value: data,
      schema: rootSchema,
      branch,
      virtual: true,
      readOnly: false,
      removable: false,
      children: branch ? children(data, [], rootSchema, root.id, false) : [],
    };
  });
}

export function indexConfigTree(roots: ConfigTreeNode[]) {
  const index = new Map<string, ConfigTreeNode>();
  const visit = (node: ConfigTreeNode) => {
    index.set(node.id, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return index;
}

export function configNodeTrail(index: Map<string, ConfigTreeNode>, node: ConfigTreeNode): ConfigTreeNode[] {
  const trail = [node];
  while (trail[0].parentId && index.has(trail[0].parentId!)) trail.unshift(index.get(trail[0].parentId!)!);
  return trail;
}

/** A removed or JSON-renamed node falls back to its closest surviving parent. */
export function resolveConfigNode(roots: ConfigTreeNode[], selected?: string): ConfigTreeNode {
  const index = indexConfigTree(roots);
  if (selected && index.has(selected)) return index.get(selected)!;
  if (selected?.startsWith('path:')) {
    try {
      const path: ConfigPath = JSON.parse(selected.slice(5));
      if (Array.isArray(path))
        while (path.length) {
          path.pop();
          const found = index.get(configNodeId(path));
          if (found) return found;
        }
    } catch {
      /* Old or malformed workspace navigation must not block editing. */
    }
  }
  return roots[0];
}

/** Keep ancestor chains; a matching branch retains its complete subtree. */
export function filterConfigTree(roots: ConfigTreeNode[], query: string): ConfigTreeNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return roots;
  return roots.flatMap(node => {
    if ((node.label + ' ' + String(node.path.at(-1) ?? '')).toLocaleLowerCase().includes(needle)) return [node];
    const children = filterConfigTree(node.children, query);
    return children.length ? [{ ...node, children }] : [];
  });
}
