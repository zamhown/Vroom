import { t } from '../i18n';
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
// Monaco 0.57's JSON worker manager imports editor contributions. Register their
// services before the first model initializes the standalone service container.
import 'monaco-editor/languages/features/json/jsonMode.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import { call } from '../api';

const schemas = new Map<string, { uri: string; fileMatch: string[]; schema: any }>();
(globalThis as any).MonacoEnvironment = {
  getWorker: (_: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
export default function JsonEditor({
  value,
  onChange,
  schema = 'definition',
  modelKey,
}: {
  value: string;
  onChange(value: string): void;
  schema?: string;
  modelKey: string;
}) {
  const programmatic = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const uri = monaco.Uri.parse(`vroom://user/${encodeURIComponent(modelKey)}.json`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, 'json', uri);
    const css = getComputedStyle(document.documentElement);
    const color = (token: string) => css.getPropertyValue(token).trim();
    const colors: Record<string, string> = {};
    const background = color('--s2-background-layer-1');
    const foreground = color('--s2-content-neutral');
    if (background.startsWith('#')) colors['editor.background'] = background;
    if (foreground.startsWith('#')) colors['editor.foreground'] = foreground;
    monaco.editor.defineTheme('vroom-spectrum', { base: 'vs-dark', inherit: true, rules: [], colors });
    const instance = monaco.editor.create(host.current, {
      model,
      theme: 'vroom-spectrum',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: 'Consolas, Microsoft YaHei UI, PingFang SC, monospace',
      tabSize: 2,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      formatOnPaste: true,
      formatOnType: true,
      ariaLabel: t('editor.jsonConfiguration'),
    });
    editor.current = instance;
    const listener = model.onDidChangeContent(() => {
      if (!programmatic.current) latest.current(model.getValue());
    });
    void call<Record<string, unknown>>('schema.get', { kind: schema }).then(resource => {
      if (disposed) return;
      schemas.set(uri.toString(), {
        uri: String(resource.$id) + ':' + encodeURIComponent(modelKey),
        fileMatch: [uri.toString()],
        schema: { ...resource, $id: String(resource.$id) + ':' + encodeURIComponent(modelKey) },
      });
      jsonDefaults.setDiagnosticsOptions({
        validate: true,
        allowComments: false,
        enableSchemaRequest: false,
        schemas: [...schemas.values()],
      });
    });
    const blur = instance.onDidBlurEditorText(() => {
      try {
        JSON.parse(model.getValue());
        void instance.getAction('editor.action.formatDocument')?.run();
      } catch {
        /* Keep malformed draft intact. */
      }
    });
    return () => {
      disposed = true;
      schemas.delete(uri.toString());
      listener.dispose();
      blur.dispose();
      instance.dispose();
      model.dispose();
      editor.current = undefined;
    };
  }, [modelKey, schema]);
  useEffect(() => {
    if (editor.current && editor.current.getValue() !== value) {
      programmatic.current = true;
      try {
        editor.current.setValue(value);
      } finally {
        programmatic.current = false;
      }
    }
  }, [value]);
  return <div className="schema-json-editor" ref={host} />;
}
