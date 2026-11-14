import registry from '../../../../resources/tagging/host-capabilities.json';
import { argumentType, expressionType } from './expression-editing';
import type { TagPackage } from './types';

/** A draft starts with a field choice; it must never silently mean “always”. */
export const emptyCondition = () => ({ op: 'exists', args: [{ fact: '' }] });
export const conditionFacts = (event?: string): Record<string, any> => ({
  ...registry.facts,
  ...Object.fromEntries(Object.entries(registry.eventFacts).filter(([, fact]) => event && fact.events.includes(event))),
});

export function conditionReady(value: any, catalog: TagPackage, event?: string): boolean {
  const facts = conditionFacts(event);
  const valid = (node: any, depth = 0): boolean => {
    if (!node || depth > 24) return false;
    if (Object.hasOwn(node, 'literal')) return true;
    if (Object.hasOwn(node, 'fact')) return !!facts[node.fact];
    if (Object.hasOwn(node, 'tag')) return catalog.definitions.some(d => d.key === node.tag);
    const operation = (registry.operations as Record<string, any>)[node.op];
    return (
      !!operation &&
      Array.isArray(node.args) &&
      node.args.length >= operation.minArgs &&
      node.args.length <= operation.maxArgs &&
      (node.op !== 'case' || node.args.length % 2 === 1) &&
      node.args.every(
        (arg: any, index: number) =>
          valid(arg, depth + 1) &&
          (argumentType(node.op, index, node, catalog) !== 'boolean' || expressionType(arg, catalog) === 'boolean'),
      )
    );
  };
  return value === undefined || (valid(value) && expressionType(value, catalog) === 'boolean');
}
