import Calendar from '@react-spectrum/s2/icons/Calendar';
import Heart from '@react-spectrum/s2/icons/Heart';
import HeartFilled from '@react-spectrum/s2/icons/HeartFilled';
import Image from '@react-spectrum/s2/icons/Image';
import Text from '@react-spectrum/s2/icons/Text';
import TextAlignLeft from '@react-spectrum/s2/icons/TextAlignLeft';
import TextNumbers from '@react-spectrum/s2/icons/TextNumbers';
import Toggle from '@react-spectrum/s2/icons/Toggle';
import type { ComponentType } from 'react';
import registry from '../../../resources/tagging/host-capabilities.json';
import * as Icons from './icons';

/** Stable schema names resolve here for both the picker and every rendered surface. */
export const schemaIcons = {
  Star: Icons.IconStarStroked,
  StarFilled: Icons.IconStar,
  Heart,
  HeartFilled,
  Clock: Icons.IconClock,
  Tag: Icons.IconTag,
  Folder: Icons.IconFolder,
  Play: Icons.IconPlay,
  Info: Icons.IconInfo,
  Save: Icons.IconSave,
  Close: Icons.IconClose,
  Undo: Icons.IconUndo,
  Redo: Icons.IconRedo,
  Bookmark: Icons.IconBookmark,
  Video: Icons.IconVideo,
  Camera: Icons.IconCamera,
  Collection: Icons.IconCollection,
  Filter: Icons.IconFilter,
  List: Icons.IconList,
  Grid: Icons.IconGridView,
  Checkmark: Icons.IconCheck,
  Edit: Icons.IconEdit,
  Settings: Icons.IconSetting,
  Search: Icons.IconSearch,
  Refresh: Icons.IconRefresh,
  Translate: Icons.IconTranslate,
  TimePoint: Icons.IconTimePoint,
  TimeRange: Icons.IconTimeRange,
  Text,
  TextAlignLeft,
  Number: TextNumbers,
  Slider: Icons.IconSlider,
  Toggle,
  Image,
  Calendar,
  // The type check guarantees exactly one renderer for every registered icon name.
} satisfies Record<keyof typeof registry.icons, ComponentType<{ slot?: string }>>;
/** The only schema icon renderer; names are validated against host-capabilities.icons at publication. */
export function SchemaIcon({ name, slot }: { name?: string; slot?: string }) {
  const Icon = schemaIcons[name as keyof typeof schemaIcons] ?? Icons.IconTag;
  return <Icon slot={slot} />;
}
