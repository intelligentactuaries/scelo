import { db } from './db';
import { runCouncil, type ProgressEvent } from './agents/council';
import { justifyAllAgents } from './justify';
import { synthesize } from './agents/synthesizer';
import { summarizeScenario } from './agents/scenarioSummary';
import { computeCouncilEdges } from './agents/edges';
import {
  runSociety,
  sampleSocietyAgents,
  type SocietyProgress,
} from './agents/society';
import { clusterSociety, describeCluster } from './agents/society_cluster';
import { buildCondensedCanon } from './iaai';
import { runWmtrForScenario } from './wmtr';
import type {
  CouncilAgentResult,
  Intervention,
  ProviderPrefs,
  Run,
  RunSummary,
  Sentiment,
  SocietyAgentResult,
  SocietyClusterSummary,
  SocietyParams,
  SocietySummary,
} from '../shared/types';
import type { WmtrSingleParams } from '../shared/wmtr';
import { PROFESSIONS, type LegalJurisdiction } from '../shared/constants';

const DEFAULT_SOCIETY_PARAMS: SocietyParams = {
  ageMean: 38,
  ageSpread: 14,
  incomeMix: { low: 0.35, 'lower-mid': 0.25, mid: 0.2, 'upper-mid': 0.15, high: 0.05 },
  educationMix: { primary: 0.2, secondary: 0.5, tertiary: 0.25, postgrad: 0.05 },
  urbanRatio: 0.66,
  riskTolerance: 0.45,
  culture: 'South Africa',
  employmentMix: {
    employed: 0.45,
    'self-employed': 0.12,
    informal: 0.18,
    unemployed: 0.15,
    student: 0.06,
    retired: 0.04,
  },
  financialLiteracy: 0.4,
};

const DEFAULT_PROVIDER_PREFS: ProviderPrefs = {
  councilProvider: 'auto',
  societyProvider: 'auto',
  chatProvider: 'auto',
  models: {},
};

export type SSEEvent =
  | ProgressEvent
  | SocietyProgress
  | { type: 'status'; status: Run['status'] }
  | { type: 'done'; runId: string; summary: RunSummary }
  | { type: 'error'; message: string }
  | { type: 'justify_start'; total: number }
  | { type: 'justify_progress'; agentId: string; done: number; total: number; cached: boolean }
  | { type: 'justify_done'; total: number; elapsedMs: number; errors: number };

type Listener = (e: SSEEvent) => void;

interface ActiveRun {
  run: Run;
  listeners: Set<Listener>;
  history: SSEEvent[]; // replayed to late subscribers
}

const active = new Map<string, ActiveRun>();

function emit(rec: ActiveRun, event: SSEEvent) {
  rec.history.push(event);
  if (rec.history.length > 4096) rec.history.splice(0, rec.history.length - 4096);
  for (const l of rec.listeners) {
    try {
      l(event);
    } catch {
      // ignore individual listener failures
    }
  }
}

function persistRun(run: Run): void {
  // UPSERT — must NOT use INSERT OR REPLACE here: messages and justifications have
  // ON DELETE CASCADE, and REPLACE is delete-then-insert, which would wipe them.
  db.prepare(
    `INSERT INTO runs
       (id, created_at, scenario, scenario_summary, society_params_json, provider_prefs_json, status, summary_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       scenario = excluded.scenario,
       scenario_summary = excluded.scenario_summary,
       society_params_json = excluded.society_params_json,
       provider_prefs_json = excluded.provider_prefs_json,
       status = excluded.status,
       summary_json = excluded.summary_json,
       error = excluded.error`,
  ).run(
    run.id,
    run.createdAt,
    run.scenario,
    run.scenarioSummary ?? null,
    JSON.stringify(run.societyParams),
    JSON.stringify(run.providerPrefs),
    run.status,
    run.summary ? JSON.stringify(run.summary) : null,
    run.error ?? null,
  );
}

