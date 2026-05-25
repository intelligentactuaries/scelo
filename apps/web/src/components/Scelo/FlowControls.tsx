// Shared canvas controls for every React Flow surface in Scelo
// (macro brain layer, Tools workstation, Hard data workstation).
// Replaces the default React Flow `<Controls>` cluster (white
// +/-/fit box) with a small bottom-right cluster of single-stroke
// icon buttons so the affordance doesn't look like a vendor lockup.
//
// Iconography: 16x16, stroke=currentColor, 1.5 width, round caps +
// joins (same recipe as the "Open in swarm" / "Back to Scelo" CTAs
// and the website_v2 spec).

import type { ReactNode } from "react";
import { useReactFlow } from "reactflow";

export function FlowControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <div
      className="pointer-events-auto absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded border border-border bg-bg-2 p-1 shadow-sm"
      role="toolbar"
      aria-label="Canvas controls"
    >
      <CtrlButton title="Zoom in" onClick={() => zoomIn({ duration: 200 })}>
        <PlusIcon />
      </CtrlButton>
      <CtrlButton title="Zoom out" onClick={() => zoomOut({ duration: 200 })}>
        <MinusIcon />
      </CtrlButton>
      <CtrlButton
        title="Recenter on all nodes"
        onClick={() => fitView({ padding: 0.2, duration: 250 })}
      >
        <RecenterIcon />
      </CtrlButton>
    </div>
  );
}

function CtrlButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded p-1 text-fg-mute transition hover:bg-bg-1 hover:text-fg"
    >
      {children}
    </button>
  );
}

const svgProps = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  className: "h-3.5 w-3.5",
} as const;

function PlusIcon() {
  return (
    <svg {...svgProps}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg {...svgProps}>
      <path d="M3 8h10" />
    </svg>
  );
}

/** "Recenter" mark : four corner crosshair brackets converging on a
 *  small centre dot. Reads as "fit + focus" without copying the
 *  React Flow corner-brackets icon literally. */
function RecenterIcon() {
  return (
    <svg {...svgProps}>
      <path d="M3 5V3h2" />
      <path d="M11 3h2v2" />
      <path d="M13 11v2h-2" />
      <path d="M5 13H3v-2" />
      <circle cx={8} cy={8} r={1} />
    </svg>
  );
}
