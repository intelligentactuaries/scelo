// Resizable + collapsible side-panel wrapper.
//
// Wraps any of the workstation asides (column summary, model details,
// result details, chat) so the actuary can drag the inner edge to set
// the width and collapse it down to a thin rail. Defaults match the
// original w-72 / w-96 layouts so nothing visually changes at first
// render.
//
// Collapse and expand are always visible — a panel-toggle icon in the
// header corner when open, the same icon heading the rail when shut —
// and animate like a drawer: the width eases (Cursor's out-quint, 240 ms)
// while the content, held at its full width and pinned to the moving
// inner edge, slides out past the outer edge and fades, instead of
// re-wrapping at every intermediate width. The main canvas beside it
// widens smoothly as the panel goes.
//
// State is intentionally in-memory (per-session). Users who want
// permanent layouts can drag once and the choice survives flips
// between sub-routes via the parent's render lifecycle, but it
// doesn't persist across reloads — keeps the system simple, no
// localStorage bookkeeping, and avoids "I lost my layout when I
// upgraded" surprise.

import { type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

export type ResizableSide = "left" | "right";

/** Drawer timing — width and content move together. */
const DRAWER_MS = 240;

type Phase = "open" | "closing" | "closed" | "opening";

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Panel-toggle mark: a window with its side panel on `side`, filled while
 *  the panel is showing — the same idiom as Cursor's layout toggles. */
function PanelToggleIcon({ side, open }: { side: ResizableSide; open: boolean }) {
  const divider = side === "right" ? 10 : 6;
  const pane = side === "right" ? { x: 10, w: 3.25 } : { x: 2.75, w: 3.25 };
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <rect x="2" y="3" width="12" height="10" rx="2" />
      {open && (
        <rect
          x={pane.x}
          y={3.75}
          width={pane.w}
          height={8.5}
          rx={0.6}
          fill="currentColor"
          stroke="none"
          opacity={0.35}
        />
      )}
      <path d={`M${divider} 3.5v9`} />
    </svg>
  );
}

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
  /** Extra classes on the inner content wrapper (e.g. `overflow-auto`).
   *
   *  Contract when you pass a scrolling class: the wrapper is a flex column,
   *  and flexbox shrinks items to fit BEFORE a container scrolls — so every
   *  direct child must carry `shrink-0`, or it will be compressed instead of
   *  scrolled. Children that also set `overflow-hidden` are the dangerous
   *  case: CSS drops their automatic minimum height to 0, so they can be
   *  squashed to nothing (this is what sliced the Soft Data column-summary
   *  header in half). */
  innerClassName?: string;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const [phase, setPhase] = useState<Phase>("open");
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const timerRef = useRef<number | null>(null);

  const isRight = side === "right";

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // Collapse / expand: flip to the travelling phase now, land it once the
  // drawer has finished moving. With reduced motion, land immediately.
  const travel = useCallback((via: Phase, to: Phase) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (reducedMotion()) {
      setPhase(to);
      return;
    }
    setPhase(via);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setPhase(to);
    }, DRAWER_MS);
  }, []);
  const collapse = useCallback(() => travel("closing", "closed"), [travel]);
  const expand = useCallback(() => travel("opening", "open"), [travel]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
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
    setDragging(false);
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  }, []);

  const borderEdge = isRight ? "border-l" : "border-r";
  const shut = phase === "closing" || phase === "closed";
  const travelling = phase === "closing" || phase === "opening";

  return (
    <aside
      style={{
        width: shut ? collapsedWidth : width,
        // The drawer eases; a drag must track the pointer exactly.
        transition: dragging ? "none" : `width ${DRAWER_MS}ms var(--ease-out)`,
      }}
      className={`relative flex shrink-0 flex-col overflow-hidden ${borderEdge} border-border bg-bg-1`}
    >
      {phase === "closed" ? (
        // ── COLLAPSED — a thin rail: the expand toggle on top, the panel's
        //    name running down it. The whole rail expands on click.
        <button
          type="button"
          onClick={expand}
          className="ia-view-in group flex h-full w-full flex-col items-center gap-3 py-2 transition-colors duration-150 hover:bg-bg-2/70"
          title={`Expand ${badge}`}
          aria-label={`Expand ${badge}`}
          aria-expanded={false}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md text-fg-mute transition-colors duration-150 group-hover:bg-bg-2 group-hover:text-fg">
            <PanelToggleIcon side={side} open={false} />
          </span>
          <span
            className={`font-mono text-[9px] uppercase tracking-[0.18em] ${accentClass} opacity-80 transition-opacity duration-150 group-hover:opacity-100`}
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            {badge}
          </span>
        </button>
      ) : (
        <>
          {/* Drag handle — full-height strip on the inner edge; a hairline
              of the primary colour lights up while hovered or dragged. */}
          {!travelling && (
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => setWidth(defaultWidth)}
              style={isRight ? { left: 0 } : { right: 0 }}
              className={`absolute inset-y-0 z-20 w-1 cursor-col-resize transition-colors duration-150 ${
                dragging ? "bg-primary/60" : "bg-transparent hover:bg-primary/40"
              }`}
              title="drag to resize · double-click to reset"
            />
          )}
          {/* Collapse toggle — in the header corner (headers leave pl-8 /
              pr-8 for it), visible at rest, brighter on hover. */}
          <button
            type="button"
            onClick={collapse}
            style={isRight ? { left: 6 } : { right: 6 }}
            className="absolute top-1.5 z-30 flex h-5 w-5 items-center justify-center rounded-md text-fg-mute transition-colors duration-150 hover:bg-bg-2 hover:text-fg"
            title={`Collapse ${badge}`}
            aria-label={`Collapse ${badge}`}
            aria-expanded={true}
          >
            <PanelToggleIcon side={side} open={true} />
          </button>
          {/* While travelling, the content keeps its full width pinned to
              the outer edge (the drawer covers it rather than squeezing it)
              and fades; at rest it is back in normal flow. */}
          <div
            className={`flex min-h-0 flex-1 flex-col ${innerClassName ?? ""} ${
              phase === "opening" ? "ia-drawer-in" : ""
            }`}
            style={
              travelling
                ? {
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    width,
                    // Pinned to the moving (inner) edge, so the content
                    // slides with it and is clipped at the outer edge.
                    ...(isRight ? { left: 0 } : { right: 0 }),
                    opacity: phase === "closing" ? 0 : 1,
                    transition: `opacity ${phase === "closing" ? 140 : DRAWER_MS}ms ease`,
                  }
                : undefined
            }
          >
            {children}
          </div>
        </>
      )}
    </aside>
  );
}