function persistCouncilMessages(runId: string, results: CouncilAgentResult[]): void {
  const ins = db.prepare(
    `INSERT INTO messages (run_id, agent_id, tier, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    // wipe any prior council messages for this run so re-runs are idempotent
    db.prepare(
      `DELETE FROM messages WHERE run_id = ? AND tier IN ('council','council-final')`,
    ).run(runId);
    const now = Date.now();
    for (const r of results) {
      for (const round of r.rounds) {
        ins.run(runId, r.agent.id, 'council', round.round, JSON.stringify(round), now);
      }
      ins.run(
        runId,
        r.agent.id,
        'council-final',
        null,
        JSON.stringify({
          stance: r.finalStance,
          confidence: r.finalConfidence,
          keyRisk: r.keyRisk,
          intervention: r.intervention,
        }),
        now,
      );
    }
  });
  tx();
}

function persistEdges(runId: string, edges: Run['councilEdges'], tier: 'council-edges' | 'society-edges'): void {
  const row = db.prepare(
    `INSERT INTO messages (run_id, agent_id, tier, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  row.run(runId, '_edges', tier, null, JSON.stringify(edges), Date.now());
}

function persistSocietyMessages(runId: string, results: SocietyAgentResult[]): void {
  const ins = db.prepare(
    `INSERT INTO messages (run_id, agent_id, tier, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    const now = Date.now();
    for (const r of results) {
      ins.run(runId, r.agent.id, 'society', null, JSON.stringify(r), now);
    }
  });
  tx();
}

function persistSocietySummary(runId: string, summary: SocietySummary): void {
  const row = db.prepare(
    `INSERT INTO messages (run_id, agent_id, tier, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  row.run(runId, '_society_summary', 'society-summary', null, JSON.stringify(summary), Date.now());
}

function persistWmtr(runId: string, payload: Run['wmtr']): void {
  if (!payload) return;
  // Wipe any prior wmtr row for this run so re-simulations replace cleanly.
  db.prepare(`DELETE FROM messages WHERE run_id = ? AND tier = 'wmtr'`).run(runId);
  const row = db.prepare(
    `INSERT INTO messages (run_id, agent_id, tier, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  row.run(runId, '_wmtr', 'wmtr', null, JSON.stringify(payload), Date.now());
}

const ZERO_MIX: Record<Sentiment, number> = {
  enthusiastic: 0,
  supportive: 0,
  neutral: 0,
  skeptical: 0,
  hostile: 0,
};

function buildSocietySummary(results: SocietyAgentResult[]): SocietySummary {
  const sentimentMix: Record<Sentiment, number> = { ...ZERO_MIX };
  let intensity = 0;
  for (const r of results) {
    sentimentMix[r.sentiment]++;
    intensity += r.intensity;
  }
  const clusterIds = new Set<number>();
  for (const r of results) if (r.cluster !== undefined) clusterIds.add(r.cluster);
  const clusters: SocietyClusterSummary[] = [...clusterIds]
    .sort((a, b) => a - b)
    .map((c) => {
      const members = results.filter((r) => r.cluster === c);
      const mix: Record<Sentiment, number> = { ...ZERO_MIX };
      for (const m of members) mix[m.sentiment]++;
      return {
        cluster: c,
        size: members.length,
        description: describeCluster(results, c),
        sentimentMix: mix,
      };
    });
  return {
    size: results.length,
    sentimentMix,
    averageIntensity: results.length ? Math.round(intensity / results.length) : 0,
    clusters,
  };
}

function newId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface StartRunArgs {
  scenario: string;
  societyParams?: Partial<SocietyParams>;
  providerPrefs?: Partial<ProviderPrefs>;
  subset?: number;
  societySize?: number;        // default 1000; 0 = skip society
  fresh?: boolean;
  canon?: string;
  legalJurisdiction?: LegalJurisdiction;
  justifyAll?: boolean;
  /** If false, skip the pre-council WMTR Monte Carlo. Default true. */
  wmtrEnabled?: boolean;
  /** Custom overrides for the WMTR config (used by intervention re-runs). */
  wmtrOverrides?: Partial<WmtrSingleParams>;
  /** Parent run id when re-running after an intervention. */
  parentRunId?: string;
  /** Intervention applied vs parentRun. */
  appliedIntervention?: Intervention;
}

export function startRun(args: StartRunArgs): Run {
  const id = newId();
  const run: Run = {
    id,
    scenario: args.scenario,
    societyParams: { ...DEFAULT_SOCIETY_PARAMS, ...(args.societyParams ?? {}) },
    providerPrefs: { ...DEFAULT_PROVIDER_PREFS, ...(args.providerPrefs ?? {}) },
    createdAt: Date.now(),
    status: 'pending',
    councilResults: [],
    councilEdges: [],
    societyResults: [],
    societyEdges: [],
    timings: {},
    parentRunId: args.parentRunId,
    appliedIntervention: args.appliedIntervention,
  };
  const rec: ActiveRun = { run, listeners: new Set(), history: [] };
  active.set(id, rec);
  persistRun(run);

  // fire async
  void executeRun(rec, args);
  return run;
}

async function executeRun(rec: ActiveRun, args: StartRunArgs): Promise<void> {
  const run = rec.run;
  try {
    run.status = 'running';
    persistRun(run);
    emit(rec, { type: 'status', status: 'running' });

    // Fire-and-forget ≤12-word tagline. Tiny LLM call on the cheap tier;
    // the council pass below doesn't block on it.
    void summarizeScenario(run.scenario).then((summary) => {
      if (summary && run.status !== 'failed') {
        run.scenarioSummary = summary;
        persistRun(run);
        emit(rec, { type: 'status', status: run.status });
      }
    });

    const t0 = performance.now();
    const canonText = args.canon ?? buildCondensedCanon();

    // ---- WMTR (synchronous, before council so its evidence can inject) ----
    let wmtrEvidence: string | undefined;
    let wmtrMs: number | undefined;
    if (args.wmtrEnabled !== false) {
      const tW = performance.now();
      const payload = runWmtrForScenario(run.scenario, args.wmtrOverrides ?? {});
      wmtrMs = Math.round(performance.now() - tW);
      run.wmtr = {
        config: payload.config,
        result: payload.result,
        dominantOutcome: payload.dominantOutcome,
        driver: payload.driver,
      };
      wmtrEvidence = payload.evidence;
      persistRun(run);
      persistWmtr(run.id, run.wmtr);
      // Tell any subscribers the WMTR baseline is ready so the strip can render
      // before the (slower) council finishes.
      emit(rec, { type: 'status', status: 'running' });
    }

    const council = await runCouncil(run.scenario, {
      subset: args.subset,
      fresh: args.fresh,
      canon: canonText,
      legalJurisdiction: args.legalJurisdiction,
      wmtrEvidence,
      onProgress: (e) => emit(rec, e),
    });
    const councilMs = Math.round(performance.now() - t0) - (wmtrMs ?? 0);

    const edges = computeCouncilEdges(council, { perNode: 4, threshold: 0.18 });
    const summary = synthesize(council);

    run.councilResults = council;
    run.councilEdges = edges;
    run.summary = summary;

    persistRun(run);
    persistCouncilMessages(run.id, council);
    persistEdges(run.id, edges, 'council-edges');

    // ---- society ----
    const societySize = args.societySize ?? 1000;
    let societyMs: number | undefined;
    if (societySize > 0) {
      const t1 = performance.now();
      const agents = sampleSocietyAgents(run.societyParams, societySize);
      const society = await runSociety(run.scenario, agents, {
        fresh: args.fresh,
        onProgress: (e) => emit(rec, e),
      });
      const clustered = clusterSociety(society, 6, { edgesPerNode: 2 });
      societyMs = Math.round(performance.now() - t1);

      run.societyResults = clustered.results;
      run.societyEdges = clustered.edges;
      run.societySummary = buildSocietySummary(clustered.results);

      persistSocietyMessages(run.id, clustered.results);
      persistEdges(run.id, clustered.edges, 'society-edges');
      persistSocietySummary(run.id, run.societySummary);
    }

    // ---- justify-all (optional) ----
    if (args.justifyAll && council.length > 0) {
      emit(rec, { type: 'justify_start', total: council.length });
      const r = await justifyAllAgents(run, canonText, {
        fresh: args.fresh,
        legalJurisdiction: args.legalJurisdiction,
        onProgress: (p) =>
          emit(rec, {
            type: 'justify_progress',
            agentId: p.agentId,
            done: p.done,
            total: p.total,
            cached: p.cached,
          }),
      });
      emit(rec, { type: 'justify_done', total: council.length, elapsedMs: r.elapsedMs, errors: r.errors });
    }

    run.timings = {
      councilMs,
      societyMs,
      wmtrMs,
      totalMs: Math.round(performance.now() - t0),
    };
    run.status = 'complete';

    persistRun(run);
    emit(rec, { type: 'done', runId: run.id, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run.status = 'failed';
    run.error = msg;
    persistRun(run);
    emit(rec, { type: 'error', message: msg });
  }
}

export function getRun(id: string): Run | null {
  const rec = active.get(id);
  if (rec) return rec.run;
  // try DB
  const row = db
    .prepare(
      `SELECT id, created_at, scenario, scenario_summary, society_params_json, provider_prefs_json, status, summary_json, error FROM runs WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        created_at: number;
        scenario: string;
        scenario_summary: string | null;
        society_params_json: string;
        provider_prefs_json: string;
        status: Run['status'];
        summary_json: string | null;
        error: string | null;
      }
    | null;
  if (!row) return null;
  return rehydrateFromDb(row);
}

function rehydrateFromDb(row: {
  id: string;
  created_at: number;
  scenario: string;
  scenario_summary: string | null;
  society_params_json: string;
  provider_prefs_json: string;
  status: Run['status'];
  summary_json: string | null;
  error: string | null;
}): Run {
  const msgs = db
    .prepare(
      `SELECT agent_id, tier, round, payload_json FROM messages WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(row.id) as { agent_id: string; tier: string; round: number | null; payload_json: string }[];

  // rebuild council results from messages
  const byAgent = new Map<
    string,
    {
      rounds: Map<
        number,
        { round: 1 | 2 | 3; content: string; confidence: number; stance?: Run['councilResults'][number]['finalStance']; keyRisk?: string }
      >;
      final?: { stance: Run['councilResults'][number]['finalStance']; confidence: number; keyRisk: string; intervention?: Intervention };
    }
  >();
  let councilEdges: Run['councilEdges'] = [];
  let societyEdges: Run['societyEdges'] = [];
  const society: SocietyAgentResult[] = [];
  let societySummary: SocietySummary | undefined;
  let wmtr: Run['wmtr'] | undefined;

  for (const m of msgs) {
    if (m.tier === 'council-edges') {
      councilEdges = JSON.parse(m.payload_json) as Run['councilEdges'];
      continue;
    }
    if (m.tier === 'society-edges') {
      societyEdges = JSON.parse(m.payload_json) as Run['societyEdges'];
      continue;
    }
    if (m.tier === 'society') {
      society.push(JSON.parse(m.payload_json) as SocietyAgentResult);
      continue;
    }
    if (m.tier === 'society-summary') {
      societySummary = JSON.parse(m.payload_json) as SocietySummary;
      continue;
    }
    if (m.tier === 'wmtr') {
      wmtr = JSON.parse(m.payload_json) as Run['wmtr'];
      continue;
    }
    if (!byAgent.has(m.agent_id)) byAgent.set(m.agent_id, { rounds: new Map() });
    const bucket = byAgent.get(m.agent_id)!;
    if (m.tier === 'council-final') {
      const p = JSON.parse(m.payload_json) as {
        stance: Run['councilResults'][number]['finalStance'];
        confidence: number;
        keyRisk: string;
        intervention?: Intervention;
      };
      bucket.final = p;
    } else if (m.tier === 'council' && m.round !== null) {
      const p = JSON.parse(m.payload_json);
      bucket.rounds.set(m.round, p);
    }
  }

  const council: CouncilAgentResult[] = [];
  for (const [agentId, b] of byAgent) {
    if (!b.final || b.rounds.size === 0) continue;
    const [profession, mbti, gender] = decodeAgentId(agentId);
    council.push({
      agent: { id: agentId, profession, mbti, gender },
      rounds: Array.from(b.rounds.values()).sort((a, z) => a.round - z.round),
      finalStance: b.final.stance,
      finalConfidence: b.final.confidence,
      keyRisk: b.final.keyRisk,
      intervention: b.final.intervention,
    });
  }

  return {
    id: row.id,
    createdAt: row.created_at,
    scenario: row.scenario,
    scenarioSummary: row.scenario_summary ?? undefined,
    societyParams: JSON.parse(row.society_params_json),
    providerPrefs: JSON.parse(row.provider_prefs_json),
    status: row.status,
    councilResults: council,
    councilEdges,
    societyResults: society,
    societyEdges,
    societySummary,
    summary: row.summary_json ? JSON.parse(row.summary_json) : undefined,
    error: row.error ?? undefined,
    wmtr,
  };
}

function decodeAgentId(id: string): [
  Run['councilResults'][number]['agent']['profession'],
  Run['councilResults'][number]['agent']['mbti'],
  Run['councilResults'][number]['agent']['gender'],
] {
  // c-{profession}-{mbti}-{gender}
  const parts = id.split('-');
  const profession = capitalise(parts[1]) as Run['councilResults'][number]['agent']['profession'];
  const mbti = parts[2].toUpperCase() as Run['councilResults'][number]['agent']['mbti'];
  const gender = parts[3].toUpperCase() as Run['councilResults'][number]['agent']['gender'];
  return [profession, mbti, gender];
}

function capitalise(s: string): string {
  for (const p of PROFESSIONS) {
    if (p.toLowerCase() === s) return p;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getAgentResult(runId: string, agentId: string): CouncilAgentResult | null {
  const run = getRun(runId);
  if (!run) return null;
  return run.councilResults.find((r) => r.agent.id === agentId) ?? null;
}

const justifyJobs = new Set<string>();

export interface JustifyAllJobHandle {
  runId: string;
  total: number;
  status: 'started' | 'already-running';
}

export function startJustifyAllJob(
  runId: string,
  opts: { fresh?: boolean; legalJurisdiction?: LegalJurisdiction; canon?: string } = {},
): JustifyAllJobHandle | null {
  const run = getRun(runId);
  if (!run) return null;
  if (run.councilResults.length === 0) return null;

  // ensure run is in active map so listeners can subscribe to its events
  let rec = active.get(runId);
  if (!rec) {
    rec = { run, listeners: new Set(), history: [] };
    active.set(runId, rec);
  }

  const total = run.councilResults.length;
  if (justifyJobs.has(runId)) {
    return { runId, total, status: 'already-running' };
  }
  justifyJobs.add(runId);

  void (async () => {
    const canonText = opts.canon ?? buildCondensedCanon();
    emit(rec!, { type: 'justify_start', total });
    try {
      const r = await justifyAllAgents(run, canonText, {
        fresh: opts.fresh,
        legalJurisdiction: opts.legalJurisdiction,
        onProgress: (p) =>
          emit(rec!, {
            type: 'justify_progress',
            agentId: p.agentId,
            done: p.done,
            total: p.total,
            cached: p.cached,
          }),
      });
      emit(rec!, { type: 'justify_done', total, elapsedMs: r.elapsedMs, errors: r.errors });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(rec!, { type: 'error', message: msg });
    } finally {
      justifyJobs.delete(runId);
    }
  })();

  return { runId, total, status: 'started' };
}

export function isJustifyAllRunning(runId: string): boolean {
  return justifyJobs.has(runId);
}

export function subscribe(runId: string, listener: Listener): { unsubscribe: () => void; replay: SSEEvent[] } | null {
  const rec = active.get(runId);
  if (!rec) return null;
  rec.listeners.add(listener);
  return {
    unsubscribe: () => rec.listeners.delete(listener),
    replay: rec.history.slice(),
  };
}

export function isRunActive(runId: string): boolean {
  return active.has(runId);
}
