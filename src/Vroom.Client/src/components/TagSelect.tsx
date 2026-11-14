import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ComboBox, ComboBoxValue, Group, Input, Button, Popover, ListBox, ListBoxItem } from 'react-aria-components';
import { TagGroup, Tag, ProgressCircle } from '@react-spectrum/s2';
import { IconCheck, IconChevronDown, IconPlus } from '../icons';

export interface TagSelectOption<T> {
  id: string;
  label: string;
  value: T;
  /** Other names that should find this option (aliases, other translations). */
  keywords?: string[];
}
export interface TagSelectProps<T> {
  label: string;
  options: TagSelectOption<T>[];
  value: string[];
  multiple?: boolean;
  disabled?: boolean;
  placeholder: string;
  emptyText: string;
  createLabel(name: string): string;
  onChange(options: TagSelectOption<T>[]): void;
  onOpenOption?(id: string): void;
  onCreate?(name: string): Promise<TagSelectOption<T>>;
}

/** Shared searchable, creatable selection control built with Adobe's accessible primitives. */
export function TagSelect<T>({
  label,
  options,
  value,
  multiple = false,
  disabled,
  placeholder,
  emptyText,
  createLabel,
  onChange,
  onCreate,
  onOpenOption,
}: TagSelectProps<T>) {
  const createId = useId();
  const input = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<TagSelectOption<T>[]>([]);
  const all = useMemo(
    () => [...options, ...created.filter(option => !options.some(item => item.id === option.id))],
    [options, created],
  );
  const selected = value
    .map(id => all.find(option => option.id === id))
    .filter((option): option is TagSelectOption<T> => !!option);
  const selectedText = selected[0]?.label ?? '';
  useEffect(() => {
    if (!multiple && !focused.current) setQuery(onOpenOption ? '' : selectedText);
  }, [multiple, selectedText, !!onOpenOption]);
  const text = query.trim();
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
  const collator = useMemo(() => new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }), []);
  const filtered = all
    .filter(option => [option.label, ...(option.keywords ?? [])].some(name => fold(name).includes(normalized)))
    .sort((a, b) => collator.compare(a.label, b.label));
  const canCreate =
    !!onCreate && !!text && !all.some(option => option.label.normalize('NFKC').toLocaleLowerCase() === normalized);
  const items = [
    ...filtered.map(option => ({ id: option.id, label: option.label, create: false })),
    ...(canCreate ? [{ id: createId, label: createLabel(text), create: true }] : []),
  ];
  const choose = async (keys: string[]) => {
    if (creating) return;
    setError('');
    if (keys.includes(createId) && onCreate) {
      setCreating(true);
      try {
        const option = await onCreate(text);
        setCreated(previous => [...previous.filter(item => item.id !== option.id), option]);
        onChange(multiple ? [...selected.filter(item => item.id !== option.id), option] : [option]);
        setQuery(multiple || onOpenOption ? '' : option.label);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
      return;
    }
    if (!keys.length && !multiple) return;
    const next = keys
      .map(id => all.find(option => option.id === id))
      .filter((option): option is TagSelectOption<T> => !!option);
    if (keys.length !== value.length || keys.some((key, index) => key !== value[index])) onChange(next);
    setQuery(multiple || onOpenOption ? '' : (next[0]?.label ?? ''));
  };
  return (
    <div className="tag-select" data-disabled={disabled || undefined}>
      <ComboBox
        aria-label={label}
        selectionMode={multiple ? 'multiple' : 'single'}
        value={multiple ? value : (value[0] ?? null)}
        onChange={keys => void choose(Array.isArray(keys) ? keys.map(String) : keys == null ? [] : [String(keys)])}
        inputValue={query}
        onInputChange={setQuery}
        items={items}
        isDisabled={disabled || creating}
        allowsEmptyCollection
        menuTrigger="focus"
        allowsCustomValue
      >
        <Group className="tag-select-control">
          <div
            className="tag-select-content"
            data-has-value={((multiple || !!onOpenOption) && selected.length > 0) || undefined}
          >
            {/* ComboBoxValue excludes the nested chip collection from the option collection. */}
            {(multiple || !!onOpenOption) && (
              <ComboBoxValue className="tag-select-selected">
                {() =>
                  selected.length > 0 ? (
                    <TagGroup
                      aria-label={label}
                      size="S"
                      UNSAFE_className="tag-select-values"
                      onAction={onOpenOption ? id => onOpenOption(String(id)) : undefined}
                      onRemove={
                        disabled || creating
                          ? undefined
                          : keys => {
                              onChange(selected.filter(item => !keys.has(item.id)));
                              input.current?.focus();
                            }
                      }
                    >
                      {selected.map(option => (
                        <Tag key={option.id} id={option.id} textValue={option.label}>
                          {option.label}
                        </Tag>
                      ))}
                    </TagGroup>
                  ) : null
                }
              </ComboBoxValue>
            )}
            <Input
              ref={input}
              onFocus={e => {
                focused.current = true;
                if (!multiple) e.currentTarget.select();
              }}
              onBlur={() => {
                focused.current = false;
                if (!multiple && !creating) setQuery(onOpenOption ? '' : selectedText);
              }}
              className="tag-select-input"
              placeholder={selected.length && (multiple || onOpenOption) ? '' : placeholder}
            />
          </div>
          <Button className="tag-select-trigger" aria-label={label}>
            {creating ? (
              <ProgressCircle isIndeterminate size="S" aria-label={label} />
            ) : (
              <IconChevronDown size="small" />
            )}
          </Button>
        </Group>
        <Popover className="tag-select-popover" placement="bottom start">
          <ListBox
            items={items}
            className="tag-select-options"
            renderEmptyState={() => <div className="tag-select-empty">{emptyText}</div>}
          >
            {item => (
              <ListBoxItem className="tag-select-option" id={item.id} textValue={item.label}>
                {({ isSelected }) => (
                  <>
                    <span className="tag-select-option-icon">
                      {item.create ? <IconPlus size="small" /> : isSelected ? <IconCheck size="small" /> : null}
                    </span>
                    <span>{item.label}</span>
                  </>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      {error && (
        <span className="tag-select-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
