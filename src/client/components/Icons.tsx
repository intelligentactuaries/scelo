// Small inline SVG icons. Stroke-based, currentColor, single-concept
// per mark — matching the recipe in website_v2/src/components/
// ICONOGRAPHY.md so the swarm chrome reads as a sibling of the public
// site. Inline React SVG (no `<img>`) so each mark inherits theme
// colour via `stroke="currentColor"`.
//
// Sized in px (default 16) so they inherit a row's font-size naturally
// when set with width:1em from CSS; pass `size` to override. We keep a
// 24×24 viewBox here (rather than the website's 64×64) because these
// are body-level inline glyphs, not chrome marks — the geometry is the
// same recipe, just at a smaller working canvas.
import type { ReactNode } from 'react';

type IconProps = {
  size?: number;
  className?: string;
};

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Lucide "panel-left" — rectangle with a vertical divider near the left edge.
export function PanelLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <line x1="9" x2="9" y1="3" y2="21" />
    </Svg>
  );
}

// Lucide "users" — for Subset (number of council agents).
export function UsersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

// Lucide "sliders-horizontal" — for Run controls (toggles).
export function SlidersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </Svg>
  );
}

// Lucide "globe" — for Society parameter (population-wide knobs).
export function GlobeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </Svg>
  );
}

// Lucide "wallet" — for Income mix.
export function WalletIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" />
      <path d="M4 6v12c0 1.1.9 2 2 2h14v-4" />
      <path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z" />
    </Svg>
  );
}

// Lucide "graduation-cap" — for Education mix.
export function GraduationCapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c3 3 9 3 12 0v-5" />
    </Svg>
  );
}

// Lucide "briefcase" — for Employment mix.
export function BriefcaseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </Svg>
  );
}

// Lucide "flag" — for Culture (national/regional flavour).
export function FlagIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" x2="4" y1="22" y2="15" />
    </Svg>
  );
}

// Lucide "server" — for Providers.
export function ServerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </Svg>
  );
}

// Lucide "settings-2" — the single glyph the eight setup controls fold into.
// Sliders read as "things you adjust", which is what every one of them is.
export function ToolsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </Svg>
  );
}
