import type { Job } from '../types';
import type { Candidate, LocalizedText, TagPackage } from '../tagging/types';
import type { TabKind } from '../workspace';

export interface ActivityCursor {
  id: string;
  updated: string;
}
export type ActivityItem = ActivityCursor & { attention: boolean } & (
    { kind: 'job'; data: Job } | { kind: 'candidate'; data: Candidate; subjectLabel: LocalizedText | string }
  );
export interface ActivityPage {
  items: ActivityItem[];
  total: number;
  attention: number;
  next: ActivityCursor | null;
}
export interface ActivityConfig {
  tabs: TabKind[];
  sources: ('jobs' | 'candidates')[];
}
export function activityLayout(pack: TagPackage, kind: TabKind) {
  const layout = pack.ui.layouts[pack.ui.surfaceBindings['workspace.sidebar']];
  if (layout?.surface !== 'workspace.sidebar' || layout.root.type !== 'activity-feed') return;
  const config = layout.root.activity as ActivityConfig;
  return config?.tabs.includes(kind) ? { config, title: layout.root.title } : undefined;
}
