import type { LocalizedText } from './types';
import { Fragment, type ReactNode } from 'react';
import { Button, Space } from '../ui';
import { t } from '../i18n';
import { useApp } from '../context';
import { LayoutFrame, placements } from './LayoutFrame';
import { localize, ui } from './i18n';
import { TagInput, TagValue } from './Inputs';
import { previewValue } from './preview-context';
import type { LayoutNode, TagPackage, Scope } from './types';
import { RibbonLayout } from './RibbonLayout';
import { PageToolbarContext } from '../components/page-toolbar-context';
import capabilities from '../../../../resources/tagging/host-capabilities.json';

/** Isolated preview: never mounts Surface's editor, commands or media loader. */
export function PreviewSurface({
  root,
  catalog,
  currentKey,
  region,
  field,
}: {
  root: LayoutNode;
  catalog: TagPackage;
  currentKey: string;
  region: string;
  field: ReactNode;
}) {
  const app = useApp(),
    text = (value: LocalizedText | undefined) => localize(value, app.locale, catalog);
  const targets = catalog.definitions.find(d => d.key === currentKey)?.targets ?? [];
  const scope: Scope = targets.includes('film-whole')
    ? { kind: 'whole' }
    : targets.includes('film-point')
      ? { kind: 'point', startUs: '0' }
      : { kind: 'interval', startUs: '0', endUs: '1000000' };
  const render = (node: LayoutNode): ReactNode => {
    if (node.type === 'activity-feed')
      return (
        <section className="activity-suggestion">
          <h3>{text(node.title) || t('Activity.title')}</h3>
          <p className="form-help">{t('Activity.catalog')}</p>
          <p>{t('Activity.empty')}</p>
        </section>
      );
    if (node.type === 'ribbon')
      return (
        <RibbonLayout
          node={node}
          text={text}
          heading={node.binding ? <h1>{t('Journey.previewFilm')}</h1> : undefined}
          action={key => (
            <Button key={key} disabled>
              {text(catalog.ui.actions[key]?.label)}
            </Button>
          )}
          control={binding => (
            <span className="form-help">
              {text(capabilities.$defs.layoutControl.oneOf.find(control => control.const === binding)?.['x-label'])}
            </span>
          )}
        />
      );
    if (['stack', 'grid', 'section', 'disclosure'].includes(node.type))
      return (
        <LayoutFrame node={node} title={text(node.title)}>
          {node.children?.map(child => (
            <div className="schema-node" key={child.id}>
              {render(child)}
            </div>
          ))}
        </LayoutFrame>
      );
    if (node.type === 'identity')
      return (
        <header className="page-heading">
          <h1>{t('Journey.previewFilm')}</h1>
          <Space>
            {node.actions?.map(key => (
              <Button key={key} disabled>
                {text(catalog.ui.actions[key]?.label)}
              </Button>
            ))}
          </Space>
        </header>
      );
    if (['form', 'field-set'].includes(node.type))
      return (
        <section className="schema-fields" data-mode={node.mode} data-commit={node.commitMode}>
          {node.title && <h2>{text(node.title)}</h2>}
          <div className="schema-fields-body">
            <div className="schema-fields-grid">
              {placements(catalog, node.region ?? [], scope).map(({ definition: d, placement: p }) => {
                const active = d.key === currentKey && p.slot === region,
                  value = previewValue(d, catalog, t('DefinitionPreview.exampleText'));
                return (
                  <div
                    key={d.key}
                    className={'schema-field' + (active ? ' preview-active-field' : '')}
                    data-span={['textarea@1', 'asset@1'].includes(d.input.component) ? 'full' : undefined}
                  >
                    <div className="schema-field-label">{text(d.label)}</div>
                    <div className="schema-field-control">
                      {active ? (
                        field
                      ) : node.mode === 'display' ? (
                        <TagValue definition={d} value={value} catalog={catalog} />
                      ) : (
                        <TagInput
                          definition={d}
                          value={value}
                          onChange={() => {}}
                          disabled
                          allowCreate={false}
                          catalog={catalog}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      );
    if (node.type === 'scope-picker')
      return (
        <Space>
          {(node.modes ?? ['whole', 'point', 'interval']).map((key: string) => (
            <Button key={key} disabled>
              {ui(key, app.locale)}
            </Button>
          ))}
        </Space>
      );
    if (['action-bar', 'menu'].includes(node.type))
      return (
        <Space>
          {node.actions?.map(key => (
            <Button key={key} disabled>
              {text(catalog.ui.actions[key]?.label)}
            </Button>
          ))}
        </Space>
      );
    if (['annotation-list', 'timeline'].includes(node.type))
      return (
        <section className="schema-annotations">
          <h3>{text(node.title) || ui('annotations', app.locale)}</h3>
          <p className="muted">{ui('empty', app.locale)}</p>
        </section>
      );
    return node.children?.map(child => <Fragment key={child.id}>{render(child)}</Fragment>) ?? null;
  };
  // Preview commands belong to the preview, never to the configuration editor's page header.
  return (
    <PageToolbarContext.Provider value={undefined}>
      <div className="schema-surface preview-surface">{render(root)}</div>
    </PageToolbarContext.Provider>
  );
}
