export interface DraftHead {
  text?: string;
  generation?: number;
}
export interface DraftChange {
  id: string;
  before: DraftHead;
  after: DraftHead;
}
export interface DraftTransaction {
  changes: DraftChange[];
  at: number;
  group?: string;
}
export interface ConfigHistory {
  undo: DraftTransaction[];
  redo: DraftTransaction[];
}
export interface ConfigDraftState {
  drafts: Record<string, string>;
  baseGenerations: Record<string, number>;
  draftHistories: Record<string, ConfigHistory>;
}

export function configDraftState(state: Partial<ConfigDraftState>): ConfigDraftState {
  return {
    drafts: state.drafts ?? {},
    baseGenerations: state.baseGenerations ?? {},
    draftHistories: state.draftHistories ?? {},
  };
}
const head = (state: ConfigDraftState, id: string): DraftHead =>
  state.drafts[id] === undefined ? {} : { text: state.drafts[id], generation: state.baseGenerations[id] };
const sameHead = (a: DraftHead, b: DraftHead) => a.text === b.text && a.generation === b.generation;
function canonical(value: any): any {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, canonical(value[key])]),
        )
      : value;
}
export function sameConfiguration(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)));
  } catch {
    return false;
  }
}

/** Current-format retained drafts have an aggregate starting point, not invented intermediate edits. */
export function configHistory(state: ConfigDraftState, owner: string): ConfigHistory {
  return (
    state.draftHistories[owner] ?? {
      undo:
        state.drafts[owner] === undefined
          ? []
          : [{ changes: [{ id: owner, before: {}, after: head(state, owner) }], at: 0 }],
      redo: [],
    }
  );
}

// Continuous typing in one property is one step; other fields and editor modes
// always start a new step. Arrays and compound changes stay atomic.
function typingPath(before: string | undefined, after: string | undefined): string | undefined {
  try {
    const paths: string[] = [];
    const visit = (a: any, b: any, path: string[]) => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (a && b && !Array.isArray(a) && !Array.isArray(b) && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[key], b[key], [...path, key]);
      } else
        paths.push(
          (typeof a === 'string' && typeof b === 'string') || (typeof a === 'number' && typeof b === 'number')
            ? JSON.stringify(path)
            : '',
        );
    };
    visit(JSON.parse(before!), JSON.parse(after!), []);
    return paths.length === 1 && paths[0] ? paths[0] : undefined;
  } catch {
    return;
  }
}

export function hasRelatedDraftChanges(state: ConfigDraftState, owner: string, next = state): boolean {
  const origins = new Map<string, DraftHead>();
  for (const transaction of configHistory(state, owner).undo)
    for (const change of transaction.changes) {
      if (change.id !== owner && !origins.has(change.id)) origins.set(change.id, change.before);
    }
  return [...origins].some(([id, original]) => next.drafts[id] !== undefined && !sameHead(original, head(next, id)));
}

export function recordConfigEdit(
  state: ConfigDraftState,
  owner: string,
  next: ConfigDraftState,
  options: { mode: string; at: number; baseline?: string },
): ConfigDraftState {
  const changes = [...new Set([...Object.keys(state.drafts), ...Object.keys(next.drafts)])]
    .map(id => ({ id, before: head(state, id), after: head(next, id) }))
    .filter(change => !sameHead(change.before, change.after));
  if (!changes.length) return state;
  const previous = configHistory(state, owner),
    undo = [...previous.undo];
  const path =
    changes.length === 1 && changes[0].id === owner
      ? options.mode === 'json'
        ? 'json'
        : typingPath(changes[0].before.text ?? options.baseline, changes[0].after.text ?? options.baseline)
      : undefined;
  const group = path ? options.mode + ':' + path : undefined;
  const last = undo.at(-1);
  if (
    !previous.redo.length &&
    group &&
    last?.group === group &&
    options.at - last.at >= 0 &&
    options.at - last.at < 750 &&
    last.changes.length === 1 &&
    sameHead(last.changes[0].after, changes[0].before)
  ) {
    const change = { ...changes[0], before: last.changes[0].before };
    if (sameHead(change.before, change.after)) undo.pop();
    else undo[undo.length - 1] = { changes: [change], at: options.at, group };
  } else undo.push({ changes, at: options.at, group });
  return { ...next, draftHistories: { ...state.draftHistories, [owner]: { undo, redo: [] } } };
}

/** Undo only the resources changed by this owner; never replace another tag's drafts. */
export function travelConfigHistory(
  state: ConfigDraftState,
  owner: string,
  direction: 'undo' | 'redo',
): { state: ConfigDraftState; conflict?: string } {
  const history = configHistory(state, owner),
    transaction = history[direction].at(-1);
  if (!transaction) return { state };
  const expected = direction === 'undo' ? 'after' : 'before',
    target = direction === 'undo' ? 'before' : 'after';
  for (const change of transaction.changes)
    if (!sameHead(head(state, change.id), change[expected])) return { state, conflict: change.id };
  // A newly shared unpublished resource must not disappear beneath another draft.
  for (const change of transaction.changes)
    if (change[target].text === undefined && change.id !== owner) {
      const key = change.id.slice(change.id.indexOf('/') + 1);
      const others = Object.entries(state.drafts).filter(
        ([id]) => id !== owner && !transaction.changes.some(change => change.id === id),
      );
      if (others.some(([, text]) => text.includes(JSON.stringify(key)))) return { state, conflict: change.id };
    }
  const drafts = { ...state.drafts },
    baseGenerations = { ...state.baseGenerations };
  for (const change of transaction.changes) {
    const value = change[target];
    if (value.text === undefined) {
      delete drafts[change.id];
      delete baseGenerations[change.id];
    } else {
      drafts[change.id] = value.text;
      if (value.generation === undefined) delete baseGenerations[change.id];
      else baseGenerations[change.id] = value.generation;
    }
  }
  const undo = [...history.undo],
    redo = [...history.redo];
  if (direction === 'undo') {
    undo.pop();
    redo.push(transaction);
  } else {
    redo.pop();
    undo.push(transaction);
  }
  return { state: { drafts, baseGenerations, draftHistories: { ...state.draftHistories, [owner]: { undo, redo } } } };
}

export function breakConfigEditGroup(state: ConfigDraftState, owner: string): ConfigDraftState {
  const history = state.draftHistories[owner],
    last = history?.undo.at(-1);
  if (!last?.group) return state;
  return {
    ...state,
    draftHistories: {
      ...state.draftHistories,
      [owner]: { ...history, undo: [...history.undo.slice(0, -1), { ...last, group: undefined }] },
    },
  };
}
