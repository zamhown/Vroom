import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotationEditor, editBinding, type EditRequest } from './AnnotationEditor';
import { whole, type AnnotationRecord, type Scope } from './types';

const seed = (value: AnnotationRecord['value'] = 'original', scope: Scope = whole): AnnotationRecord => ({
  id: 'a',
  revision: 4,
  subject: { kind: 'film', id: 'film' },
  scope,
  tagKey: 'user.unfamiliar',
  value,
  operation: 'set',
  status: 'valid',
  canWrite: true,
  origin: { kind: 'manual' },
  editPolicy: { locked: true },
  note: 'a note',
});
function backend(initial: AnnotationRecord = seed()) {
  const records = new Map([[editBinding(initial.tagKey, initial.scope), initial]]);
  const receipts = new Map<string, { records: AnnotationRecord[] }>();
  const send = vi.fn(async (request: EditRequest) => {
    const receipt = receipts.get(request.idempotencyKey);
    if (receipt) return receipt;
    for (const w of request.writes)
      if ((records.get(editBinding(w.tagKey, w.scope))?.revision ?? 0) !== w.expectedRevision)
        throw Object.assign(new Error('conflict'), { code: 'VALUE_REVISION_CONFLICT' });
    const result = {
      records: request.writes.map(w => ({
        ...seed(w.value, w.scope),
        tagKey: w.tagKey,
        revision: w.expectedRevision + 1,
        operation: w.operation,
        note: w.note,
        editPolicy: { locked: w.locked },
      })),
    };
    result.records.forEach(r => records.set(editBinding(r.tagKey, r.scope), r));
    receipts.set(request.idempotencyKey, result);
    return result;
  });
  return { records, send };
}
function setup(initial = seed()) {
  const db = backend(initial),
    editor = new AnnotationEditor('film', db.send);
  editor.observe([initial], 3);
  return { editor, ...db };
}
afterEach(() => vi.useRealTimers());
describe('serialized annotation autosave', () => {
  it('writes concrete value subjects and retains undo across persistence', async () => {
    const initial = { ...seed(20), subject: { kind: 'term' as const, id: 'specific-value' } };
    const send = vi.fn(async (request: EditRequest) => ({
      records: request.writes.map(w => ({
        ...initial,
        subject: w.subject,
        value: w.value,
        revision: w.expectedRevision + 1,
      })),
    }));
    const editor = new AnnotationEditor('specific-value', send, undefined, 'term');
    editor.observe([initial], 3);
    editor.edit(initial.tagKey, whole, 25);
    await editor.flush();
    expect(send.mock.calls[0][0].writes[0].subject).toEqual({ kind: 'term', id: 'specific-value' });
    const restored = new AnnotationEditor('specific-value', send, editor.getSnapshot().data, 'term');
    restored.observe(send.mock.results.length ? [{ ...initial, value: 25, revision: 5 }] : [], 3);
    await restored.travel('undo');
    expect(send.mock.calls.at(-1)![0].writes[0]).toMatchObject({
      subject: { kind: 'term', id: 'specific-value' },
      value: 20,
      expectedRevision: 5,
    });
  });
  it('coalesces typing while immediately displaying the newest draft', async () => {
    vi.useFakeTimers();
    const { editor, send } = setup();
    editor.edit('user.unfamiliar', whole, 'a');
    await vi.advanceTimersByTimeAsync(300);
    editor.edit('user.unfamiliar', whole, 'ab');
    expect(editor.value('user.unfamiliar', whole)).toBe('ab');
    await vi.advanceTimersByTimeAsync(449);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].writes[0].value).toBe('ab');
    expect(editor.getSnapshot().data.undo).toHaveLength(1);
  });
  it('never rolls back the displayed value when an earlier slow request is acknowledged', async () => {
    const db = backend(seed(3));
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let first = true;
    const editor = new AnnotationEditor('film', async request => {
      if (first) {
        first = false;
        await gate;
      }
      return db.send(request);
    });
    editor.observe([seed(3)], 3);
    editor.edit('user.unfamiliar', whole, 5);
    const saving = editor.flush();
    await Promise.resolve();
    editor.edit('user.unfamiliar', whole, 8);
    expect(editor.value('user.unfamiliar', whole)).toBe(8);
    const displayed: unknown[] = [];
    editor.subscribe(() => displayed.push(editor.value('user.unfamiliar', whole)));
    release();
    await saving;
    expect(displayed.every(v => v === 8)).toBe(true);
    expect(db.send.mock.calls.map(([r]) => r.writes[0].expectedRevision)).toEqual([4, 5]);
  });
  it('undoes and redoes persisted values, notes, locks and time ranges using current revisions', async () => {
    const original = seed('old', { kind: 'point', scopeId: 'point', startUs: '1000000' });
    const { editor, send } = setup(original);
    const target = { ...original.scope, startUs: '3000000' };
    editor.edit(original.tagKey, target, 'new', { note: 'changed', locked: false });
    await editor.flush();
    await editor.travel('undo');
    expect(editor.record(original.tagKey, target)).toMatchObject({
      value: 'old',
      note: 'a note',
      scope: original.scope,
      editPolicy: { locked: true },
    });
    await editor.travel('redo');
    expect(editor.record(original.tagKey, target)).toMatchObject({
      value: 'new',
      note: 'changed',
      scope: target,
      editPolicy: { locked: false },
    });
    expect(send.mock.calls.map(([r]) => r.writes[0].expectedRevision)).toEqual([4, 5, 6]);
  });
  it('restores pending requests after a lost response without double applying the operation', async () => {
    const db = backend();
    const editor = new AnnotationEditor('film', async request => {
      await db.send(request);
      throw new Error('connection lost');
    });
    editor.observe([seed()], 3);
    editor.edit('user.unfamiliar', whole, 'saved');
    await expect(editor.flush()).rejects.toThrow('connection lost');
    const persisted = structuredClone(editor.getSnapshot().data);
    const recovered = new AnnotationEditor('film', db.send, persisted);
    recovered.observe([...db.records.values()], 3);
    await recovered.flush();
    expect(db.send.mock.calls[0][0]).toEqual(db.send.mock.calls[1][0]);
    expect(recovered.record('user.unfamiliar', whole)?.revision).toBe(5);
    expect(recovered.getSnapshot().data.undo).toHaveLength(1);
    await recovered.travel('undo');
    expect(recovered.value('user.unfamiliar', whole)).toBe('original');
  });
  it('retains the draft and refuses to overwrite a concurrent change', async () => {
    const { editor, records, send } = setup();
    editor.edit('user.unfamiliar', whole, 'my edit');
    records.set(editBinding('user.unfamiliar', whole), { ...seed('external'), revision: 5 });
    await expect(editor.flush()).rejects.toThrow('conflict');
    expect(editor.value('user.unfamiliar', whole)).toBe('my edit');
    expect(editor.getSnapshot().error).toBe('conflict');
    await expect(editor.flush()).rejects.toThrow('conflict');
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    expect(records.values().next().value?.value).toBe('external');
  });
  it('refuses stale undo and preserves history for review instead of overwriting', async () => {
    const { editor, records } = setup();
    editor.edit('user.unfamiliar', whole, 'mine');
    await editor.flush();
    records.set(editBinding('user.unfamiliar', whole), { ...seed('external'), revision: 6 });
    editor.observe([...records.values()], 3);
    await expect(editor.travel('undo')).rejects.toThrow('conflict');
    expect(records.values().next().value?.value).toBe('external');
    expect(editor.getSnapshot().data.undo).toHaveLength(1);
  });
  it('allows correcting a rejected value, and clears redo after a new edit', async () => {
    const db = backend();
    const editor = new AnnotationEditor('film', r =>
      r.writes.some(w => w.value === 'invalid')
        ? Promise.reject(Object.assign(new Error('invalid'), { code: 'VALUE_OUT_OF_DOMAIN' }))
        : db.send(r),
    );
    editor.observe([seed()], 3);
    editor.edit('user.unfamiliar', whole, 'invalid');
    await expect(editor.flush()).rejects.toThrow('invalid');
    editor.edit('user.unfamiliar', whole, 'valid');
    await editor.flush();
    await editor.travel('undo');
    expect(editor.getSnapshot().canRedo).toBe(true);
    editor.edit('user.unfamiliar', whole, 'different');
    expect(editor.getSnapshot().canRedo).toBe(false);
    await editor.flush();
  });
  it('keeps clear optimistic until acknowledged and can undo it after workspace restore', async () => {
    const { editor, send } = setup();
    editor.edit('user.unfamiliar', whole, null);
    expect(editor.value('user.unfamiliar', whole)).toBeNull();
    await editor.flush();
    const restored = new AnnotationEditor('film', send, editor.getSnapshot().data);
    restored.observe([editor.record('user.unfamiliar', whole)!], 3);
    await restored.travel('undo');
    expect(restored.value('user.unfamiliar', whole)).toBe('original');
  });
  it('drops cached projections when the definition generation changes', async () => {
    const { editor } = setup(seed('valid before'));
    editor.edit('user.unfamiliar', whole, 'old domain');
    await editor.flush();
    editor.observe([{ ...seed(null), revision: 5, status: 'incompatible' }], 4);
    expect(editor.value('user.unfamiliar', whole)).toBeNull();
    expect(Object.keys(editor.getSnapshot().data.heads)).toHaveLength(0);
  });
  it('does not display an old-generation write response after a schema change', async () => {
    const db = backend();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const editor = new AnnotationEditor('film', async request => {
      const result = await db.send(request);
      await gate;
      return { ...result, generation: 3 };
    });
    editor.observe([seed()], 3);
    editor.edit('user.unfamiliar', whole, 'old domain');
    const saving = editor.flush();
    await Promise.resolve();
    editor.observe([{ ...seed(null), revision: 5, status: 'incompatible' }], 4);
    release();
    await saving;
    expect(editor.value('user.unfamiliar', whole)).toBeNull();
    expect(Object.keys(editor.getSnapshot().data.heads)).toHaveLength(0);
  });
});
