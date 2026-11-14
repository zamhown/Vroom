import { useId, useState, type ReactNode } from 'react';
import { Button } from '../ui';
import { IconChevronDown, IconChevronRight } from '../icons';
import { t } from '../i18n';

/** A workspace pane, outside the settings scroll area. Collapsing preserves trial state. */
export function PreviewDock({ title, children }: { title: string; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false),
    id = useId();
  return (
    <aside className={'designer-preview-dock' + (collapsed ? ' is-collapsed' : '')} aria-label={title}>
      <header className="preview-dock-heading">
        <h3>{title}</h3>
        <span>{t('DefinitionPreview.previewOnly')}</span>
        <Button
          theme="borderless"
          size="S"
          icon={collapsed ? <IconChevronRight /> : <IconChevronDown />}
          aria-label={t(collapsed ? 'DefinitionPreview.expandDock' : 'DefinitionPreview.collapseDock')}
          aria-expanded={!collapsed}
          aria-controls={id}
          onClick={() => setCollapsed(!collapsed)}
        />
      </header>
      <div id={id} className="preview-dock-body" hidden={collapsed}>
        {children}
      </div>
    </aside>
  );
}
