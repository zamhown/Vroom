import { scopeKey, type AnnotationRecord, type Json, type Scope } from './types';

export type EditValue = { value: Json; operation: 'set' | 'clear'; note: string; locked: boolean };
type Change = {
  tagKey: string;
  scope: Scope;
  beforeScope: Scope;
  before: EditValue;
  after: EditValue;
  revision: number;
  sequence: number;
};
type Transaction = { changes: Change[] };
export type EditRequest = {
  expectedGeneration: number;
  idempotencyKey: string;
  writes: (EditValue & {
    subject: { kind: 'film' | 'term'; id: string };
    scope: Scope;
    tagKey: string;
    expectedRevision: number;
  })[];
};
type Flight = { request: EditRequest; changes: Change[]; direction: 'edit' | 'undo' | 'redo' };
export type EditorData = {
  pending: Record<string, Change>;
  undo: Transaction[];
  redo: Transaction[];
  guards: Record<string, number>;
  heads: Record<string, AnnotationRecord>;
  generation?: number;
  flight?: Flight;
};
export type EditorState = { data: EditorData; busy: boolean; error: string; canUndo: boolean; canRedo: boolean };
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: EditValue, b: EditValue) => JSON.stringify(a) === JSON.stringify(b);
export const editBinding = (tag: string, scope: Scope) => `${scopeKey(scope)}/${tag}`;
export const editValue = (r?: AnnotationRecord): EditValue => ({
  value: r?.value ?? null,
  operation: r?.operation ?? 'clear',
  note: r?.note ?? '',
  locked: r?.editPolicy?.locked ?? false,
});
const emptyData = (): EditorData => ({ pending: {}, undo: [], redo: [], guards: {}, heads: {} });

/** One serialized writer per film/tab. Pending edits remain optimistic until acknowledged.
 * Retries reuse the exact idempotency request, including after a workspace restore. */
