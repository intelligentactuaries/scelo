// The swarm liveness LED. One component for the four places the IDE says
// whether the swarm server answers on :3010 — the workspace swarm panel's
// badge, the header "swarm" nav link, the Welcome "Open the Swarm" card and
// Hard Data's council box — so they all light the same way: green and
// glowing when live, red when offline, a hollow pulsing ring while the
// first probe is still in flight. Styles live in theme.css (.ia-led-*) so
// the colours follow the light/dark tokens.

import type { SwarmProbe } from "./SwarmStatus";

/** Pure class mapper — exported so the state → look contract is testable
 *  without rendering. */
export function swarmLedClass(probe: SwarmProbe): string {
  switch (probe) {
    case "up":
      return "ia-led ia-led-live";
    case "down":
      return "ia-led ia-led-down";
    default:
      return "ia-led ia-led-probing";
  }
}

/** Human label for the state, for titles / screen readers. */
export function swarmLedLabel(probe: SwarmProbe): string {
  switch (probe) {
    case "up":
      return "swarm live";
    case "down":
      return "swarm offline";
    default:
      return "probing swarm…";
  }
}

export function SwarmLiveDot({ probe, className }: { probe: SwarmProbe; className?: string }) {
  return (
    <span
      role="img"
      aria-label={swarmLedLabel(probe)}
      className={`${swarmLedClass(probe)} ${className ?? ""}`.trim()}
    />
  );
}
