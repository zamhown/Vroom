import type { RpcMethod } from './rpc-methods';
import { reportError } from './diagnostics';
import { t as appText } from './i18n';
import type { Job } from './types';
import { terminal } from './types';
type Envelope<T> = {
  ok: boolean;
  data: T;
  error?: string;
  errorArgs?: Record<string, string | number>;
  code?: string;
  path?: string;
};
type NativeWindow = Window & {
  __vroomComposition?: boolean;
  chrome?: {
    webview?: {
      postMessage(message: string): void;
      addEventListener(name: string, callback: (event: MessageEvent) => void): void;
    };
  };
  webkit?: { messageHandlers?: { webwindowinterop?: { postMessage(message: string): void } } };
  hybridWebViewHost?: { sendMessage(message: string): void };
  external: External & { receiveMessage?: (message: string) => void };
};
const host = window as NativeWindow;
export const nativeComposition = host.__vroomComposition === true;
const native = Boolean(
  host.chrome?.webview || host.webkit?.messageHandlers?.webwindowinterop || host.hybridWebViewHost,
);
const pending = new Map<
  string,
  { resolve(value: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>();
function receive(raw: string) {
  try {
    const message = JSON.parse(raw);
    if (typeof message.nativeFullscreen === 'boolean') {
      window.dispatchEvent(new CustomEvent('native-fullscreen', { detail: message.nativeFullscreen }));
      return;
    }
    if (message.nativeInput) {
      window.dispatchEvent(new CustomEvent('native-playback-input', { detail: message.nativeInput }));
      return;
    }
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message.response);
    }
  } catch {
    /* Ignore messages belonging to the platform rather than our RPC. */
  }
}
// MAUI 10.0.110 URI-encodes WebView2 messages in both directions to preserve NULs.
if (host.chrome?.webview) host.chrome.webview.addEventListener('message', e => receive(decodeURIComponent(e.data)));
else if (host.webkit?.messageHandlers?.webwindowinterop) {
  if (!host.external) Object.defineProperty(host, 'external', { value: {}, configurable: true });
  host.external.receiveMessage = receive;
} else if (host.hybridWebViewHost) window.addEventListener('message', e => receive(e.data));

let context: { tabId: string; title: string } | undefined;
export const setApiContext = (value: typeof context) => {
  context = value;
};
/** Native player commands are forwarded by prefix; every other method is a generated host RPC name. */
export type ClientMethod = RpcMethod | `native.${string}`;

export async function call<T = unknown>(method: ClientMethod, args: unknown = {}): Promise<T> {
  try {
    let envelope: Envelope<T>;
    if (native) {
      const id = crypto.randomUUID();
      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(appText('api.theLocalServiceTimedOutCheckBackground')));
        }, 120_000);
        pending.set(id, { resolve, reject, timer });
      });
      const message = '__RawMessage|' + JSON.stringify({ id, request: { method, args, context } });
      if (host.chrome?.webview) host.chrome.webview.postMessage(encodeURIComponent(message));
      else if (host.webkit?.messageHandlers?.webwindowinterop)
        host.webkit.messageHandlers.webwindowinterop.postMessage(message);
      else host.hybridWebViewHost!.sendMessage(message);
      envelope = JSON.parse(await response);
    } else {
      const response = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Vroom-Client': 'react' },
        body: JSON.stringify({ method, args, context }),
      });
      if (!response.ok) throw new Error(appText('api.localServiceUnavailableHttp') + response.status);
      envelope = await response.json();
    }
    if (!envelope.ok) {
      const message = envelope.error ? appText(envelope.error, envelope.errorArgs) : appText('api.operationFailed');
      throw Object.assign(
        new Error(envelope.path ? appText('error.location', { message, path: envelope.path }) : message),
        { code: envelope.code, path: envelope.path },
      );
    }
    return envelope.data;
  } catch (error) {
    if (!method.startsWith('diagnostics.')) reportError(error, 'rpc.' + method);
    throw error;
  }
}
export const tool = <T = unknown>(name: string, args: unknown = {}) =>
  call<T>('tool.call', { tool: name, arguments: args });
export const startJob = async (kind: string, payload: unknown) =>
  (await call<{ jobId: string }>('job.start', { kind, payload })).jobId;
export function sendOnExit(method: ClientMethod, args: unknown) {
  if (native) {
    void call(method, args).catch(() => {});
    return;
  }
  const body = JSON.stringify({ method, args, context });
  if (new TextEncoder().encode(body).length > 60_000) return;
  void fetch('/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Vroom-Client': 'react' },
    body,
    keepalive: true,
  }).catch(() => {});
}
export async function waitJob<T>(id: string, earlyResult = false, signal?: AbortSignal): Promise<T> {
  while (true) {
    signal?.throwIfAborted();
    const job = await call<Job>('job.get', { id });
    if ((['cancelled', 'failed', 'interrupted'] as string[]).includes(job.state))
      throw new Error(job.error ? appText(job.error, job.errorArgs) : appText(job.detail, job.detailArgs));
    if ((earlyResult || job.state === 'completed') && job.resultJson) return JSON.parse(job.resultJson);
    if (terminal(job.state))
      throw new Error(job.error ? appText(job.error, job.errorArgs) : appText(job.detail, job.detailArgs));
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}
