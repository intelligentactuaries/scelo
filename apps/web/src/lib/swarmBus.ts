// Open-in-swarm bus. Lets the Scelo Hard Data workstation (and any
// other call-site) say "show this run in the IDE's swarm tab"
// without coupling to the workspace shell's setSidebarTab.
//
// Same shape as our other buses. When fired:
//   1. SwarmPanel updates the iframe src to the run-specific URL.
//   2. The workspace shell flips its sidebar to the swarm tab.

const SWARM_URL = "http://localhost:5190";

export interface OpenInSwarmRequest {
  /** Optional run id. When absent the panel loads the swarm root. */
  runId?: string;
}

type Listener = (r: OpenInSwarmRequest) => void;

const listeners = new Set<Listener>();
let lastRequest: OpenInSwarmRequest | null = null;

export function urlFor(req: OpenInSwarmRequest): string {
  return req.runId ? `${SWARM_URL}/?runId=${req.runId}` : SWARM_URL;
}

export function getLastSwarmRequest(): OpenInSwarmRequest | null {
  return lastRequest;
}

/** Cache + broadcast a "show this run in the swarm" intent. Callers
 *  typically pair this with `navigate("/swarm")`. The Swarm route
 *  reads `getLastSwarmRequest()` on mount to point its iframe; the
 *  SwarmPanel inside it subscribes for subsequent updates while
 *  mounted. */
export function openInSwarm(req: OpenInSwarmRequest): void {
  lastRequest = req;
  for (const fn of listeners) fn(req);
}

export function subscribeOpenInSwarm(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
