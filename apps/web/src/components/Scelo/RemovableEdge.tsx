// Custom React Flow edge that exposes a one-click delete affordance at
// its midpoint. The line itself uses `BaseEdge` so colour / animation /
// dashed strokes etc. inherit from the parent's `style` prop — nothing
// changes in how edges look at rest. A small `×` floats over the
// midpoint at low opacity by default and brightens on hover; clicking
// it drops the edge from the flow.
//
// Keyboard delete still works (Backspace / Delete on a selected edge,
// wired in ReactFlow's `deleteKeyCode` prop), but the actuary doesn't
// need to discover that — the inline × is the obvious path.

import type { MouseEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useReactFlow,
} from "reactflow";

export function RemovableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  label,
  labelStyle,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const { setEdges } = useReactFlow();

  const remove = (e: MouseEvent) => {
    e.stopPropagation();
    setEdges((eds) => eds.filter((ed) => ed.id !== id));
  };

  // Tint the × button using the edge's stroke colour so it matches the
  // edge family (reserving green, climate amber, etc). Falls back to a
  // neutral border colour when the edge has no inline stroke.
  const strokeColor = typeof style?.stroke === "string" ? style.stroke : "rgb(var(--rgb-fg-dim))";

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        {/* The wrapper carries `pointer-events: auto` so the × inside it
            can be clicked. Without it, React Flow's edge label layer is
            click-through by default. */}
        <div
          className="group pointer-events-auto absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
        >
          {label != null && label !== "" && (
            // React Flow's `labelStyle` / `labelBgStyle` props were
            // designed for SVG `<text>` / `<rect>` rendering, so they
            // use `fill` / `fillOpacity` — neither of which paints an
            // HTML span. Map `labelStyle.fill` → CSS `color`, and lay a
            // fully-opaque `bg-bg` backing under the text so the
            // animated dashed stroke beneath it stops being visible
            // through the label (same trick as the × button).
            <span className="relative inline-flex items-center">
              <span aria-hidden className="absolute inset-0 rounded bg-bg" />
              <span
                className="relative rounded px-1 py-0.5 font-mono text-[9px] leading-none"
                style={{
                  color: typeof labelStyle?.fill === "string" ? labelStyle.fill : undefined,
                  fontFamily: labelStyle?.fontFamily,
                  fontSize: labelStyle?.fontSize,
                }}
              >
                {label}
              </span>
            </span>
          )}
          {/* The disc has two layers: a fully-opaque `bg-bg` backing that
              masks the animated dashed stroke underneath, plus the
              interactive button on top with its own subtle 0.55 opacity for
              the border + × glyph. Putting the opacity on the *button* (not
              the backing) keeps the canvas-coloured mask solid so the
              moving dashes don't bleed through. */}
          <span aria-hidden className="relative inline-flex h-4 w-4">
            <span aria-hidden className="absolute inset-0 rounded-full bg-bg" />
            <button
              type="button"
              onClick={remove}
              title="disconnect — click to remove this edge"
              aria-label="remove edge"
              className="relative flex h-4 w-4 items-center justify-center rounded-full border font-mono text-[10px] leading-none transition hover:border-error hover:bg-error/15 hover:text-error"
              style={{
                borderColor: strokeColor,
                color: strokeColor,
                opacity: 0.55,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.opacity = "1";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.opacity = "0.55";
              }}
            >
              ×
            </button>
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
