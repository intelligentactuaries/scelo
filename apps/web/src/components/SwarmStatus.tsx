// Shared swarm liveness: one probe hook + one nav affordance, so every
// surface that links to /swarm (welcome, workspace header, dashboards bar,
// Hard Data's council CTA) agrees on whether the swarm is actually up.
//
// The probe hits the API base (:3010) — the thing that matters for a
// council — with a no-cors fetch: an ERR_CONNECTION_REFUSED throws, any
// HTTP response (200/404/…) resolves. Re-probes every 5s while mounted,
// matching the SwarmPanel's cadence.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { swarmApiUrl } from "./Scelo/forecast/councilClient";

export type SwarmProbe = "probing" | "up" | "down";

const PROBE_TIMEOUT_MS = 800;
const PROBE_INTERVAL_MS = 5_000;

export function useSwarmProbe(): SwarmProbe {
  const [probe, setProbe] = useState<SwarmProbe>("probing");
  useEffect(() => {
    let cancelled = false;
    const base = swarmApiUrl();
    const ping = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        await fetch(base, { mode: "no-cors", signal: ctrl.signal });
        clearTimeout(t);
        if (!cancelled) setProbe("up");
      } catch {
        if (!cancelled) setProbe("down");
      }
    };
    void ping();
    const id = window.setInterval(ping, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return probe;
}

/** Compact "swarm" nav button with a liveness pip — drop-in beside the
 *  other ia-btn-ghost header links. Green pip + "live" once the swarm
 *  server answers on :3010, so a running deliberation is one click away
 *  from anywhere. */
export function SwarmNavLink({ className }: { className?: string }) {
  const probe = useSwarmProbe();
  return (
    <Link
      to="/swarm"
      className={`ia-btn ia-btn-sm ia-btn-ghost inline-flex items-center gap-1.5 ${className ?? ""}`}
      title={
        probe === "up"
          ? "Swarm server is live on :3010 — open the deliberation view"
          : "Open the Swarm view (server not detected on :3010 — it shows start instructions)"
      }
    >
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          probe === "up" ? "bg-primary" : "bg-fg-dim"
        } ${probe === "probing" ? "animate-pulse" : ""}`}
      />
      swarm
      {probe === "up" && <span className="font-mono text-[9px] text-primary">live</span>}
    </Link>
  );
}
