// Swarm view — iframes the swarm app that lives in this repo at
// apps/swarm.
//
// Inside the Scelo IDE the swarm is BUNDLED: the main process starts its
// server with the app (apps/scelo-ide/src/swarm.ts) and this panel gets the
// loopback URL through lib/swarmConfig — no second terminal, nothing to
// start. While the server is coming up (or if it crashed) the panel shows
// the supervisor's status, log tail and a restart button instead of a
// blank ERR_CONNECTION_REFUSED iframe.
//
// In a plain browser (web build) the swarm is still the dev pair from a
// checkout (Vite 5190 / Bun 3010), so the fallback there is the
// copy-pasteable start command.
//
// Why iframe instead of porting the swarm UI : it's a self-contained
// app with its own routing, state, and websocket lifecycle. Embedding
// keeps one canonical implementation (per the swarm README, "no
// council code is duplicated into Scelo"). The iframe inherits the
// workspace's window size, and the swarm app already speaks SSE for
// progress.

import { useEffect, useState } from "react";
import { type SwarmStatus, isDesktopIDE } from "../../lib/sceloIDE";
import { getLastSwarmRequest, subscribeOpenInSwarm, urlFor } from "../../lib/swarmBus";
import { SWARM_START_COMMAND, swarmIsBundled, swarmUiUrl } from "../../lib/swarmConfig";
import { emitToast } from "../../lib/toastBus";
import { SwarmLiveDot } from "../SwarmLiveDot";

// The swarm UI origin — the bundled server inside the IDE, or the Vite dev
// URL in a browser — from the one place that knows (lib/swarmConfig), so
// the probe, the iframe and every surface that advertises it agree. Read
// per render, not at module load: the preload answers synchronously, but a
// module-level constant would freeze whatever it said at first import.
const PROBE_TIMEOUT_MS = 800;

// User manual page for starting the swarm (docs hub serves the manual
// under /scelo/; source: docs/docs/swarm/running.md).
export const SWARM_DOCS_URL = "https://docs.intelligentactuaries.com/scelo/swarm/running/";

/** The dev start command for the swarm — one string for every OS and
 *  shell (a root script of the Scelo repo; PORT defaults to 3010, so no
 *  PORT= / $env:PORT prefix to get wrong). Lives in lib/swarmConfig; kept
 *  here for the callers and tests that import it from the panel. Only
 *  shown when the swarm is NOT bundled. */
export { SWARM_START_COMMAND };
export function swarmStartCommand(): string {
  return SWARM_START_COMMAND;
}

type Probe = "probing" | "up" | "down";

export default function SwarmPanel() {
  const [probe, setProbe] = useState<Probe>("probing");
  // The iframe src defaults to the swarm root, but the openInSwarm bus
  // can point it at a run-specific URL (Hard Data's "open in swarm"
  // link). Persists across re-mounts via the bus's lastRequest cache.
  const swarmUrl = swarmUiUrl();
  const [iframeUrl, setIframeUrl] = useState<string>(() => {
    const last = getLastSwarmRequest();
    return last ? urlFor(last) : swarmUrl;
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
        await fetch(swarmUrl, { mode: "no-cors", signal: ctrl.signal });
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
  }, [swarmUrl]);

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
          title={swarmUrl}
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
      ) : swarmIsBundled() ? (
        <BundledFallback probe={probe} />
      ) : (
        <OfflineFallback />
      )}
    </div>
  );
}

/** Inside the IDE the swarm is supervised: show what the supervisor knows
 *  (starting / crashed / adopted an external server) with the log tail and
 *  a restart, rather than telling the user to open a terminal. */
function BundledFallback({ probe }: { probe: Probe }) {
  const [status, setStatus] = useState<SwarmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await window.scelo?.swarm?.status();
        if (!cancelled && st) setStatus(st);
      } catch {
        /* bridge missing */
      }
    };
    void poll();
    const id = window.setInterval(poll, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  const state = status?.state ?? (probe === "probing" ? "starting" : "stopped");
  const restart = async () => {
    if (!isDesktopIDE() || !window.scelo?.swarm) return;
    setBusy(true);
    try {
      const st = await window.scelo.swarm.restart();
      setStatus(st);
      emitToast("Restarting the swarm server…", "success");
    } catch (e) {
      emitToast(`Restart failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const headline =
    state === "starting"
      ? "Starting the swarm…"
      : state === "error"
        ? "The swarm server isn't running."
        : state === "external"
          ? "Waiting for the external swarm server…"
          : "Swarm server stopped.";
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-3 text-xs">
        <p className="text-center text-fg">{headline}</p>
        <p className="text-center text-fg-mute">
          {state === "starting"
            ? "The swarm ships inside Scelo IDE and starts with it — this panel attaches as soon as it answers."
            : state === "external"
              ? `Scelo found a swarm server already on ${status?.apiUrl ?? "the default port"} (a dev checkout, most likely) and is using that instead of starting its own.`
              : "It ships inside Scelo IDE and starts with the app; something stopped it. The log tail below says why."}
        </p>
        {status?.error && (
          <p className="rounded border border-error/40 bg-error/5 px-2 py-1 text-[11px] text-error">
            {status.error}
          </p>
        )}
        {status && (
          <p className="text-center font-mono text-[10px] text-fg-dim">
            {status.source} · {status.apiUrl}
            {status.pid ? ` · pid ${status.pid}` : ""}
            {status.dataDir ? ` · data ${status.dataDir}` : ""}
          </p>
        )}
        {status?.logTail && state !== "starting" && (
          <pre className="max-h-48 overflow-auto rounded border border-border bg-bg p-2 text-left font-mono text-[10px] text-fg-mute">
            {status.logTail.split("\n").slice(-30).join("\n")}
          </pre>
        )}
        {status?.managed && (
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => void restart()}
              disabled={busy}
              className="ia-btn ia-btn-md ia-btn-secondary"
            >
              {busy ? "restarting…" : "restart swarm server"}
            </button>
            {status.logFile && (
              <button
                type="button"
                onClick={() => void window.scelo?.swarm?.openLogs()}
                className="ia-btn ia-btn-md ia-btn-ghost"
              >
                open log
              </button>
            )}
          </div>
        )}
      </div>
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
          In the browser build the swarm is the dev pair from a Scelo checkout (
          <span className="font-mono">apps/swarm</span>): one{" "}
          <span className="font-mono">bun install</span>, then the command below, on any OS. It
          starts a Vite + Bun pair on <span className="font-mono">localhost:5190</span> (api on{" "}
          <span className="font-mono">3010</span>). Start it once and this panel will live-attach on
          the next probe. (Scelo IDE bundles the swarm and starts it for you.)
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
