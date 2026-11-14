export type EngineChoice = { preference: string; native: boolean };
// Capability refreshes update the chooser, but only an explicit engine selection may
// replace an already mounted player. Runtime path edits apply to subsequent opens.
export function playbackEngine(
  current: EngineChoice | undefined,
  preference: string,
  capabilities: { available: boolean; embedded: boolean },
): EngineChoice {
  if (current?.preference === preference) return current;
  return {
    preference,
    native: preference === 'mpv' || (preference === 'auto' && capabilities.available && capabilities.embedded),
  };
}
