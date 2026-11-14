import { formatBytes, t as appText } from './i18n';
import type { AnnotationRecord, Candidate, Json, TagSnapshot } from './tagging/types';
export interface Library {
  id: string;
  name: string;
  roots: string[];
  excludes: string[];
  autoEnrich: boolean;
  probeOnScan: boolean;
}
export interface Film {
  id: string;
  fileId?: string;
  versionId?: string;
  partId?: string;
  structureRevision?: number;
  libraryId: string;
  path: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec?: string;
  audioCodec?: string;
  position: number;
  mediaRevision: string;
  missingSince?: string | null;
  /** Present in grouped query results: the JSON tuple of the film's group. */
  groupKey?: string;
  presentation: {
    title: string;
    tabTitle: string;
    image?: string;
    frameAt?: number;
    snapshotName: string;
    /** Pixel size of the primary image, when the host could read it. */
    imageSize?: { width: number; height: number };
    /** A host-capabilities imagePresentations entry with its parameter defaults filled in. */
    imagePresentation?: ImagePresentation | null;
  };
  values: Record<string, AnnotationRecord>;
  facts: Record<string, Json>;
}
export interface ImagePresentation {
  component: string;
  props: Record<string, Json>;
}
export interface QueryOrderField {
  tag: string;
  direction?: 'asc' | 'desc';
  mode?: 'value' | 'label' | 'min' | 'max';
  nulls?: 'first' | 'last';
}
export interface QueryGroupField {
  tag: string;
  mode?: 'value' | 'member' | 'facet';
  facet?: string;
}
export interface Query {
  libraryId?: string;
  where?: import('./query').Predicate | null;
  search?: string;
  orderBy?: QueryOrderField[];
  groupBy?: QueryGroupField[];
  locale?: string;
  offset: number;
  limit: number;
  ignoreDefaultQuery?: boolean;
  scope?: 'continue-watching' | 'recently-played' | 'recently-added';
}
export interface QueryResult {
  films: Film[];
  total: number;
  groups: Record<string, number>;
}
export interface View {
  id: string;
  name: string;
  query: Query;
}
export interface FilmDetail {
  film: Film;
  annotations: AnnotationRecord[];
  candidates: Candidate[];
  generation: number;
}
export interface NetworkOptions {
  mode: 'system' | 'direct' | 'custom';
  proxyUrl: string;
  retryOnReconnect: boolean;
}
export interface Settings {
  externalPlayerPaths: Record<string, string>;
  network: NetworkOptions;
  sourceBrowserPath: string;
  mpvPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  handBrakePath: string;
  modelPath: string;
  onlineMetadata: boolean;
  scanIntervalMinutes: number;
  scanOnStartup: boolean;
  transcodeHeight: number;
}
export interface Job {
  origin?: { tabId: string; title: string };
  /** The task that started this one. */
  parentId?: string | null;
  id: string;
  name: string;
  kind: string;
  state: JobState;
  completed: number;
  total?: number;
  detail: string;
  started: string;
  updated: string;
  finished?: string;
  error?: string;
  canPause: boolean;
  canStop: boolean;
  canRetry: boolean;
  attempt: number;
  resultJson?: string;
  payload: string;
}
export interface JobPage {
  items: Job[];
  total: number;
  active: number;
  paused: number;
  failed: number;
}
export interface SchedulerPolicy {
  maxWorkers: number;
  maxEncoders: number;
  paused: boolean;
}
export interface Job {
  nameArgs?: Record<string, string | number>;
  detailArgs?: Record<string, string | number>;
  errorArgs?: Record<string, string | number>;
  workerClass: string;
  priority: number;
  notBefore?: string;
  executionStarted?: string;
  telemetry?: {
    phase: string;
    framesPerSecond?: number;
    averageFramesPerSecond?: number;
    etaSeconds?: number;
    pass?: number;
    passCount?: number;
  };
}
export interface ToolDefinition {
  name: string;
  description: string | import('./tagging/types').LocalizedText;
  arguments: string;
  mutates: boolean;
}
export interface Bootstrap {
  apiVersion: number;
  libraries: Library[];
  tagging: TagSnapshot;
  views: View[];
  settings: Settings;
  mediaBase: string;
  jobs: JobPage;
  totalFilms: number;
  tools: ToolDefinition[];
  version: string;
  dataDirectory: string;
  platform: 'windows' | 'macos' | 'linux';
}
export interface PlaybackSource {
  url: string;
  transcoded: boolean;
  offset: number;
  sessionId?: string;
  jobId?: string;
  pipeline: string;
  description: string;
  startupMs: number;
}
export interface DuplicateSet {
  key: string;
  films: Film[];
}
export interface AgentPlan {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  needsReview: boolean;
  preview?: unknown;
  description: ToolDefinition['description'];
}
export type JobState =
  'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'pausing' | 'paused' | 'interrupted';
const jobStateMessages: Record<JobState, string> = {
  queued: 'types.queued',
  running: 'types.running',
  cancelling: 'types.stopping',
  completed: 'types.completed',
  cancelled: 'types.stopped',
  failed: 'types.failed',
  pausing: 'types.pausing',
  paused: 'types.paused',
  interrupted: 'types.interrupted',
};
export const jobStateLabel = (state: JobState) => appText(jobStateMessages[state] ?? 'types.queued');
export const terminal = (state: JobState) =>
  state === 'completed' || state === 'cancelled' || state === 'failed' || state === 'interrupted';
export const timecode = (value: number, precise = false) => {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds) % 60];
  return (
    parts.map(n => String(n).padStart(2, '0')).join(':') +
    (precise ? '.' + String(Math.floor((seconds % 1) * 1000)).padStart(3, '0') : '')
  );
};
export const sizeLabel = (bytes: number) => formatBytes(bytes);
export const defaultQuery = (): Query => ({ orderBy: [], groupBy: [], offset: 0, limit: 30 });
