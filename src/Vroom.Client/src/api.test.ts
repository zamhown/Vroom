import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe('native raw-message RPC', () => {
  it('correlates concurrent WebView2 responses, including large unicode payloads', async () => {
    let receive: (event: { data: string }) => void = () => {};
    const sent: { id: string; request: { method: string; args: unknown } }[] = [];
    vi.stubGlobal('window', {
      chrome: {
        webview: {
          addEventListener: (_: string, listener: typeof receive) => {
            receive = listener;
          },
          postMessage: (encoded: string) => {
            const message = decodeURIComponent(encoded);
            expect(message.startsWith('__RawMessage|')).toBe(true);
            sent.push(JSON.parse(message.slice(13)));
          },
        },
      },
    });
    const { call } = await import('./api');
    const args = { text: '日本語 · 标签 %41 %00 \u0000'.repeat(2000) };
    const first = call('workspace.save', args);
    const second = call('bootstrap');
    expect(sent[0].request.args).toEqual(args);
    receive({
      data: encodeURIComponent(
        JSON.stringify({ id: sent[1].id, response: JSON.stringify({ ok: true, data: 'second' }) }),
      ),
    });
    receive({
      data: encodeURIComponent(
        JSON.stringify({ id: sent[0].id, response: JSON.stringify({ ok: true, data: 'first' }) }),
      ),
    });
    expect(await first).toBe('first');
    expect(await second).toBe('second');
  });
  it('creates the WKWebView receiver when window.external is absent and propagates service errors', async () => {
    let sent = '';
    const host = {
      webkit: {
        messageHandlers: {
          webwindowinterop: {
            postMessage: (message: string) => {
              sent = message;
            },
          },
        },
      },
    } as unknown as Window & { external: { receiveMessage(message: string): void } };
    vi.stubGlobal('window', host);
    const { call } = await import('./api');
    const result = call('job.pause', { id: 'missing' });
    const rejection = expect(result).rejects.toThrow('任务不存在');
    host.external.receiveMessage(
      JSON.stringify({
        id: JSON.parse(sent.slice(13)).id,
        response: JSON.stringify({ ok: false, error: '任务不存在' }),
      }),
    );
    await rejection;
  });
});
