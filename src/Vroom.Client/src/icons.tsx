import type { ComponentType } from 'react';
import { createIcon, type IconProps } from '@react-spectrum/s2';
import Translate from '@react-spectrum/s2/icons/Translate';
import Add from '@react-spectrum/s2/icons/Add';
import Camera from '@react-spectrum/s2/icons/Camera';
import ChevronUp from '@react-spectrum/s2/icons/ChevronUp';
import ChevronDown from '@react-spectrum/s2/icons/ChevronDown';
import Checkmark from '@react-spectrum/s2/icons/Checkmark';
import ChevronLeft from '@react-spectrum/s2/icons/ChevronLeft';
import ChevronRight from '@react-spectrum/s2/icons/ChevronRight';
import Copy from '@react-spectrum/s2/icons/Copy';
import Delete from '@react-spectrum/s2/icons/Delete';
import Folder from '@react-spectrum/s2/icons/Folder';
import Grid from '@react-spectrum/s2/icons/ViewGrid';
import List from '@react-spectrum/s2/icons/ViewList';
import Play from '@react-spectrum/s2/icons/Play';
import Pause from '@react-spectrum/s2/icons/Pause';
import Stop from '@react-spectrum/s2/icons/StopProcessing';
import Refresh from '@react-spectrum/s2/icons/Refresh';
import Search from '@react-spectrum/s2/icons/Search';
import Save from '@react-spectrum/s2/icons/SaveFloppy';
import Settings from '@react-spectrum/s2/icons/Settings';
import Sort from '@react-spectrum/s2/icons/Sort';
import Star from '@react-spectrum/s2/icons/Star';
import StarFilled from '@react-spectrum/s2/icons/StarFilled';
import Tag from '@react-spectrum/s2/icons/Tag';
import Video from '@react-spectrum/s2/icons/Video';
import Clock from '@react-spectrum/s2/icons/Clock';
import Close from '@react-spectrum/s2/icons/Close';
import Info from '@react-spectrum/s2/icons/InfoCircle';
import Volume from '@react-spectrum/s2/icons/VolumeTwo';
import Muted from '@react-spectrum/s2/icons/VolumeOff';
import FullScreen from '@react-spectrum/s2/icons/FullScreen';
import Captions from '@react-spectrum/s2/icons/CloseCaptions';
import Tasks from '@react-spectrum/s2/icons/ListMultiSelect';
import Collection from '@react-spectrum/s2/icons/Collection';
import Filter from '@react-spectrum/s2/icons/Filter';
import Lightbulb from '@react-spectrum/s2/icons/Lightbulb';
import VisibilityOff from '@react-spectrum/s2/icons/VisibilityOff';
import Edit from '@react-spectrum/s2/icons/Edit';
import Bookmark from '@react-spectrum/s2/icons/Bookmark';
import Undo from '@react-spectrum/s2/icons/Undo';
import Redo from '@react-spectrum/s2/icons/Redo';
import Image from '@react-spectrum/s2/icons/Image';
const icon =
  (Component: ComponentType<IconProps>) =>
  ({ size: _size, ...props }: IconProps & { size?: string }) => <Component {...props} />;
export const IconChevronUp = icon(ChevronUp);
export const IconChevronDown = icon(ChevronDown),
  IconCheck = icon(Checkmark);
export const IconPlus = icon(Add),
  IconCamera = icon(Camera),
  IconChevronLeft = icon(ChevronLeft),
  IconChevronRight = icon(ChevronRight),
  IconCopy = icon(Copy),
  IconDelete = icon(Delete),
  IconFolder = icon(Folder),
  IconGridView = icon(Grid),
  IconApps = icon(Grid),
  IconList = icon(List),
  IconPlay = icon(Play),
  IconPause = icon(Pause),
  IconStop = icon(Stop),
  IconRefresh = icon(Refresh),
  IconSearch = icon(Search),
  IconSave = icon(Save),
  IconSetting = icon(Settings),
  IconSort = icon(Sort),
  IconStar = icon(StarFilled),
  IconStarStroked = icon(Star),
  IconTag = icon(Tag),
  IconPriceTag = icon(Tag),
  IconVideo = icon(Video),
  IconClock = icon(Clock),
  IconClose = icon(Close),
  IconInfo = icon(Info),
  IconVolume = icon(Volume),
  IconMuted = icon(Muted),
  IconFullscreen = icon(FullScreen),
  IconCaptions = icon(Captions);
export const IconTasks = icon(Tasks),
  IconCollection = icon(Collection),
  IconFilter = icon(Filter),
  IconLightbulb = icon(Lightbulb),
  IconHidden = icon(VisibilityOff);
export const IconEdit = icon(Edit),
  IconBookmark = icon(Bookmark),
  IconImage = icon(Image);
export const IconTranslate = icon(Translate);
export const IconUndo = icon(Undo),
  IconRedo = icon(Redo);

// Timeline marks share the Spectrum icons' 20px canvas and 1.5px stroke.
export const IconTimePoint = createIcon(props => (
  <svg
    {...props}
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 13h16M10 8v9" />
    <path d="m10 2 3 3-3 3-3-3Z" />
  </svg>
));
export const IconTimeRange = createIcon(props => (
  <svg
    {...props}
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 10h16M6 4H4v12h2M14 4h2v12h-2" />
  </svg>
));
export const IconSlider = createIcon(props => (
  <svg
    {...props}
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
  >
    <path d="M2 10h5m6 0h5" />
    <circle cx="10" cy="10" r="3" />
  </svg>
));

function SkipInterval({ forward = false, seconds }: { forward?: boolean; seconds: number }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={forward ? 'translate(24 0) scale(-1 1)' : undefined}
      >
        <path d="M4 5h8a8 8 0 1 1-8 8" />
        <path d="m7 2-3 3 3 3" />
      </g>
      <text
        x="12"
        y="13.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={String(seconds).length > 2 ? 6 : 8}
        fontWeight="600"
        fill="currentColor"
      >
        {seconds}
      </text>
    </svg>
  );
}
export const IconSkipBack = ({ seconds }: { seconds: number }) => <SkipInterval seconds={seconds} />;
export const IconSkipForward = ({ seconds }: { seconds: number }) => <SkipInterval seconds={seconds} forward />;
