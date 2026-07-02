// Council call-out — Scelo asks the swarm server (the canonical 192-agent
// deliberation app on :3010) to convene a council on a scenario, then
// renders the synthesis inline on a Hard Data card. No council code is
// duplicated into Scelo: one canonical implementation, two surfaces.
//
// The contract is intentionally narrow. Scelo POSTs a scenario string +
// subset size; the swarm runs council + (optional) society in the
// background and streams progress over SSE. We poll the run state until
// `status === "complete"`, then return a small CouncilSynthesis shape.

export type CouncilSynthesis = {
  runId: string;
  /** % of council that trusts the forecast / result. */
  trustPct: number;
  distrustPct: number;
  uncertainPct: number;
  /** Number of agents that participated. */
  total: number;
  /** Dominant intervention cluster — what the consensus would shift. */
  dominantIntervention: {
    param: string;
    direction: "increase" | "decrease";
    magnitude: "small" | "large";
    count: number;
    exemplarRationale: string;
  } | null;
  /** Brief flavoured one-liner for the card. */
  blurb: string;
};

const DEFAULT_SWARM_URL = "http://localhost:3010";

// Exported so the council CTA can probe the SAME base URL the calls will
// hit — including the ?swarmUrl= override — instead of hardcoding its own.
export function swarmApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_SWARM_URL;
  // Allow the user to override at runtime via a URL param for staging /
  // demo flows. e.g. `?swarmUrl=https://swarms.intelligentactuaries.com`.
  const sp = new URLSearchParams(window.location.search);
  return sp.get("swarmUrl") ?? DEFAULT_SWARM_URL;
}

export interface ConveneOpts {
  /** Scenario text passed to the swarm. Scelo synthesises this from
   *  the source result + dataset + family hints. */
  scenario: string;
  /** Number of council agents — keep small by default (12) so a
   *  per-result button doesn't burn credits. 192 is the full run. */
  subset?: 12 | 24 | 48 | 96 | 192;
  /** Disable the society pulse for a faster turnaround. Default false. */
  skipSociety?: boolean;
  signal?: AbortSignal;
  /** Called when the run lands an id so the caller can show a "polling…"
   *  state immediately. */
  onStart?: (runId: string) => void;
}

export async function conveneCouncil(opts: ConveneOpts): Promise<CouncilSynthesis> {
  const base = swarmApiUrl();
  const start = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scenario: opts.scenario,
      subset: opts.subset ?? 12,
      societySize: opts.skipSociety ? 0 : 120,
      fresh: false,
    }),
    signal: opts.signal,
  });
  if (!start.ok) {
    throw new Error(`swarm /api/run ${start.status}`);
  }
  const { runId } = (await start.json()) as { runId: string };
  opts.onStart?.(runId);

  // Poll the run state until complete. The budget scales with the run size:
  // a 192-agent council (+ society) on a local LLM is far slower than the
  // default 12-agent council, and a fixed 5-min cap would abandon a run that's
  // still making progress. Roughly ~10s of work per council agent plus a
  // society allowance, floored at 5 min and capped at 45 so a wedged run still
  // eventually surfaces an error.
  const POLL_MS = 2000;
  const perAgentMs = 10_000;
  const societyMs = opts.skipSociety ? 0 : 12 * 60 * 1000;
  const TIMEOUT_MS = Math.min(
    45 * 60 * 1000,
    Math.max(5 * 60 * 1000, (opts.subset ?? 12) * perAgentMs + societyMs),
  );
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("aborted");
    await new Promise((r) => setTimeout(r, POLL_MS));
    const resp = await fetch(`${base}/api/run/${runId}`, { signal: opts.signal });
    if (!resp.ok) continue;
    const run = (await resp.json()) as RunShape;
    if (run.status === "complete" && run.summary) {
      return synthesise(run);
    }
    if (run.status === "failed") {
      throw new Error(`swarm run failed: ${run.error ?? "unknown"}`);
    }
  }
  throw new Error(`council timed out (${Math.round(TIMEOUT_MS / 60000)} min)`);
}

// ─── Internal shape we actually need from the swarm's Run JSON ────────────

type RunShape = {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  error?: string;
  summary?: {
    consensusScore: number;
    supportPct: number;
    opposePct: number;
    abstainPct: number;
    interventionClusters?: Array<{
      param: string;
      direction: "increase" | "decrease";
      magnitude: "small" | "large";
      count: number;
      exemplarRationale: string;
    }>;
  };
  councilResults: Array<unknown>;
};

function synthesise(run: RunShape): CouncilSynthesis {
  const s = run.summary;
  if (!s) {
    throw new Error("run is complete but summary missing");
  }
  const top = s.interventionClusters?.[0] ?? null;
  const total = run.councilResults.length;
  const blurb =
    `${s.supportPct}% trust · ${s.opposePct}% distrust · ${s.abstainPct}% uncertain across ${total} agents` +
    (top
      ? ` · top intervention: ${top.direction === "increase" ? "↑" : "↓"} ${top.param} (${top.count} agents)`
      : "");
  return {
    runId: run.id,
    trustPct: s.supportPct,
    distrustPct: s.opposePct,
    uncertainPct: s.abstainPct,
    total,
    dominantIntervention: top,
    blurb,
  };
}
