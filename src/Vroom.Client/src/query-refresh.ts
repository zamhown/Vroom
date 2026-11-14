/** Coalesce invalidations without cancelling an in-flight read or starving continuous updates. */
export function createQueryRefresh<T>(
  load: () => Promise<T>,
  accept: (value: T) => void,
  reject: (error: unknown) => void,
  delay = 180,
) {
  let disposed = false;
  let running = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed || running || timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      running = true;
      requested = false;
      try {
        const result = await load();
        if (!disposed) accept(result);
      } catch (error) {
        if (!disposed) reject(error);
      } finally {
        running = false;
        if (requested) schedule();
      }
    }, delay);
  };
  return {
    request() {
      requested = true;
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
