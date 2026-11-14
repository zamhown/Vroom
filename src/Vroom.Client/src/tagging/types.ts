export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
/** Localized text: locale tag to text, or a reference to a shared message. */
export type LocalizedLiteral = Record<string, string>;
export interface MessageReference {
  message: string;
  args?: Record<string, { from?: string; literal?: Json }>;
}
export type LocalizedText = LocalizedLiteral | MessageReference;
export const isMessageReference = (text: LocalizedText | undefined): text is MessageReference =>
  !!text && typeof (text as MessageReference).message === 'string';
export interface ComponentSpec {
  component: string;
  props?: Record<string, any>;
  compact?: Record<string, any>;
}
export interface DisplaySpec extends ComponentSpec {
  label?: LocalizedText;
}
export interface Placement {
  id: string;
  slot: string;
  view: string;
  mode: 'edit' | 'display' | 'navigate';
}
export interface Definition {
  key: string;
  revision: number;
  enabled: boolean;
  label: LocalizedText;
  description?: LocalizedText;
  parents: string[];
  group?: string;
  subjectVocabularies?: string[];
  targets: string[];
  value: {
    cardinality: 'one' | 'many';
    schema: Record<string, any>;
    semanticVersion: number;
    unit?: string;
    /** Collection of an enumerable field; values are stable term references into it. */
    vocabulary?: string;
    default?: Json;
  };
  input: ComponentSpec;
  display?: Record<string, DisplaySpec>;
  placements: Placement[];
  query?: { filter?: boolean; sort?: boolean; groupBy?: string[]; deduplicate?: boolean };
  facets?: Record<string, any>;
  navigation?: any;
  writes?: {
    manual?: boolean;
    manualClearBlocksAutomatic?: boolean;
    sourcePriority?: string[];
    /** Present when writers may create new terms in the field's collection. */
    createTerms?: { namespace?: string };
  };
  initialization?: any[];
  automation?: any[];
  enrichment?: any[];
  enrichmentPolicy?: { minIndependentSources?: number };
}
export interface Scope {
  partId?: string;
  kind: 'whole' | 'point' | 'interval';
  scopeId?: string;
  startUs?: string;
  endUs?: string;
  mediaRevision?: string;
}
export interface AnnotationRecord {
  id: string;
  revision: number;
  subject: { kind: 'film' | 'term'; id: string };
  scope: Scope;
  tagKey: string;
  value: Json;
  note?: string;
  operation: 'set' | 'clear';
  status: string;
  canWrite: boolean;
  origin: { kind: string };
  provenance?: { source?: string; evidence?: SourceEvidence[] };
  editPolicy?: { locked?: boolean };
}
export interface LayoutNode {
  id: string;
  type: string;
  title?: LocalizedText;
  children?: LayoutNode[];
  region?: string | string[];
  actions?: string[];
  actionsPlacement?: 'below' | 'inline-end';
  [key: string]: any;
}
export interface Term {
  id: string;
  revision: number;
  enabled: boolean;
  label: LocalizedText;
  description?: LocalizedText;
  aliases?: string[];
  vocabularyIds: string[];
}
export interface TagPackage {
  terms?: Term[];
  vocabularies?: Record<
    string,
    { label: LocalizedText; description?: LocalizedText; enabled?: boolean; items: Term[] }
  >;
  groups?: Record<string, { label: LocalizedText; description?: LocalizedText }>;
  definitions: Definition[];
  ui: {
    layouts: Record<string, { surface: string; root: LayoutNode; title?: LocalizedText }>;
    surfaceBindings: Record<string, string>;
    actions: Record<string, any>;
    identity: Record<string, any>;
    agentHints: Record<string, any>;
    /** Member order per region (definition keys); unlisted members follow in key order. */
    placementOrder?: Record<string, string[]>;
    [key: string]: any;
  };
  catalogPolicy: any;
  i18n: {
    defaultLocale: string;
    messages: Record<string, { params?: Record<string, string>; values: Record<string, string> }>;
  };
  [key: string]: any;
}
export interface TagSnapshot {
  generation: number;
  package: TagPackage;
  issueCount: number;
  warning?: { code: string; cause: string; path?: string } | null;
  cursor: number;
}
export interface SourceEvidence {
  source: string;
  group: string;
  location: string;
  observedAt: string;
  value: Json;
}
export interface Candidate {
  subjectKind?: 'film' | 'term';
  evidence?: SourceEvidence[];
  entities?: { namespace: string };
  id: string;
  subjectId: string;
  tagKey: string;
  value: Json;
  createOptions: boolean;
  source: string;
}
export const whole: Scope = { kind: 'whole' };
export const scopeKey = (scope: Scope) => (scope.kind === 'whole' ? 'whole' : scope.scopeId!);
