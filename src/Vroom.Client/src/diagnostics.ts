type Sink = (record: { source: string; message: string; stack?: string; tabId?: string }) => Promise<unknown>;
let sink: Sink | undefined;
let recent = new Map<string, number>();
export function setDiagnosticSink(value: Sink) {
  sink = value;
}
export function reportError(error: unknown, source = 'client.action', tabId?: string) {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${source}:${tabId}:${message}`,
    now = Date.now();
  if (now - (recent.get(key) ?? 0) < 5000) return;
  if (recent.size > 100) recent = new Map();
  recent.set(key, now);
  // Logging failure cannot recursively trigger the error handler.
  void sink?.({
    source,
    message: message.slice(0, 4000),
    stack: error instanceof Error ? error.stack?.slice(0, 12000) : undefined,
    tabId,
  }).catch(() => {});
}
export function installErrorHandlers(onError: (error: unknown) => void, view: Window = window) {
  const error = (event: ErrorEvent) => {
    if (event.error) {
      reportError(event.error, 'client.unhandled');
      onError(event.error);
    }
  };
  const rejection = (event: PromiseRejectionEvent) => {
    reportError(event.reason, 'client.promise');
    onError(event.reason);
    event.preventDefault();
  };
  view.addEventListener('error', error);
  view.addEventListener('unhandledrejection', rejection);
  return () => {
    view.removeEventListener('error', error);
    view.removeEventListener('unhandledrejection', rejection);
  };
}
