// Layout wrapper for /dashboards/*. In this repository (the Scelo
// public face) only the Scelo brain layer is shipped — the wider
// specialist roster (Reserving, Mortality, Pensions, Pricing,
// Climate, Capital, Regulatory, Wiki, Documentation, Runs, Agents,
// SurvivalEcosystem, Charts) lives in the broader Intelligent
// Actuaries workbench and is not bundled here.
//
// Any `/dashboards/*` URL that isn't `/dashboards/scelo` is rewritten
// to `/dashboards/scelo`, then we render the Scelo brain layer as
// a permanent panel under a slim back-bar. The lazy-mount + keep-
// alive machinery from the monorepo is dropped here because there's
// only one dashboard to mount.

import { Arrow } from "@/components/Arrow";
import { SwarmNavLink } from "@/components/SwarmStatus";
import { isDesktopIDE } from "@/lib/sceloIDE";
import Scelo from "@/routes/Scelo";
import { Link, Navigate, useLocation } from "react-router-dom";

export default function DashboardsShell() {
  const { pathname } = useLocation();
  const sub = pathname.replace(/^\/dashboards\/?/, "").replace(/\/$/, "");

  // Anything but scelo (including the bare /dashboards index) → forward.
  if (sub !== "scelo" && !sub.startsWith("scelo/")) {
    return <Navigate to="/dashboards/scelo" replace />;
  }

  // In the IDE this leads back to the welcome screen, where a workspace is
  // opened or a sample scaffolded.
  const desktop = isDesktopIDE();
  const target = desktop ? "/welcome" : "/";
  const label = desktop ? "get started" : "back to chat";

  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-1.5 text-xs">
        <Link to={target} className="font-mono text-fg-mute hover:text-primary">
          <Arrow dir="left" /> {label}
        </Link>
        {/* right-aligned so a live deliberation is one click away from any
            stage — soft, tools, or hard. */}
        <SwarmNavLink className="ml-auto" />
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">
        <Scelo />
      </div>
    </div>
  );
}
