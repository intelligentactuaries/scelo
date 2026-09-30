// The IDE's arrows. Any arrow in running text is SN Pro's own glyph (theme.css
// adds SN Pro's Arrows block to the family). <Arrow> is the affordance form
// for links and buttons ("open →", "← macro view"): a weight heavier than its
// label so it reads at a glance, and it leans the way it points on hover.
// <EnterKey> is the return arrow SN Pro doesn't draw, stroked to match.

const GLYPH = {
  right: "→",
  left: "←",
  up: "↑",
  down: "↓",
  "up-right": "↗",
} as const;

export type ArrowDir = keyof typeof GLYPH;

export function Arrow({ dir = "right", className }: { dir?: ArrowDir; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-dir={dir}
      className={className ? `ia-arrow ${className}` : "ia-arrow"}
    >
      {GLYPH[dir]}
    </span>
  );
}

export function EnterKey({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M19 5v6.5a3 3 0 0 1-3 3H5.5" />
      <path d="M9.5 10 5 14.5 9.5 19" />
    </svg>
  );
}
