import { lazy, Suspense } from 'react';
import { SegmentedControl, SegmentedControlItem } from '@react-spectrum/s2';
import { t as appText } from '../i18n';
import { useApp } from '../context';
import { Button, Input, Spin } from '../ui';
import { FormField } from './FormLayout';
import type { Query } from '../types';
import type { Definition } from '../tagging/types';
import { queryEditorIssue } from '../query';
import { QuerySqlError, queryToSql, sqlToQuery } from '../query-sql';
import { QueryBuilder, QueryOrder } from './QueryBuilder';

const SqlEditor = lazy(() => import('./SqlEditor'));
export interface QueryEditorState {
  mode: 'form' | 'sql';
  sql?: string;
}
export function resolveQueryEditor(query: Query, editor: QueryEditorState | undefined, definitions: Definition[]) {
  let candidate = query;
  try {
    if (editor?.mode === 'sql') candidate = sqlToQuery(editor.sql ?? queryToSql(query), query);
    const issue = queryEditorIssue(candidate, definitions);
    return { query: candidate, error: issue ? appText(issue) : '', offset: undefined as number | undefined };
  } catch (error) {
    if (!(error instanceof QuerySqlError)) throw error;
    const before = (editor?.sql ?? '').slice(0, error.offset),
      line = before.split('\n').length,
      column = before.length - before.lastIndexOf('\n');
    return {
      query,
      error: appText('Query.sqlErrorAt', { line, column, message: appText(error.code, error.args) }),
      offset: error.offset,
    };
  }
}

/** A single query draft has two editing views and one external commit action. */
export function QueryEditor({
  query,
  editor = { mode: 'form' },
  onChange,
  modelKey,
  showSearch = true,
}: {
  query: Query;
  editor?: QueryEditorState;
  onChange(query: Query, editor: QueryEditorState): void;
  modelKey: string;
  showSearch?: boolean;
}) {
  const app = useApp(),
    resolved = resolveQueryEditor(query, editor, app.data.tagging.package.definitions);
  const sql = editor.mode === 'sql' ? (editor.sql ?? queryToSql(query)) : '';
  const switchMode = (mode: string) => {
    if (resolved.error || mode === editor.mode) return;
    onChange(resolved.query, mode === 'sql' ? { mode, sql: queryToSql(resolved.query) } : { mode: 'form' });
  };
  const where =
    query.where && query.where.op !== 'and' && query.where.op !== 'or'
      ? { op: 'and' as const, args: [query.where] }
      : query.where;
  return (
    <div className="query-editor">
      <div className="query-editor-toolbar">
        <SegmentedControl
          aria-label={appText('Query.editorView')}
          selectedKey={editor.mode}
          onSelectionChange={key => switchMode(String(key))}
        >
          <SegmentedControlItem id="form" isDisabled={editor.mode === 'sql' && !!resolved.error}>
            {appText('Query.formView')}
          </SegmentedControlItem>
          <SegmentedControlItem id="sql" isDisabled={editor.mode === 'form' && !!resolved.error}>
            {appText('Query.sqlView')}
          </SegmentedControlItem>
        </SegmentedControl>
        <span className="form-help">{appText('Query.applyHint')}</span>
        {editor.mode === 'sql' && (
          <Button
            size="S"
            theme="borderless"
            disabled={!!resolved.error}
            onClick={() => onChange(resolved.query, { mode: 'sql', sql: queryToSql(resolved.query) })}
          >
            {appText('Query.formatSql')}
          </Button>
        )}
      </div>
      {editor.mode === 'form' ? (
        <>
          {showSearch && (
            <FormField label={appText('LibraryPage.searchFilms')}>
              <Input
                aria-label={appText('LibraryPage.searchFilms')}
                value={query.search ?? ''}
                onChange={search => onChange({ ...query, search }, editor)}
              />
            </FormField>
          )}
          <QueryBuilder value={where} onChange={where => onChange({ ...query, where: where ?? null }, editor)} />
          <QueryOrder query={query} onChange={change => onChange({ ...query, ...change }, editor)} />
        </>
      ) : (
        <>
          <Suspense fallback={<Spin />}>
            <SqlEditor
              modelKey={modelKey}
              value={sql}
              onChange={sql => onChange(query, { mode: 'sql', sql })}
              error={resolved.error}
              errorOffset={resolved.offset}
            />
          </Suspense>
          <details className="form-disclosure query-sql-help">
            <summary>{appText('Query.sqlHelpTitle')}</summary>
            <p>{appText('Query.sqlHelp')}</p>
            <p>{appText('Query.sqlExtensions')}</p>
            <p>{appText('Query.sqlContext')}</p>
          </details>
        </>
      )}
      {resolved.error && (
        <p className="query-validation" role="alert">
          {resolved.error}
        </p>
      )}
    </div>
  );
}
