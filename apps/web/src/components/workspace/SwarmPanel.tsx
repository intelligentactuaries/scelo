// Swarm view — iframes the swarm app that lives in this repo at
// apps/swarm (dev port 5190, api on 3010 per its vite proxy). It is
// part of Scelo but is NOT (yet) bundled into the installer: it's a
// Bun + Vite dev pair the user starts from a Scelo checkout with
// `bun run dev:swarm`, so we can't assume it's up.
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
import { getLastSwarmRequest, subscribeOpenInSwarm, urlFor } from "../../lib/swarmBus";
import { emitToast } from "../../lib/toastBus";
import { SwarmLiveDot } from "../SwarmLiveDot";

// The swarm's Vite dev URL — derived from swarmBus's canonical
// constant so the probe, the iframe, and every surface that
// advertises the port agree on one value.
const SWARM_URL = urlFor({});
const PROBE_TIMEOUT_MS = 800;

// User manual page for starting the swarm (docs hub serves the manual
// under /scelo/; source: docs/docs/swarm/running.md).
export const SWARM_DOCS_URL = "https://docs.intelligentactuaries.com/scelo/swarm/running/";

/** The start command for the swarm — one string for every OS and
 *  shell. It's a root script of the Scelo repo (`bun run dev:swarm` →
 *  apps/swarm's cross-platform dev spawner), and the swarm's api
 *  defaults to 3010, so there is no PORT= / $env:PORT prefix to get
 *  wrong. Deliberately has no `cd`: we can't know where the user's
 *  Scelo checkout is, so the surrounding copy says "from a Scelo
 *  checkout". Exported for SimulateScenarioModal's error hint,
 *  HardDataWorkstation, and tests. */
export const SWARM_START_COMMAND = "bun run dev:swarm";
export function swarmStartCommand(): string {
  return SWARM_START_COMMAND;
}

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
  useEffect(() => subscribeOpenInSwarm((r) => setIframeUrl(urlFor(r))), []);

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
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">swarm</span>
        {/* A lit LED carries the state — glowing green for a live swarm,
            red for none, a hollow pulsing ring while probing — so life
            reads at a glance; the word stays muted like the rest of the
            header. */}
        <span
          className="inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-mute"
          title={SWARM_URL}
        >
          <SwarmLiveDot probe={probe} />
          {probe === "up" && "live"}
          {probe === "probing" && "probing…"}
          {probe === "down" && "offline"}
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
  const startCmd = swarmStartCommand();
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="max-w-sm space-y-3 text-center text-xs">
        <p className="text-fg">Swarm server isn't running.</p>
        <p className="text-fg-mute">
          The swarm is part of Scelo (<span className="font-mono">apps/swarm</span> in the repo) but
          is not bundled into the installer yet, so start it from a Scelo checkout — one{" "}
          <span className="font-mono">bun install</span>, then the command below, on any OS. It
          starts a Vite + Bun pair on <span className="font-mono">localhost:5190</span> (api on{" "}
          <span className="font-mono">3010</span>). Start it once and this panel will live-attach on
          the next probe.
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
          The panel re-probes every 5 seconds : leave this tab open while you start the server. Full
          instructions:{" "}
          <a
            href={SWARM_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-fg underline hover:text-primary"
          >
            docs: swarm/running
          </a>
          .
        </p>
      </div>
    </div>
  );
}
