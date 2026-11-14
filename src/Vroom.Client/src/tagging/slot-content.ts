import type { Json } from './types';

/** Compact summaries omit absent data, but keep real false/zero values and actions. */
export function hasSlotContent(value: Json | undefined, editable = false, emptyText = ''): boolean {
  if (editable || emptyText.trim()) return true;
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
