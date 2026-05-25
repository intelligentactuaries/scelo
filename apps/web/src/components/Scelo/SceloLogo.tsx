// Scelo logo / mark.
//
// One concept : the soft → tools → hard pipeline that Scelo IS. Three
// nodes on a horizontal axis :
//   * Left hollow disc      = soft data (uncommitted)
//   * Middle ring + core    = tools / the brain layer (the "lens" that
//                              focuses soft into hard)
//   * Right hollow disc     = hard data (board-pack-ready)
// Connected by two hairlines so the directionality is implicit.
//
// Follows the website_v2 ICONOGRAPHY spec verbatim :
//   * 64x64 viewBox
//   * fill="none", stroke="currentColor", strokeWidth=1.5
//   * round caps + joins
//   * no fills, no shadows, no gradients
//   * inherits its colour from the parent's currentColor so it themes
//     light/dark for free.
//
// Use with Tailwind size utilities, eg :
//   <SceloLogo className="h-6 w-6 text-fg" />

export function SceloLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Scelo"
      className={className}
    >
      {/* Soft : hollow disc, small. */}
      <circle cx={12} cy={32} r={5} />

      {/* Edge soft → tools (gap to nodes on both ends). */}
      <path d="M18 32h6" />

      {/* Tools / brain layer : outer ring + inner core. The two
       *  concentric circles read as a lens; one stroke, no fill, the
       *  inner ring's smaller radius makes it feel like a focused
       *  pupil rather than a target. */}
      <circle cx={32} cy={32} r={9} />
      <circle cx={32} cy={32} r={3} />

      {/* Edge tools → hard. */}
      <path d="M40 32h6" />

      {/* Hard : hollow disc, small. */}
      <circle cx={52} cy={32} r={5} />
    </svg>
  );
}
