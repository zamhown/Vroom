import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryRefresh } from './query-refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('event-driven query refresh', () => {
  it('coalesces events during a read and publishes its result before one follow-up read', async () => {
    const first = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(35);
    const accept = vi.fn();
    const query = createQueryRefresh(load, accept, vi.fn());
    query.request();
    await vi.advanceTimersByTimeAsync(180);
    for (let i = 0; i < 34; i++) query.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(load).toHaveBeenCalledTimes(1);
    first.resolve(34);
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenLastCalledWith(34);
    await vi.advanceTimersByTimeAsync(180);
    expect(load).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenLastCalledWith(35);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    query.dispose();
  });

  it('keeps updating during a continuous stream of changes instead of postponing forever', async () => {
    const load = vi.fn().mockResolvedValue({ total: 34 });
    const accept = vi.fn();
    const query = createQueryRefresh(load, accept, vi.fn());
    for (let i = 0; i < 20; i++) {
      query.request();
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(accept.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(load.mock.calls.length).toBeLessThan(20);
    query.dispose();
  });

  it('ignores a superseded query even when its slower response finishes last', async () => {
    const old = deferred<string>();
    const accept = vi.fn();
    const previous = createQueryRefresh(() => old.promise, accept, vi.fn());
    previous.request();
    await vi.advanceTimersByTimeAsync(180);
    previous.dispose();
    const next = createQueryRefresh(async () => 'new filter', accept, vi.fn());
    next.request();
    await vi.advanceTimersByTimeAsync(180);
    old.resolve('old filter');
    await vi.advanceTimersByTimeAsync(0);
    expect(accept.mock.calls).toEqual([['new filter']]);
    next.dispose();
  });

  it('retains the last result on failure and can refresh again after recovery', async () => {
    const accept = vi.fn(),
      reject = vi.fn();
    const load = vi.fn().mockResolvedValueOnce(34).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(35);
    const query = createQueryRefresh(load, accept, reject);
    for (let i = 0; i < 3; i++) {
      query.request();
      await vi.advanceTimersByTimeAsync(180);
    }
    expect(accept.mock.calls).toEqual([[34], [35]]);
    expect(reject).toHaveBeenCalledTimes(1);
    query.dispose();
  });
});
