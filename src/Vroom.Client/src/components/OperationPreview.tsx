import { t } from '../i18n';
import { Button, Space } from '../ui';
import { useApp, action } from '../context';
import { call } from '../api';
import { localize } from '../tagging/i18n';
import { TagValue } from '../tagging/Inputs';

/** Human-readable objects and changes. Machine contracts remain in a details disclosure. */
export function OperationPreview({ value }: { value: any }) {
  const app = useApp(),
    pack = app.data.tagging.package;
  if (!value) return null;
  const items = Array.isArray(value) ? value : (value.samples ?? value.films ?? value.items ?? value.conflicts ?? []);
  const count = value.total ?? value.count ?? value.changedCount ?? items.length;
  return (
    <div className="operation-preview">
      {typeof count === 'number' && count > 0 && <b>{t('Journey.resultCount', { count })}</b>}
      {value.impact && (
        <Space wrap>
          <span>{t('Journey.changedValues', { count: value.impact.changedValues ?? 0 })}</span>
          <span>{t('Journey.newInvalid', { count: value.impact.newInvalid ?? 0 })}</span>
        </Space>
      )}
      {value.counts && !Array.isArray(value.counts) && (
        <Space wrap>
          {Object.entries(value.counts).map(([key, n]) => (
            <span key={key}>
              {t('Journey.outcome.' + key)} {String(n)}
            </span>
          ))}
        </Space>
      )}
      {items.slice(0, 20).map((item: any, i: number) => {
        const id = item.id ?? item.subject?.id ?? item.write?.subject?.id,
          field = pack.definitions.find(d => d.key === (item.tagKey ?? item.write?.tagKey));
        return (
          <div className="operation-preview-row" key={id ?? i}>
            <strong>
              {item.presentation?.title ??
                item.title ??
                (field ? localize(field.label, app.locale, pack) : t('Journey.itemNumber', { number: i + 1 }))}
            </strong>
            {field && (
              <Space>
                <TagValue definition={field} value={item.before} />
                <span aria-hidden="true">→</span>
                <TagValue definition={field} value={item.after ?? item.value ?? item.write?.value} />
              </Space>
            )}
            {id &&
              (item.presentation ||
                item.facts ||
                item.subject?.kind === 'film' ||
                item.write?.subject?.kind === 'film') && (
                <Button
                  size="S"
                  theme="borderless"
                  onClick={() =>
                    action(async () => {
                      const { film } = await call<any>('film.get', { id });
                      app.open({
                        id: 'film:' + id,
                        kind: 'film',
                        title: film.presentation.tabTitle,
                        params: { filmId: id },
                      });
                    })
                  }
                >
                  {t('LibraryPage.film')}
                </Button>
              )}
          </div>
        );
      })}
    </div>
  );
}
