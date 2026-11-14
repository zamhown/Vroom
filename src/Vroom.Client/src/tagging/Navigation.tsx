import { Button } from '../ui';
import { useApp } from '../context';
import type { NavigationItem } from '../WorkspaceNavigation';
import { defaultQuery } from '../types';
import { localize } from './i18n';
import { SchemaIcon, Stars } from './Inputs';
import { placements } from './Surface';
export function useTagNavigation(): NavigationItem[] {
  const app = useApp();
  const pack = app.data.tagging.package;
  return placements(pack, 'nav.after-all-films').flatMap(({ definition: d }) => {
    const nav = d.navigation;
    if (!nav) return [];
    const label = localize(nav.props?.label ?? d.label, app.locale, pack);
    const baseId = 'navigation:' + d.key;
    const open = (where: any, title: string, suffix = '') =>
      app.open({
        id: baseId + suffix,
        kind: 'library',
        title,
        params: {
          query: { ...defaultQuery(), where },
          icon: nav.props?.icon ?? 'Tag',
          navigationKey: d.key,
          selection: suffix,
        } as any,
      });
    if (nav.component === 'rating-band-navigation@1') {
      const facet = d.facets?.[nav.props.facet];
      if (!facet) return [];
      return [
        {
          id: baseId,
          label,
          icon: <SchemaIcon name="Star" />,
          onPress: () => {},
          selected: app.workspace.activeId.startsWith(baseId),
          render: close => (
            <div className="schema-rating-navigation" aria-label={label}>
              <span>{label}</span>
              <div>
                {facet.bands.map((band: any, index: number) => {
                  const title = localize(band.label, app.locale, pack);
                  return (
                    <Button
                      key={band.id}
                      theme="borderless"
                      aria-label={title}
                      aria-pressed={app.workspace.activeId === `${baseId}:${band.id}`}
                      onClick={() => {
                        open(
                          { op: 'facet', tag: d.key, facet: nav.props.facet, selection: band.id },
                          `${label} · ${title}`,
                          ':' + band.id,
                        );
                        close();
                      }}
                    >
                      <Stars value={index + 1} maximum={facet.bands.length} symbols={1} label={title} />
                    </Button>
                  );
                })}
              </div>
            </div>
          ),
        },
      ];
    }
    const where = JSON.parse(JSON.stringify(nav.open.filter).replaceAll('"$self"', JSON.stringify(d.key)));
    return [
      {
        id: baseId,
        label,
        icon: <SchemaIcon name={nav.props?.icon} />,
        onPress: () => open(where, label),
        selected: app.workspace.activeId === baseId,
      },
    ];
  });
}
