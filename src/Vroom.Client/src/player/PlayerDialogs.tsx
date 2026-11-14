import { t as appText } from '../i18n';
import { FormField, FormLayout } from '../components/FormLayout';
import { Button, Input, Modal } from '../ui';

/** The current frame as an image with a download link. */
export function SnapshotDialog({ image, name, onClose }: { image: string; name: string; onClose(): void }) {
  return (
    <Modal
      mode="modeless"
      title={appText('PlayerPage.currentFrame')}
      visible={!!image}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{appText('PlayerPage.close')}</Button>}
      width={900}
    >
      <img className="snapshot" src={image} alt={appText('PlayerPage.currentVideoFrame')} />
      <a className="download-link" href={image} download={name + '.png'}>
        {appText('PlayerPage.saveImage')}
      </a>
    </Modal>
  );
}

/** Keyboard shortcuts of the player. */
export function ShortcutHelpDialog({
  visible,
  seekStep,
  onClose,
}: {
  visible: boolean;
  seekStep: number;
  onClose(): void;
}) {
  return (
    <Modal
      mode="modeless"
      title={appText('PlayerPage.keyboardShortcuts')}
      visible={visible}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{appText('PlayerPage.gotIt')}</Button>}
    >
      <dl className="description-list">
        <dt>{appText('PlayerPage.spaceK')}</dt>
        <dd>{appText('PlayerPage.playPause')}</dd>
        <dt>← / →</dt>
        <dd>{appText('Player.seekHelp', { seconds: seekStep })}</dd>
        <dt>↑ / ↓ / M</dt>
        <dd>{appText('PlayerPage.volumeMute')}</dd>
        <dt>, / .</dt>
        <dd>{appText('PlayerPage.previousNextFrame')}</dd>
        <dt>I / O</dt>
        <dd>{appText('PlayerPage.segmentStartEnd')}</dd>
        <dt>{appText('Player.fullscreenKeys')}</dt>
        <dd>{appText('PlayerPage.fullscreen')}</dd>
        <dt>T</dt>
        <dd>{appText('Player.focus')}</dd>
      </dl>
    </Modal>
  );
}

/** Jump to a typed time; invalid input is reported in place. */
export function JumpTimeDialog({
  value,
  valid,
  onChange,
  onSubmit,
  onClose,
}: {
  value: string | undefined;
  valid: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}) {
  return (
    <Modal
      title={appText('Player.jumpTime')}
      visible={value !== undefined}
      onCancel={onClose}
      footer={
        <Button theme="solid" disabled={!valid} onClick={onSubmit}>
          {appText('Player.jumpTime')}
        </Button>
      }
      width={380}
    >
      <FormLayout>
        <FormField label={appText('Player.jumpTime')} description={appText('Player.timeFormat')}>
          <Input
            aria-label={appText('Player.jumpTime')}
            value={value ?? ''}
            onChange={onChange}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          {value !== undefined && !valid && (
            <span role="alert" className="field-error">
              {appText('Player.invalidTime')}
            </span>
          )}
        </FormField>
      </FormLayout>
    </Modal>
  );
}
