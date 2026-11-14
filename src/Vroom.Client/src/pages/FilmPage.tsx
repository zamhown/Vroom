import { openContextMenu } from '../ContextMenu';
import { t as appText } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { Button, Spin } from '../ui';
import { EmptyState, Page } from '../components';
import { call } from '../api';
import { notifyError, useApp } from '../context';
import type { FilmDetail } from '../types';
import type { WorkspaceTab } from '../workspace';
import { Surface } from '../tagging/Surface';

export function FilmPage({ tab }: { tab: WorkspaceTab }) {
  const app = useApp();
  const id = tab.params!.filmId!;
  const [detail, setDetail] = useState<FilmDetail>();
  const [missing, setMissing] = useState(false);
  const reload = useCallback(async () => {
    setDetail(await call<FilmDetail>('film.get', { id }));
  }, [id]);
  useEffect(() => {
    // A restored tab may point at a film that was removed; show that instead of spinning forever.
    void reload()
      .then(() => setMissing(false))
      .catch(error => {
        if ((error as { message?: string })?.message === appText('host.CatalogRepository.filmNotFound'))
          setMissing(true);
        else notifyError(error);
      });
  }, [reload, app.filmRevision(id)]);
  return (
    <Page
      onContextMenu={event => {
        if (detail)
          openContextMenu(event, [
            {
              id: 'play',
              label: appText('components.play'),
              run: () =>
                app.open({
                  id: 'player:' + id,
                  kind: 'player',
                  title: detail.film.presentation.tabTitle,
                  params: { filmId: id },
                }),
            },
            { id: 'locate', label: appText('Journey.locateFile'), run: () => call('platform.reveal', { id }) },
            {
              id: 'copy',
              label: appText('ContextMenu.copyPath'),
              run: () => navigator.clipboard.writeText(detail.film.path),
            },
          ]);
      }}
    >
      {missing ? (
        <EmptyState title={appText('FilmPage.missing')} description={appText('FilmPage.missingHelp')}>
          <Button onClick={() => app.close(tab.id)}>{appText('context.closeTab')}</Button>
        </EmptyState>
      ) : detail ? (
        <Surface surface="film.details" detail={detail} tab={tab} reload={reload} />
      ) : (
        <Spin />
      )}
    </Page>
  );
}
