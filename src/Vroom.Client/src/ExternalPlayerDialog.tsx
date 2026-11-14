import { useEffect, useState } from 'react';
import { Button, Modal, Select, Banner } from './ui';
import { FormField, FormLayout } from './components/FormLayout';
import { call } from './api';
import { notifyError } from './context';
import { t } from './i18n';

export function ExternalPlayerDialog({
  filmId,
  partId,
  visible,
  onClose,
}: {
  filmId: string;
  partId?: string;
  visible: boolean;
  onClose(): void;
}) {
  const [players, setPlayers] = useState<{ id: string; name: string; tracksProgress: boolean }[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible)
      void call<typeof players>('external.players')
        .then(items => {
          setPlayers(items);
          setSelected(items[0]?.id ?? '');
        })
        .catch(notifyError);
  }, [visible]);
  const open = async () => {
    setBusy(true);
    try {
      await call('external.open', { filmId, partId, playerId: selected });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      mode="modeless"
      visible={visible}
      title={t('ExternalPlayers.title')}
      onCancel={onClose}
      footer={
        <Button disabled={busy || !selected} onClick={() => void open()}>
          {t('ExternalPlayers.open')}
        </Button>
      }
    >
      {players.length === 0 ? (
        <Banner type="warning" description={t('ExternalPlayers.none')} />
      ) : (
        <FormLayout>
          <FormField
            label={t('ExternalPlayers.player')}
            description={t(
              players.find(p => p.id === selected)?.tracksProgress
                ? 'ExternalPlayers.tracked'
                : 'ExternalPlayers.untracked',
            )}
          >
            <Select
              value={selected}
              onChange={value => setSelected(String(value))}
              optionList={players.map(p => ({ value: p.id, label: p.name }))}
            />
          </FormField>
        </FormLayout>
      )}
    </Modal>
  );
}
