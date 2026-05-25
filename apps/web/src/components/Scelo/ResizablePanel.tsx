// Resizable + collapsible side-panel wrapper.
//
// Wraps any of the workstation asides (column summary, model details,
// result details, chat) so the actuary can drag the inner edge to set
// the width and click a tiny chevron in the corner to collapse it down
// to a thin rail. Defaults match the original w-72 / w-96 layouts so
// nothing visually changes at first render — the rail and collapse
// button are only opaque on hover.
//
// State is intentionally in-memory (per-session). Users who want
// permanent layouts can drag once and the choice survives flips
// between sub-routes via the parent's render lifecycle, but it
// doesn't persist across reloads — keeps the system simple, no
// localStorage bookkeeping, and avoids "I lost my layout when I
// upgraded" surprise.

import { type PointerEvent, type ReactNode, useCallback, useRef, useState } from "react";

export type ResizableSide = "left" | "right";

export function ResizablePanel({
  side,
  defaultWidth,
  minWidth = 200,
  maxWidth = 720,
  collapsedWidth = 36,
  badge,
  accentClass = "text-accent-2",
  children,
  innerClassName,
}: {
  /** Which side of the layout the panel sits on. `"right"` puts the
   *  resize handle on the panel's LEFT (innermost) edge; `"left"` puts
   *  it on the right edge. */
  side: ResizableSide;
  /** Initial width in pixels (e.g. 288 for w-72, 384 for w-96). */
  defaultWidth: number;
  /** Lower bound — past this width the panel snaps to expanded-minimum. */
  minWidth?: number;
  maxWidth?: number;
  /** Width of the thin rail shown when collapsed. */
  collapsedWidth?: number;
  /** Short label rendered vertically when the panel is collapsed. */
  badge: string;
  /** Tailwind text-colour class for the rotated badge + accent dot. */
  accentClass?: string;
  children: ReactNode;
  /** Extra classes on the inner content wrapper (e.g. `overflow-auto`). */
  innerClassName?: string;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const isRight = side === "right";

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [width],
  );
  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      // For a right-side panel the resize handle is on the LEFT edge, so
      // dragging left (dx < 0) grows the panel. For a left-side panel it's
      // the opposite — dragging right grows it.
      const delta = isRight ? -dx : dx;
      const next = Math.max(minWidth, Math.min(maxWidth, dragRef.current.startWidth + delta));
      setWidth(next);
    },
    [isRight, minWidth, maxWidth],
  );
  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  }, []);

  const borderEdge = isRight ? "border-l" : "border-r";

  // ── COLLAPSED — a thin clickable rail with the badge rotated vertically.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        style={{ width: collapsedWidth }}
        className={`group flex shrink-0 flex-col items-center justify-between gap-2 ${borderEdge} border-border bg-bg-1 py-3 transition hover:bg-bg-2`}
        title={`Expand ${badge}`}
      >
        <span
          aria-hidden
          className="font-mono text-[11px] text-fg-dim transition group-hover:text-fg-mute"
        >
          {isRight ? "‹" : "›"}
        </span>
        <span
          className={`font-mono text-[9px] uppercase tracking-[0.18em] ${accentClass} opacity-70 group-hover:opacity-100`}
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          {badge}
        </span>
        <span aria-hidden className="text-[11px] text-fg-dim/60">
          ⇆
        </span>
      </button>
    );
  }

  // ── EXPANDED — the panel renders at the user's chosen width with an
  //    invisible 4px hit-target on the inner edge for dragging, and a
  //    barely-visible chevron in the corner for collapsing. Hover both
  //    of them to make them pop without colour-overloading the default
  //    resting state.
  return (
    <aside
      style={{ width }}
      className={`relative flex shrink-0 flex-col overflow-hidden ${borderEdge} border-border bg-bg-1`}
    >
      {/* Drag handle — full-height vertical strip on the inner edge. */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(defaultWidth)}
        style={isRight ? { left: 0 } : { right: 0 }}
        className="absolute inset-y-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-fg-dim/30"
        title="drag to resize · double-click to reset"
      />
      {/* Collapse chevron — small, faint, in the corner above the drag handle. */}
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        style={isRight ? { left: 6 } : { right: 6 }}
        className="absolute top-1.5 z-30 flex h-5 w-5 items-center justify-center rounded border border-border bg-bg-1/80 font-mono text-[10px] leading-none text-fg-dim opacity-50 transition hover:border-fg-dim hover:text-fg-mute hover:opacity-100"
        title={`Collapse ${badge}`}
      >
        {isRight ? "›" : "‹"}
      </button>
      <div className={`flex min-h-0 flex-1 flex-col ${innerClassName ?? ""}`}>{children}</div>
    </aside>
  );
}
