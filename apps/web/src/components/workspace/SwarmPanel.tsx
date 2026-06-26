// Swarm view — iframes the in-repo, Scelo-integrated swarm app at
// intelligentactuaries/swarms/ (dev port 5190, api on 3010 per its
// vite proxy). The canonical app at /home/adu-00/ali/swarm-council
// is the upstream reference; this fork adds Scelo surfaces
// (ForecastCanvas, SimulationView, WmtrStrip, theme.ts) so it's
// what we point at.
// On mount we probe the server; if it isn't running we show a
// copy-pasteable start command instead of a blank
// ERR_CONNECTION_REFUSED iframe.
//
// Why iframe instead of porting the swarm UI : it's a self-contained
// app with its own routing, state, and websocket lifecycle. Embedding
// keeps one canonical implementation (per the swarm README, "no
// council code is duplicated into Scelo"). The iframe inherits the
// workspace's window size, and the swarm app already speaks SSE for
// progress.

import { useEffect, useState } from "react";
import {
  getLastSwarmRequest,
  subscribeOpenInSwarm,
  urlFor,
} from "../../lib/swarmBus";
import { emitToast } from "../../lib/toastBus";

// In-repo Scelo-integrated swarm fork's Vite dev port.
const SWARM_URL = "http://localhost:5190";
const PROBE_TIMEOUT_MS = 800;

type Probe = "probing" | "up" | "down";

export default function SwarmPanel() {
  const [probe, setProbe] = useState<Probe>("probing");
  // The iframe src defaults to the swarm root, but the openInSwarm bus
  // can point it at a run-specific URL (Hard Data's "open in swarm"
  // link). Persists across re-mounts via the bus's lastRequest cache.
  const [iframeUrl, setIframeUrl] = useState<string>(() => {
    const last = getLastSwarmRequest();
    return last ? urlFor(last) : SWARM_URL;
  });
  useEffect(
    () => subscribeOpenInSwarm((r) => setIframeUrl(urlFor(r))),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        // no-cors so the dev server doesn't need CORS headers : we
        // only care that the socket accepted a connection. An
        // ERR_CONNECTION_REFUSED throws; a 200/404/anything resolves.
        await fetch(SWARM_URL, { mode: "no-cors", signal: ctrl.signal });
        clearTimeout(t);
        if (!cancelled) setProbe("up");
      } catch {
        if (!cancelled) setProbe("down");
      }
    };
    void ping();
    const id = window.setInterval(ping, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex shrink-0 items-baseline justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          swarm
        </span>
        <span className="font-mono text-[10px] text-fg-mute" title={SWARM_URL}>
          {probe === "up" && "● live"}
          {probe === "probing" && "○ probing…"}
          {probe === "down" && "● offline"}
        </span>
      </div>
      {probe === "up" ? (
        <iframe
          src={iframeUrl}
          title="swarm council"
          className="flex-1 border-0 bg-bg"
          // Same-origin iframes work fine for localhost; the swarm app
          // doesn't render inside a frame elsewhere so we don't need to
          // set frame-ancestors.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      ) : (
        <OfflineFallback />
      )}
    </div>
  );
}

function OfflineFallback() {
  const startCmd = "cd ~/ali/intelligentactuaries/swarms && PORT=3010 bun run dev";
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-sm space-y-3 text-center text-xs">
        <p className="text-fg">Swarm server isn't running.</p>
        <p className="text-fg-mute">
          The Scelo-integrated swarm lives in the{" "}
          <span className="font-mono">intelligentactuaries/swarms</span> repo and runs its own
          Vite + Bun pair on <span className="font-mono">localhost:5190</span> (api on{" "}
          <span className="font-mono">3010</span>). The <span className="font-mono">PORT=3010</span>{" "}
          is required — its default is 3000. Start it once and this panel will live-attach on the
          next probe.
        </p>
        <pre className="rounded border border-border bg-bg p-2 text-left font-mono text-[11px] text-fg">
          {startCmd}
        </pre>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(startCmd);
              emitToast("Copied start command.", "success");
            } catch {
              emitToast("Copy failed; type it manually.", "error");
            }
          }}
          className="ia-btn ia-btn-md ia-btn-secondary"
        >
          copy command
        </button>
        <p className="text-fg-mute">
          The panel re-probes every 5 seconds : leave this tab open while
          you start the server.
        </p>
      </div>
    </div>
  );
}
