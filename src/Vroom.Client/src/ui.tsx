import { reportError } from './diagnostics';
import { t as appText } from './i18n';
import React, { useContext, useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { RibbonCommandContext } from './components/ribbon-context';
import * as S from '@react-spectrum/s2';
import { DialogWindow, nativeDialogWindows, type WindowMode } from './DialogWindow';
import { activeUiWindow } from './window-environment';

// Product-level primitives, all interactive behavior is supplied by Adobe Spectrum.
type Basic = { children?: ReactNode; className?: string; style?: CSSProperties };
export function Button({
  children,
  icon,
  onClick,
  disabled,
  theme,
  type,
  size,
  block,
  className,
  style,
  staticColor,
  ...aria
}: Basic & {
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  theme?: string;
  type?: string;
  size?: string;
  block?: boolean;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  title?: string;
  staticColor?: 'white' | 'black' | 'auto';
}) {
  const ribbon = useContext(RibbonCommandContext);
  const controlSize = ribbon ? 'M' : size === 'S' || size === 'small' ? 'S' : size === 'L' ? 'L' : 'M';
  const props = {
    onPress: onClick,
    isDisabled: disabled,
    size: controlSize as 'S' | 'M' | 'L',
    UNSAFE_className: [className, block ? 'block-button' : ''].filter(Boolean).join(' '),
    UNSAFE_style: style,
    'aria-label': aria['aria-label'],
    'aria-pressed': aria['aria-pressed'],
    'aria-expanded': aria['aria-expanded'],
    'aria-controls': aria['aria-controls'],
    staticColor,
  };
  const content = (
    <>
      {icon}
      {children != null && <S.Text>{children}</S.Text>}
    </>
  );
  const result =
    ribbon && aria['aria-pressed'] !== undefined ? (
      <S.ToggleButton {...props} isSelected={aria['aria-pressed']} isEmphasized>
        {content}
      </S.ToggleButton>
    ) : theme === 'borderless' || !children || (ribbon && type !== 'danger' && theme !== 'solid') ? (
      <S.ActionButton {...props} isQuiet={theme === 'borderless'}>
        {content}
      </S.ActionButton>
    ) : (
      <S.Button
        {...props}
        variant={type === 'danger' ? 'negative' : theme === 'solid' ? 'accent' : 'secondary'}
        fillStyle={theme === 'solid' ? 'fill' : 'outline'}
      >
        {content}
      </S.Button>
    );
  return aria.title ? (
    <S.TooltipTrigger delay={500}>
      {result}
      <S.Tooltip>{aria.title}</S.Tooltip>
    </S.TooltipTrigger>
  ) : (
    result
  );
}
export const Space = ({ children, className = '', wrap }: Basic & { wrap?: boolean }) => (
  <div className={'space ' + className} style={{ flexWrap: wrap ? 'wrap' : undefined }}>
    {children}
  </div>
);
export const Card = ({
  title,
  children,
  className = '',
  bodyClassName = '',
}: Basic & { title?: ReactNode; bodyClassName?: string }) => (
  <section className={['panel', className].filter(Boolean).join(' ')}>
    {title && <h3 className="panel-title">{title}</h3>}
    <div className={['panel-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
  </section>
);
type FieldProps = {
  size?: 'S' | 'M' | 'L';
  value?: string;
  onChange?: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
  label?: string;
};
export const Input = ({
  disabled,
  readOnly,
  className,
  prefix,
  showClear,
  size = 'M',
  ...props
}: FieldProps & { prefix?: ReactNode; showClear?: boolean }) =>
  showClear ? (
    <S.SearchField
      {...props}
      size={size}
      isDisabled={disabled}
      isReadOnly={readOnly}
      aria-label={props['aria-label'] || props.placeholder || appText('ui.text')}
      UNSAFE_className={'input-field ' + (className ?? '')}
    />
  ) : (
    <S.TextField
      {...props}
      size={size}
      prefix={prefix}
      isDisabled={disabled}
      isReadOnly={readOnly}
      aria-label={props['aria-label'] || props.placeholder || appText('ui.text')}
      UNSAFE_className={'input-field ' + (className ?? '')}
    />
  );
export const TextArea = ({
  disabled,
  readOnly,
  rows = 3,
  autosize: _autosize,
  size = 'M',
  ...props
}: FieldProps & { rows?: number; autosize?: boolean }) => (
  <S.TextArea
    {...props}
    size={size}
    isDisabled={disabled}
    isReadOnly={readOnly}
    aria-label={props['aria-label'] || props.placeholder || appText('ui.content')}
    UNSAFE_className="input-field multiline-field"
    UNSAFE_style={{ '--input-min-height': `${rows * 23 + 16}px` } as CSSProperties}
  />
);
export const InputNumber = ({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  size = 'M',
  ...props
}: {
  size?: 'S' | 'M';
  value?: number | null;
  onChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  'aria-label'?: string;
}) => (
  <S.NumberField
    {...props}
    size={size}
    aria-label={props['aria-label'] || appText('ui.value')}
    value={value === null ? NaN : (value ?? 0)}
    onChange={onChange}
    minValue={min}
    maxValue={max}
    step={step}
    isDisabled={disabled}
    UNSAFE_className="number-field"
  />
);
type Option = { value: string | number; label: string; disabled?: boolean; icon?: ReactNode };
export function Select({
  value,
  onChange,
  optionList,
  filter,
  allowCreate,
  multiple,
  placeholder,
  size,
  disabled,
  ...props
}: {
  value?: string | number | string[];
  onChange?: (value: string | number | string[]) => void;
  optionList: Option[];
  filter?: boolean;
  allowCreate?: boolean;
  multiple?: boolean;
  placeholder?: string;
  size?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const label = props['aria-label'] || placeholder || appText('ui.select');
  const controlSize = size === 'S' || size === 'small' ? 'S' : size === 'L' ? 'L' : 'M';
  const common = {
    'aria-label': label,
    placeholder,
    isDisabled: disabled,
    size: controlSize as 'S' | 'M' | 'L',
    UNSAFE_className: 'select-field',
  };
  if (multiple)
    return (
      <S.Picker
        {...common}
        selectionMode="multiple"
        value={Array.isArray(value) ? value : []}
        onChange={v => onChange?.([...v].map(String))}
      >
        {optionList.map(o => (
          <S.PickerItem id={o.value} key={o.value} textValue={o.label} isDisabled={o.disabled}>
            {o.icon}
            <S.Text slot="label">{o.label}</S.Text>
          </S.PickerItem>
        ))}
      </S.Picker>
    );
  if (filter || allowCreate)
    return (
      <S.ComboBox
        {...common}
        allowsCustomValue={allowCreate}
        selectedKey={optionList.some(o => o.value === value) ? (value as string) : null}
        inputValue={allowCreate ? (optionList.find(o => o.value === value)?.label ?? String(value ?? '')) : undefined}
        onInputChange={allowCreate ? v => onChange?.(v) : undefined}
        onSelectionChange={key => {
          if (key != null) onChange?.(key);
        }}
      >
        {optionList.map(o => (
          <S.ComboBoxItem id={o.value} key={o.value} textValue={o.label} isDisabled={o.disabled}>
            {o.icon}
            <S.Text slot="label">{o.label}</S.Text>
          </S.ComboBoxItem>
        ))}
      </S.ComboBox>
    );
  // Empty string is a valid product filter, but Spectrum reserves it for no selection.
  return (
    <S.Picker
      {...common}
      value={value === '' ? '__all' : (value as string | number | undefined)}
      onChange={v => onChange?.(v === '__all' ? '' : (v ?? ''))}
    >
      {optionList.map(o => (
        <S.PickerItem id={o.value === '' ? '__all' : o.value} key={o.value} textValue={o.label} isDisabled={o.disabled}>
          {o.icon}
          <S.Text slot="label">{o.label}</S.Text>
        </S.PickerItem>
      ))}
    </S.Picker>
  );
}
export const Switch = ({
  checked,
  onChange,
  disabled,
  children,
  ...props
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  'aria-label'?: string;
}) => (
  <S.Switch
    {...props}
    isDisabled={disabled}
    aria-label={props['aria-label'] || (typeof children === 'string' ? children : appText('ui.enable'))}
    isSelected={checked}
    onChange={onChange}
  >
    {children}
  </S.Switch>
);
export const Checkbox = ({
  checked,
  onChange,
  children,
}: {
  checked?: boolean;
  onChange: (event: { target: { checked: boolean } }) => void;
  children?: ReactNode;
}) => (
  <S.Checkbox isSelected={checked} onChange={checked => onChange({ target: { checked } })}>
    {children}
  </S.Checkbox>
);
export const CheckboxGroup = ({
  value,
  options,
  onChange,
}: {
  value: number[];
  options: { label: string; value: number }[];
  direction?: string;
  onChange: (values: string[]) => void;
}) => (
  <S.CheckboxGroup
    aria-label={appText('ui.condition')}
    value={value.map(String)}
    onChange={onChange}
    orientation="horizontal"
  >
    {options.map(o => (
      <S.Checkbox key={o.value} value={String(o.value)}>
        {o.label}
      </S.Checkbox>
    ))}
  </S.CheckboxGroup>
);
export function Tag({
  children,
  color,
  closable,
  onClose,
  onClick,
}: Basic & { color?: string; size?: string; closable?: boolean; onClose?: () => void; onClick?: () => void }) {
  if (closable)
    return (
      <S.TagGroup aria-label={appText('ui.tags')} onRemove={onClose}>
        <S.Tag id="tag" textValue={String(children)}>
          {children}
        </S.Tag>
      </S.TagGroup>
    );
  if (onClick)
    return (
      <S.ActionButton size="S" isQuiet onPress={onClick}>
        {children}
      </S.ActionButton>
    );
  return <span className={'chip ' + (color ?? '')}>{children}</span>;
}
export const Spin = ({ size }: { size?: string }) => (
  <S.ProgressCircle aria-label={appText('ui.loading')} isIndeterminate size={size === 'small' ? 'S' : 'M'} />
);
export const Progress = ({ percent, showInfo }: { percent: number; showInfo?: boolean; size?: string }) => (
  <S.ProgressBar
    aria-label={appText('ui.taskProgress')}
    value={percent}
    valueLabel={showInfo ? Math.round(percent) + '%' : undefined}
    UNSAFE_style={{ width: '100%' }}
  />
);
export function Banner({
  type,
  title,
  description,
  className = '',
}: {
  type?: string;
  title?: ReactNode;
  description?: ReactNode;
  closeIcon?: unknown;
  className?: string;
}) {
  return (
    <div className={'notice ' + className}>
      <S.InlineAlert
        variant={
          type === 'danger'
            ? 'negative'
            : type === 'warning'
              ? 'notice'
              : type === 'success'
                ? 'positive'
                : 'informative'
        }
      >
        {title && <S.Heading>{title}</S.Heading>}
        <S.Content>{description}</S.Content>
      </S.InlineAlert>
    </div>
  );
}
export const Descriptions = ({ data }: { size?: string; data: { key: string; value: ReactNode }[] }) => (
  <dl className="description-list">
    {data.map(d => (
      <React.Fragment key={d.key}>
        <dt>{d.key}</dt>
        <dd>{d.value}</dd>
      </React.Fragment>
    ))}
  </dl>
);
export function Pagination({
  total,
  currentPage,
  pageSize,
  onPageChange,
}: {
  total: number;
  currentPage: number;
  pageSize: number;
  showTotal?: boolean;
  onPageChange: (page: number) => void;
}) {
  const count = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Space>
      <span className="muted">{appText('ui.totalItems', { count: total })}</span>
      <Button disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>
        {appText('ui.previousPage')}
      </Button>
      <span>
        {currentPage} / {count}
      </span>
      <Button disabled={currentPage >= count} onClick={() => onPageChange(currentPage + 1)}>
        {appText('ui.nextPage')}
      </Button>
    </Space>
  );
}
interface ColumnDef<T> {
  title: string;
  dataIndex?: keyof T;
  width?: number;
  render?: (value: unknown, item: T) => ReactNode;
}
/**
 * Content-sized data table. Lists live inside the page scroll container, so the table grows with its
 * rows instead of guessing a height from row counts (continuous loading and wrapping cells need this).
 */
export function Table<T extends { id: string }>({
  dataSource,
  columns,
  loading,
  pagination,
  onRow,
  empty,
}: {
  dataSource: T[];
  columns: ColumnDef<T>[];
  rowKey?: string;
  loading?: boolean;
  pagination?: false | { pageSize: number };
  onRow?: (item: T) => { onClick?: () => void; className?: string };
  empty?: ReactNode;
}) {
  const [page, setPage] = useState(1);
  const perPage = pagination ? pagination.pageSize : dataSource.length;
  const items = pagination ? dataSource.slice((page - 1) * perPage, page * perPage) : dataSource;
  return (
    <>
      <div className="data-table" aria-busy={loading || undefined}>
        <table aria-label={appText('ui.list')}>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i} scope="col" style={c.width ? { width: c.width } : undefined}>
                  {c.title || appText('ui.actions')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="data-table-empty">
                  {loading ? <Spin /> : (empty ?? <span className="muted">{appText('ui.noContent')}</span>)}
                </td>
              </tr>
            ) : (
              items.map(item => {
                const row = onRow?.(item);
                return (
                  <tr
                    key={item.id}
                    className={row?.className}
                    data-clickable={row?.onClick ? '' : undefined}
                    onClick={row?.onClick}
                  >
                    {columns.map((c, i) => (
                      <td key={i}>
                        {c.render
                          ? c.render(c.dataIndex ? item[c.dataIndex] : undefined, item)
                          : String(c.dataIndex ? (item[c.dataIndex] ?? '—') : '')}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {pagination && dataSource.length > perPage && (
        <Pagination total={dataSource.length} pageSize={perPage} currentPage={page} onPageChange={setPage} />
      )}
    </>
  );
}
type ModalProps = Basic & {
  title?: ReactNode;
  visible: boolean;
  onCancel(): void;
  onOk?: () => void | Promise<unknown>;
  okText?: string;
  footer?: ReactNode;
  width?: number;
  mode?: WindowMode;
  owner?: Window;
};
function ModalView({
  title,
  visible,
  children,
  onCancel,
  onOk,
  okText,
  footer,
  width,
  mode = 'exclusive',
  owner,
}: ModalProps) {
  const buttons = footer ?? (
    <>
      <Button onClick={onCancel}>{appText('ui.cancel')}</Button>
      <Button
        theme="solid"
        onClick={() => {
          void onOk?.();
        }}
      >
        {okText || appText('ui.save')}
      </Button>
    </>
  );
  if (nativeDialogWindows)
    return (
      visible && (
        <DialogWindow title={title} mode={mode} width={width} owner={owner} onClose={onCancel}>
          <div className="dialog-window-content">
            <div className="dialog-window-body">{children}</div>
          </div>
          <footer className="dialog-window-actions">{buttons}</footer>
        </DialogWindow>
      )
    );
  return (
    <S.DialogContainer onDismiss={onCancel}>
      {visible && (
        <S.Dialog size={width && width > 800 ? 'XL' : width && width > 600 ? 'L' : 'M'}>
          <S.Heading slot="title">{title}</S.Heading>
          <S.Content>{children}</S.Content>
          <S.ButtonGroup>{buttons}</S.ButtonGroup>
        </S.Dialog>
      )}
    </S.DialogContainer>
  );
}
type Confirm = {
  title: string;
  content?: ReactNode;
  okText?: string;
  cancelText?: string;
  onOk: () => void | Promise<unknown>;
  owner?: Window;
};
let presentConfirmation: ((value: Confirm) => void) | undefined;
export const Modal = Object.assign(ModalView, {
  confirm: (value: Confirm) => presentConfirmation?.({ ...value, owner: activeUiWindow() }),
});
export function ConfirmationHost() {
  const [value, setValue] = useState<Confirm>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    presentConfirmation = setValue;
    return () => {
      presentConfirmation = undefined;
    };
  }, []);
  const close = () => {
    if (!busy) setValue(undefined);
  };
  return (
    <ModalView
      title={value?.title}
      visible={!!value}
      mode="exclusive"
      owner={value?.owner}
      onCancel={close}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {value?.cancelText || appText('ui.cancel')}
          </Button>
          <Button
            theme="solid"
            disabled={busy}
            onClick={() => {
              if (!value || busy) return;
              setBusy(true);
              Promise.resolve()
                .then(value.onOk)
                .then(() => setValue(undefined))
                .catch(e => {
                  reportError(e);
                  Toast.error(String(e));
                })
                .finally(() => setBusy(false));
            }}
          >
            {value?.okText || appText('ui.confirm')}
          </Button>
        </>
      }
    >
      {value?.content}
    </ModalView>
  );
}
export const Toast = {
  success: (message: string) => S.ToastQueue.positive(message, { timeout: 4000 }),
  error: (message: string) => S.ToastQueue.negative(message),
  info: (message: string) => S.ToastQueue.info(message, { timeout: 5000 }),
};
const Panel = ({ header, children }: Basic & { header: ReactNode; itemKey: string }) => (
  <S.Disclosure>
    <S.DisclosureHeader>
      <S.DisclosureTitle>{header}</S.DisclosureTitle>
    </S.DisclosureHeader>
    <S.DisclosurePanel>{children}</S.DisclosurePanel>
  </S.Disclosure>
);
export const Collapse = Object.assign(({ children }: Basic) => <div className="disclosures">{children}</div>, {
  Panel,
});
export const Timeline = Object.assign(({ children }: Basic) => <ol className="event-timeline">{children}</ol>, {
  Item: ({ children, time }: Basic & { time: string }) => (
    <li>
      <small>{time}</small>
      <div>{children}</div>
    </li>
  ),
});
export const Typography = {
  Title: ({ children }: Basic & { heading?: number }) => <h2>{children}</h2>,
  Text: ({ children, className }: Basic & { type?: string }) => (
    <span className={className ?? 'muted'}>{children}</span>
  ),
  Paragraph: ({ children, className }: Basic & { copyable?: boolean }) => <p className={className}>{children}</p>,
};
export const Skeleton = Object.assign(
  ({ loading, children }: Basic & { loading?: boolean; placeholder?: ReactNode }) => (loading ? <Spin /> : children),
  { Paragraph: (_: { rows?: number }) => <Spin /> },
);
