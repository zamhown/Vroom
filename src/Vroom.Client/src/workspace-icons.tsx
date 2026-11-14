import type { ComponentType } from 'react';
import { workspaceGroupKind, type TabKind, type WorkspaceGroupKind, type WorkspaceTab } from './workspace';
import { SchemaIcon } from './tagging/Inputs';
import {
  IconLightbulb,
  IconBookmark,
  IconCollection,
  IconCopy,
  IconEdit,
  IconFilter,
  IconFolder,
  IconInfo,
  IconList,
  IconPlay,
  IconSetting,
  IconTag,
  IconTasks,
  IconVideo,
} from './icons';

type IconTab = Pick<WorkspaceTab, 'id' | 'kind' | 'params'>;

// Groups identify objects. Tabs identify actions, independent of their source.
// Keep these sets disjoint so a group's caption never repeats a member's icon.
const groupIcons: Record<WorkspaceGroupKind, ComponentType> = {
  film: IconVideo,
  library: IconFolder,
  view: IconFilter,
};
const pageIcons: Record<TabKind, ComponentType> = {
  library: IconList,
  libraries: IconCollection,
  film: IconInfo,
  player: IconPlay,
  tags: IconTag,
  duplicates: IconCopy,
  views: IconBookmark,
  jobs: IconTasks,
  settings: IconSetting,
  agent: IconLightbulb,
  export: IconVideo,
};
export function WorkspaceIcon({ tab }: { tab: IconTab }) {
  let Icon = pageIcons[tab.kind];
  if ((tab.kind === 'libraries' && tab.id !== 'libraries') || (tab.kind === 'views' && tab.id !== 'views'))
    Icon = IconEdit;
  if (tab.kind === 'library' && (tab.params as any)?.icon) return <SchemaIcon name={(tab.params as any).icon} />;
  return <Icon />;
}

// Named objects in the sidebar match group captions; page shortcuts match tabs.
export function WorkspaceNavigationIcon({ tab }: { tab: IconTab }) {
  const kind = workspaceGroupKind(tab.id);
  const Icon = kind && groupIcons[kind];
  return Icon ? <Icon /> : <WorkspaceIcon tab={tab} />;
}

export function WorkspaceGroupIcon({ sourceKey }: { sourceKey: string }) {
  const kind = workspaceGroupKind(sourceKey);
  const Icon = kind && groupIcons[kind];
  return Icon ? <Icon /> : null;
}
