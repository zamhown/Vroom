import { t as appText } from '../i18n';
import { Picker, PickerItem, Text } from '@react-spectrum/s2';
import { IconTag, IconTimePoint, IconTimeRange, IconVideo } from '../icons';
import { annotationTargets } from './annotation-targets';
import { localize } from './i18n';
import { useApp } from '../context';

export const annotationTargetIcons = {
  Video: IconVideo,
  Tag: IconTag,
  TimePoint: IconTimePoint,
  TimeRange: IconTimeRange,
};
export const AnnotationTargetIcon = ({ icon, slot }: { icon: string; slot?: string }) => {
  const Icon = annotationTargetIcons[icon as keyof typeof annotationTargetIcons];
  return Icon ? <Icon slot={slot} /> : null;
};

export function AnnotationTargetPicker({
  value,
  label,
  disabled,
  onChange,
}: {
  value: string[];
  label: string;
  disabled?: boolean;
  onChange(value: string[]): void;
}) {
  const app = useApp();
  return (
    <Picker
      aria-label={label}
      selectionMode="multiple"
      value={value}
      onChange={keys => onChange([...keys].map(String))}
      isDisabled={disabled}
      UNSAFE_className="select-field annotation-target-picker"
      isInvalid={!value.length}
      errorMessage={!value.length ? appText('AnnotationTargetPicker.selectAtLeastOneSubject') : undefined}
    >
      {annotationTargets.map(t => (
        <PickerItem key={t.id} id={t.id} textValue={localize(t.label, app.locale, app.data.tagging.package)}>
          <AnnotationTargetIcon icon={t.icon} slot="icon" />
          <Text slot="label">{localize(t.label, app.locale, app.data.tagging.package)}</Text>
        </PickerItem>
      ))}
    </Picker>
  );
}
