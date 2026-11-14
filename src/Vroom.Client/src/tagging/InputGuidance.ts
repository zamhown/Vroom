import type { Definition, LocalizedText } from './types';
import { editorGuidance } from './config-editor';

/** Input behavior is explained by component contract, never by a business tag. */
export function inputGuidance(definition: Definition): LocalizedText | undefined {
  return (editorGuidance.components as Record<string, LocalizedText>)[definition.input.component];
}
