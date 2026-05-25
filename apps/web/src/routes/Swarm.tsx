// /swarm — full-window swarm-council surface. The swarm is a real
// dashboard (256-agent council + 1000-agent society), not a sidebar
// tab : it deserves the whole viewport. A slim top bar gives a
// prominent back-to-scelo CTA + minor nav links; the rest of the
// viewport is the in-repo Scelo-integrated swarm UI iframed from
// localhost:5190.

import { Link } from "react-router-dom";
import SwarmPanel from "../components/workspace/SwarmPanel";
import { isDesktopIDE } from "../lib/sceloIDE";

export default function Swarm() {
  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-bg-2 px-4 py-2 text-xs">
        <div className="flex items-center gap-3">
          <BackToSceloButton />
          <span className="uppercase tracking-wider text-fg-mute">
            scelo ide · swarm
          </span>
        </div>
        <nav className="flex items-center gap-1">
          {isDesktopIDE() ? (
            <Link to="/workspace" className="ia-btn ia-btn-sm ia-btn-ghost">
              workspace
            </Link>
          ) : (
            <Link to="/" className="ia-btn ia-btn-sm ia-btn-ghost">
              chat
            </Link>
          )}
          <Link to="/settings/ai" className="ia-btn ia-btn-sm ia-btn-ghost">
            settings
          </Link>
        </nav>
      </header>
      <div className="flex-1 min-h-0">
        <SwarmPanel />
      </div>
    </div>
  );
}

/** Mirror of HardDataWorkstation's "Open in swarm" button : same
 *  visual weight + minimalist single-stroke icon, but pointing the
 *  other way. /dashboards/scelo specifically (not navigate(-1)) so
 *  the round-trip is symmetrical regardless of how the user reached
 *  /swarm. */
function BackToSceloButton() {
  return (
    <Link
      to="/dashboards/scelo"
      title="Back to the Scelo brain layer"
      className="group flex items-center gap-2 rounded border border-border bg-bg-1 px-3 py-1.5 text-xs text-fg transition hover:border-primary hover:bg-bg"
    >
      <EnteringSquareIcon className="h-4 w-4 text-fg-mute group-hover:text-primary" />
      <span className="font-medium">Back to Scelo</span>
    </Link>
  );
}

/** 16×16 "enter the square" mark : the mirror of the
 *  "open in new" icon on the Hard Data side. An arrow on the left
 *  flying INTO a square on the right. Single-stroke, currentColor,
 *  1.5 width, round joins — matches the iconography spec. */
function EnteringSquareIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* Square on the right (the "to" — Scelo). */}
      <path d="M13 7.5v5a1 1 0 0 1-1 1H7" />
      {/* Arrow on the left pointing into the square. */}
      <path d="M7 3H3v4" />
      <path d="M3 3l6 6" />
    </svg>
  );
}
