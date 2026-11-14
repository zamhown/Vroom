import { useEffect, useRef, useSyncExternalStore } from 'react';
import { call } from '../api';
import { notifyError, useApp } from '../context';
import type { FilmDetail } from '../types';
import type { WorkspaceTab } from '../workspace';
import { AnnotationEditor, annotationSessions as sessions, type EditorData } from './AnnotationEditor';
import type { AnnotationRecord } from './types';

// Modal and main surface for one tab share a writer; they must never race each other.
export function useAnnotationEditor(tab: WorkspaceTab, detail: FilmDetail, reload: () => Promise<void>) {
  const app = useApp();
  const key = tab.id + '/' + detail.film.id;
  let editor = sessions.get(key);
  if (!editor) {
    editor = new AnnotationEditor(
      detail.film.id,
      request => call<{ records: AnnotationRecord[]; generation: number }>('annotations.batch', request),
      (tab.state.annotationEditors as Record<string, EditorData> | undefined)?.[detail.film.id],
    );
    sessions.set(key, editor);
  }
  editor.observe(
    detail.generation === app.data.tagging.generation
      ? [...Object.values(detail.film.values), ...detail.annotations]
      : [],
    app.data.tagging.generation,
  );
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const live = useRef({ tab, app, reload });
  live.current = { tab, app, reload };
  useEffect(() => {
    const save = () => {
      const { tab, app } = live.current;
      const next = editor!.getSnapshot();
      app.patchState(
        tab.id,
        current => ({
          ...current,
          annotationEditors: { ...(current.annotationEditors as object), [detail.film.id]: next.data },
        }),
        !!Object.keys(next.data.pending).length ||
          !!next.data.flight ||
          !!Object.keys((tab.state.fieldDrafts as object) ?? {}).length,
      );
    };
    const unsub = editor!.subscribe(save);
    editor!.resume();
    return unsub;
  }, [editor]);
  const acknowledged = useRef(state.data.heads);
  useEffect(() => {
    if (acknowledged.current !== state.data.heads) {
      acknowledged.current = state.data.heads;
      void live.current.reload().catch(notifyError);
    }
  }, [state.data.heads]);
  return { editor, state };
}