export class AnnotationEditor {
  private data: EditorData;
  private records = new Map<string, AnnotationRecord>();
  private generation = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private error = '';
  private rejected = false;
  private listeners = new Set<() => void>();
  private state: EditorState;
  constructor(
    readonly filmId: string,
    private send: (request: EditRequest) => Promise<{ records: AnnotationRecord[]; generation?: number }>,
    initial?: EditorData,
    private subjectKind: 'film' | 'term' = 'film',
  ) {
    this.data = initial ? copy(initial) : emptyData();
    this.generation = this.data.generation ?? 0;
    this.sequence = Math.max(0, ...Object.values(this.data.pending).map(c => c.sequence));
    Object.entries(this.data.heads).forEach(([key, record]) => this.records.set(key, record));
    this.state = this.snapshot();
  }
  private snapshot(): EditorState {
    return {
      data: this.data,
      busy: !!this.running,
      error: this.error,
      canUndo: !!this.data.undo.length || !!Object.keys(this.data.pending).length,
      canRedo: !!this.data.redo.length && !Object.keys(this.data.pending).length,
    };
  }
  private emit() {
    this.data = { ...this.data };
    this.state = this.snapshot();
    this.listeners.forEach(fn => fn());
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  observe(records: AnnotationRecord[], generation: number) {
    if (this.generation !== generation) {
      this.records.clear();
      this.data = { ...this.data, heads: {}, generation };
      this.state = this.snapshot();
    }
    this.generation = generation;
    for (const record of records) {
      const key = editBinding(record.tagKey, record.scope),
        previous = this.records.get(key);
      if (!previous || record.revision >= previous.revision) this.records.set(key, record);
    }
  }
  record(tag: string, scope: Scope) {
    return this.records.get(editBinding(tag, scope));
  }
  value(tag: string, scope: Scope) {
    return (
      this.data.pending[editBinding(tag, scope)]?.after.value ??
      (this.data.pending[editBinding(tag, scope)] ? null : this.record(tag, scope)?.value)
    );
  }
  pending(tag: string, scope: Scope) {
    return this.data.pending[editBinding(tag, scope)];
  }
  edit(
    tagKey: string,
    scope: Scope,
    value: Json,
    options: { note?: string; locked?: boolean; revision?: number; delay?: number } = {},
  ) {
    // A validated rejection did not commit anything. Corrected input can form a new
    // request, but a lost response must still retry the original idempotency key.
    if (this.rejected && this.data.flight?.direction === 'edit') {
      this.data = { ...this.data, flight: undefined };
      this.error = '';
      this.rejected = false;
    }
    const key = editBinding(tagKey, scope),
      record = this.record(tagKey, scope),
      previous = this.data.pending[key];
    const before = previous?.before ?? editValue(record);
    const after: EditValue = {
      value,
      operation: value == null ? 'clear' : 'set',
      note: options.note ?? previous?.after.note ?? record?.note ?? '',
      locked: options.locked ?? true,
    };
    const pending = { ...this.data.pending };
    const beforeScope = previous?.beforeScope ?? record?.scope ?? scope;
    if (
      same(before, after) &&
      JSON.stringify(beforeScope) === JSON.stringify(scope) &&
      !this.data.flight?.changes.some(c => editBinding(c.tagKey, c.scope) === key)
    )
      delete pending[key];
    else
      pending[key] = {
        tagKey,
        scope: copy(scope),
        beforeScope: copy(beforeScope),
        before,
        after,
        revision: previous?.revision ?? options.revision ?? record?.revision ?? 0,
        sequence: ++this.sequence,
      };
    this.data = { ...this.data, pending, redo: [] };
    this.emit();
    if (!this.error) this.schedule(options.delay ?? 450);
  }
  resume() {
    if (Object.keys(this.data.pending).length || this.data.flight) this.schedule(450);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, delay);
  }
  private makeFlight(changes: Change[], direction: Flight['direction']): Flight {
    return {
      changes: copy(changes),
      direction,
      request: {
        expectedGeneration: this.generation,
        idempotencyKey: crypto.randomUUID(),
        writes: changes.map(c => ({
          ...copy(c.after),
          subject: { kind: this.subjectKind, id: this.filmId },
          tagKey: c.tagKey,
          scope: copy(c.scope),
          expectedRevision: c.revision,
        })),
      },
    };
  }
  private async execute() {
    const flight = this.data.flight!;
    const result = await this.send(flight.request);
    const currentProjection = (result.generation ?? flight.request.expectedGeneration) === this.generation;
    const pending = { ...this.data.pending },
      heads = { ...this.data.heads },
      guards = { ...this.data.guards };
    for (const record of result.records) {
      const key = editBinding(record.tagKey, record.scope),
        change = flight.changes.find(c => editBinding(c.tagKey, c.scope) === key)!;
      guards[key] = record.revision;
      if (currentProjection) {
        heads[key] = record;
        this.records.set(key, record);
      }
      const next = pending[key];
      if (
        next &&
        (next.sequence === change.sequence ||
          (same(next.after, editValue(record)) && JSON.stringify(next.scope) === JSON.stringify(record.scope)))
      )
        delete pending[key];
      else if (next)
        pending[key] = { ...next, before: editValue(record), beforeScope: record.scope, revision: record.revision };
    }
    let undo = [...this.data.undo],
      redo = [...this.data.redo];
    if (flight.direction === 'edit') {
      undo.push({ changes: flight.changes });
      undo = undo.slice(-30);
      redo = [];
    } else if (flight.direction === 'undo') {
      const transaction = undo.pop();
      if (transaction) redo.push(transaction);
    } else {
      const transaction = redo.pop();
      if (transaction) undo.push(transaction);
    }
    this.data = { pending, heads, guards, undo, redo, generation: this.generation };
    this.error = '';
    this.rejected = false;
    this.emit();
  }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.running) {
      await this.running;
      return this.flush();
    }
    if (!this.data.flight && !Object.keys(this.data.pending).length) return;
    if (!this.data.flight)
      this.data = { ...this.data, flight: this.makeFlight(Object.values(this.data.pending), 'edit') };
    // Keep the in-flight request persisted before the network can succeed.
    this.error = '';
    this.running = Promise.resolve().then(() => this.execute());
    this.emit();
    try {
      await this.running;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.rejected = !!(e as { code?: string })?.code;
      throw e;
    } finally {
      this.running = undefined;
      this.emit();
    }
    if (Object.keys(this.data.pending).length) await this.flush();
  };
  async travel(direction: 'undo' | 'redo') {
    await this.flush();
    const transaction = this.data[direction].at(-1);
    if (!transaction) return;
    const changes = transaction.changes.map(c => ({
      ...copy(c),
      scope: copy(direction === 'undo' ? c.beforeScope : c.scope),
      after: copy(direction === 'undo' ? c.before : c.after),
      revision: this.data.guards[editBinding(c.tagKey, c.scope)] ?? c.revision,
      sequence: ++this.sequence,
    }));
    this.data = { ...this.data, flight: this.makeFlight(changes, direction) };
    await this.flush();
  }
  discard() {
    if (this.running) return;
    clearTimeout(this.timer);
    this.data = { ...this.data, pending: {}, flight: undefined };
    this.error = '';
    this.rejected = false;
    this.emit();
  }
}

export const annotationSessions = new Map<string, AnnotationEditor>();
export async function flushAnnotationEditors(tabId: string) {
  await Promise.all(
    [...annotationSessions].filter(([key]) => key.startsWith(tabId + '/')).map(([, editor]) => editor.flush()),
  );
}
