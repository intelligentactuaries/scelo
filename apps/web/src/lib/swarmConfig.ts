// Where the swarm is — ONE answer for every surface that talks to it.
//
// Inside the Scelo IDE the swarm is bundled: the main process starts the
// server with the app and tells this window its loopback endpoints through
// the preload bridge (window.scelo.swarm.endpoints(), synchronous — decided
// before the window was created). UI and API are then the SAME origin.
//
// In a plain browser (web build, docs demos) or an old preload, the swarm is
// the dev pair from a checkout: Vite UI on 5190, Bun API on 3010, with the
// historical `?swarmUrl=` override for the API kept for staging/demo flows.
//
// Every previous hard-coded "http://localhost:3010" / ":5190" in the app now
// resolves through here, so the panel, the LED, the council client, the
// simulate modal and the chat-log merge can never disagree.

const DEV_UI_URL = "http://localhost:5190";
const DEV_API_URL = "http://localhost:3010";

type Endpoints = { ui: string; api: string };

function fromBridge(): Endpoints | null {
  if (typeof window === "undefined") return null;
  const bridge = window.scelo?.swarm;
  if (!bridge || typeof bridge.endpoints !== "function") return null;
  try {
    const e = bridge.endpoints();
    if (e && typeof e.ui === "string" && typeof e.api === "string") return e;
  } catch {
    /* fall through */
  }
  return null;
}

/** True when this window is the desktop IDE with a bundled, supervised swarm. */
export function swarmIsBundled(): boolean {
  return fromBridge() !== null;
}

/** Base URL of the swarm API (fetch / SSE). */
export function swarmApiUrl(): string {
  if (typeof window !== "undefined") {
    const sp = new URLSearchParams(window.location.search);
    const override = sp.get("swarmUrl");
    if (override) return override.replace(/\/$/, "");
  }
  return (fromBridge()?.api ?? DEV_API_URL).replace(/\/$/, "");
}

/** Base URL of the swarm UI (iframe src). */
export function swarmUiUrl(): string {
  return (fromBridge()?.ui ?? DEV_UI_URL).replace(/\/$/, "");
}

/** Human-readable location, for copy ("server not detected on :3010"). */
export function swarmApiLabel(): string {
  try {
    const u = new URL(swarmApiUrl());
    return u.port ? `:${u.port}` : u.host;
  } catch {
    return swarmApiUrl();
  }
}

/** The dev start command — a root script of the Scelo repo, identical on
 *  every OS / shell (PORT defaults to 3010 in apps/swarm). Only relevant when
 *  the swarm is NOT bundled (browser build, docs demos). */
export const SWARM_START_COMMAND = "bun run dev:swarm";

/** What to tell the user when the swarm doesn't answer. Bundled: it starts
 *  with the app, so "not running" means "still starting" or "crashed — see
 *  the panel"; browser: how to start the dev pair. */
export function swarmStartHint(): string {
  return swarmIsBundled()
    ? "The swarm ships inside Scelo IDE and starts with it — if it stays offline, open the swarm view for its status, log and a restart button."
    : `Start it from a Scelo checkout: \`${SWARM_START_COMMAND}\` — it listens on 3010 by default. See docs: swarm/running.`;
}
