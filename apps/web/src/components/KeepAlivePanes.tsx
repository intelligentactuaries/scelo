// Lazy-mount + keep-alive helper for tab-style panel switches.
//
// Same pattern as DashboardsShell, but driven by a local `active` key
// instead of the URL. A pane is mounted the first time it becomes active,
// then stays mounted (hidden via `display: none`) for the lifetime of the
// parent so its useState and any computed chart specs survive tab
// switches. Unvisited panes stay unmounted so we don't pay their init
// cost until the user actually opens them.

import { type ReactNode, useEffect, useState } from "react";

export type Pane = {
  // Stable key — must match the value `active` will take when this pane
  // should be visible. Also used as React key and visited-set token.
  key: string;
  render: () => ReactNode;
};

type Props = {
  active: string;
  panes: readonly Pane[];
  className?: string;
};

export function KeepAlivePanes({ active, panes, className }: Props) {
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active]));
  useEffect(() => {
    setVisited((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  return (
    // `relative` anchors the absolutely-positioned panes; `min-h-0` lets the
    // container shrink inside a flex/grid parent so children with their own
    // `h-full` layout fill exactly the available height.
    <div className={`relative min-h-0 ${className ?? ""}`}>
      {panes
        .filter((p) => visited.has(p.key))
        .map((p) => {
          const isActive = p.key === active;
          return (
            <div
              key={p.key}
              className="absolute inset-0"
              // ECharts auto-resizes via ResizeObserver when the pane goes
              // from 0×0 (display:none) back to its real size, so charts
              // re-fit themselves on re-show without manual intervention.
              style={{ display: isActive ? "block" : "none" }}
              aria-hidden={!isActive}
            >
              {p.render()}
            </div>
          );
        })}
    </div>
  );
}
