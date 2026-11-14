import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/editor.main.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { t as appText } from '../i18n';
import { useApp } from '../context';
import { localize } from '../tagging/i18n';
import { sqlIdentifier } from '../query-sql';

// Preserve the JSON editor's worker registration if it is already installed.
(globalThis as any).MonacoEnvironment ??= { getWorker: () => new EditorWorker() };
export default function SqlEditor({
  value,
  onChange,
  modelKey,
  error,
  errorOffset,
}: {
  value: string;
  onChange(value: string): void;
  modelKey: string;
  error?: string;
  errorOffset?: number;
}) {
  const app = useApp(),
    host = useRef<HTMLDivElement>(null),
    editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef({ onChange, app });
  latest.current = { onChange, app };
  const programmatic = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(
      value,
      'sql',
      monaco.Uri.parse(`vroom://query/${encodeURIComponent(modelKey)}.sql`),
    );
    const css = getComputedStyle(document.documentElement),
      colors: Record<string, string> = {};
    for (const [name, token] of [
      ['editor.background', '--s2-background-layer-1'],
      ['editor.foreground', '--s2-content-neutral'],
    ]) {
      const color = css.getPropertyValue(token).trim();
      if (color.startsWith('#')) colors[name] = color;
    }
    monaco.editor.defineTheme('vroom-query', { base: 'vs-dark', inherit: true, rules: [], colors });
    const instance = monaco.editor.create(host.current, {
      model,
      theme: 'vroom-query',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      folding: true,
      lineNumbersMinChars: 3,
      ariaLabel: appText('Query.sqlView'),
    });
    editor.current = instance;
    const listener = model.onDidChangeContent(() => {
      if (!programmatic.current) latest.current.onChange(model.getValue());
    });
    const completion = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['"', '.'],
      provideCompletionItems(current, position) {
        if (current !== model) return { suggestions: [] };
        const line = current.getLineContent(position.lineNumber),
          prefix = line.slice(0, position.column - 1);
        const inQuotes = (prefix.match(/"/g)?.length ?? 0) % 2 === 1;
        const start = inQuotes
          ? prefix.lastIndexOf('"') + 1
          : position.column - (prefix.match(/[a-z0-9_.]*$/i)?.[0].length ?? 0);
        const closingQuote = inQuotes ? line.indexOf('"', position.column - 1) : -1;
        const end = closingQuote >= 0 ? closingQuote + 2 : current.getWordUntilPosition(position).endColumn;
        const range = new monaco.Range(position.lineNumber, start, position.lineNumber, end);
        const { data, locale } = latest.current.app,
          pack = data.tagging.package;
        return {
          suggestions: pack.definitions
            .filter(d => d.enabled)
            .map(d => ({
              label: { label: d.key, description: localize(d.label, locale, pack) },
              insertText: sqlIdentifier(d.key),
              kind: monaco.languages.CompletionItemKind.Field,
              range,
              detail: localize(d.description, locale, pack),
            })),
        };
      },
    });
    return () => {
      listener.dispose();
      completion.dispose();
      instance.dispose();
      model.dispose();
      editor.current = undefined;
    };
  }, [modelKey]);
  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== value) {
      programmatic.current = true;
      try {
        instance.setValue(value);
      } finally {
        programmatic.current = false;
      }
    }
  }, [value]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    const position = model.getPositionAt(errorOffset ?? 0);
    monaco.editor.setModelMarkers(
      model,
      'query',
      error
        ? [
            {
              message: error,
              severity: monaco.MarkerSeverity.Error,
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column + 1,
            },
          ]
        : [],
    );
  }, [error, errorOffset]);
  return <div className="query-sql-editor" ref={host} />;
}
