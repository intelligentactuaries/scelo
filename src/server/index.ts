import { db } from './db';
import { router, type Message, type Provider } from './llm/router';
import type { ProviderPrefs, SocietyParams, Tier } from '../shared/types';
import type { LegalJurisdiction } from '../shared/constants';
import {
  getAgentResult,
  getRun,
  isJustifyAllRunning,
  societySeedFor,
  startJustifyAllJob,
  startRun,
  subscribe,
  type SSEEvent,
} from './runs';
import {
  isProfession,
  justifyAgent,
  justifyGroup,
  listJustifications,
  readJustification,
} from './justify';
import { groupAgentId } from './agents/toolkits';
import { streamChat, type ChatMessage } from './chat';
import {
  initCanon,
  loadCanon,
  replaceCanon,
  parseBibTeX,
  parseJsonUpload,
  buildCondensedCanon,
} from './iaai';
import {
  runWmtrForScenario,
  applyIntervention,
  type Intervention,
} from './wmtr';
import type { WmtrSingleParams } from '../shared/wmtr';
import type { CanonWork, SimulationAgentResult } from '../shared/types';
import { sampleSAPopulation } from './agents/saPopulation';
import { runSimulation, type SimulationProgress } from './agents/simulation';
import { aggregateMacro, SA_MACRO_PROVENANCE } from './macroMap';
import { fetchReferenceBundle, formatReferenceBlock, type ReferenceBundle } from './refdata';

const PORT = Number(process.env.PORT ?? 3000);

interface RouteCtx {
  req: Request;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: RouteCtx) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  return { pattern, keys };
}

function route(method: string, path: string, handler: Handler) {
  const { pattern, keys } = compile(path);
  routes.push({ method, pattern, keys, handler });
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error('invalid json body');
  }
}

route('GET', '/api/health', () => {
  const row = db.query('SELECT 1 AS ok').get() as { ok: number };
  return json({ ok: row.ok === 1, time: Date.now() });
});

route('GET', '/api/providers', () => json(router.info()));

interface ProvidersUpdate {
  keys?: Partial<Record<'anthropic' | 'openai' | 'gemini' | 'hf', string | null>>;
  prefs?: Parameters<typeof router.setPrefs>[0];
  refreshOllama?: boolean;
}

route('POST', '/api/providers', async ({ req }) => {
  const body = await readBody<ProvidersUpdate>(req);
  if (body.keys) router.setKeys(body.keys);
  if (body.prefs) router.setPrefs(body.prefs);
  if (body.refreshOllama) await router.refreshOllama();
  return json(router.info());
});

interface TestBody {
  tier?: Tier;
  provider?: Provider;
  prompt: string;
  system?: string;
  fresh?: boolean;
}

route('POST', '/api/test', async ({ req }) => {
  const body = await readBody<TestBody>(req);
  if (!body.prompt) return json({ error: 'prompt required' }, { status: 400 });
  const tier: Tier = body.tier ?? 'society';
  const messages: Message[] = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  messages.push({ role: 'user', content: body.prompt });
  try {
    const provider = body.provider ?? router.selectProvider(tier);
    if (!provider) {
      return json(
        { error: 'no provider available — add an api key or start ollama' },
        { status: 503 },
      );
    }
    const t0 = performance.now();
    const meta = await router.routeWithMeta(messages, tier, {
      provider: body.provider,
      fresh: body.fresh,
      maxTokens: 256,
    });
    const elapsedMs = Math.round(performance.now() - t0);
    return json({
      provider: meta.provider,
      model: meta.model,
      response: meta.text,
      elapsedMs,
      cached: meta.cached,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: redact(msg) }, { status: 500 });
  }
});

route('DELETE', '/api/cache', () => {
  const n = router.clearCache();
  return json({ cleared: n });
});

// ─────────────────────────────────────────────────────────────────────────
// WMTR — ad-hoc nanoeconomics run from a scenario, optional parameter
// overrides, optional consensus intervention to apply on top. Used both
// for previewing the strip before a council run and for the "re-simulate
// with consensus" button in the synthesis tab.
// ─────────────────────────────────────────────────────────────────────────

interface WmtrRunBody {
  scenario: string;
  overrides?: Partial<WmtrSingleParams>;
  intervention?: Intervention;
}

route('POST', '/api/wmtr', async ({ req }) => {
  const body = await readBody<WmtrRunBody>(req);
  if (!body.scenario?.trim()) return json({ error: 'scenario required' }, { status: 400 });
  const baseOverrides = body.overrides ?? {};
  let payload = runWmtrForScenario(body.scenario, baseOverrides);
  if (body.intervention) {
    const merged = applyIntervention(payload.config, body.intervention);
    payload = runWmtrForScenario(body.scenario, merged);
  }
  return json(payload);
});

interface InterveneBody {
  intervention: Intervention;
  /** Re-run council against the new WMTR evidence. Default true. */
  recouncil?: boolean;
  subset?: number;
  societySize?: number;
  fresh?: boolean;
}

route('POST', '/api/run/:id/intervene', async ({ req, params }) => {
  const run = getRun(params.id);
  if (!run) return json({ error: 'run not found' }, { status: 404 });
  const body = await readBody<InterveneBody>(req);
  if (!body.intervention) return json({ error: 'intervention required' }, { status: 400 });
  const baseConfig = run.wmtr?.config;
  if (!baseConfig) return json({ error: 'run has no WMTR baseline' }, { status: 400 });
  const merged = applyIntervention(baseConfig, body.intervention);
  const recouncil = body.recouncil !== false;
  if (!recouncil) {
    // Just re-run the simulator and return the payload; no new council run.
    const payload = runWmtrForScenario(run.scenario, merged);
    return json({ runId: null, wmtr: payload });
  }
  // Spawn a follow-up run that links back to the parent via parentRunId.
  const next = startRun({
    scenario: run.scenario,
    societyParams: run.societyParams,
    providerPrefs: run.providerPrefs,
    subset: body.subset,
    societySize: body.societySize,
    fresh: body.fresh,
    wmtrOverrides: merged,
    // Inherit the parent's society cohort. This run exists to answer "what
    // changes if we apply this intervention?" — resampling the population at
    // the same time would confound the intervention effect with sampling
    // noise and make the before/after delta unreadable.
    societySeed: societySeedFor(run.id),
    parentRunId: run.id,
    appliedIntervention: body.intervention,
  });
  return json({ runId: next.id, status: next.status, wmtrConfig: merged });
});

route('GET', '/api/canon', () => json({ works: loadCanon() }));

interface CanonReplaceBody {
  works: CanonWork[];
}

route('POST', '/api/canon', async ({ req }) => {
  const body = await readBody<CanonReplaceBody>(req);
  if (!Array.isArray(body.works)) return json({ error: 'works array required' }, { status: 400 });
  const n = replaceCanon(body.works);
  return json({ count: n, works: loadCanon() });
});

interface CanonImportBody {
  format: 'json' | 'bib';
  text: string;
  mode?: 'replace' | 'append';
}

route('POST', '/api/canon/import', async ({ req }) => {
  const body = await readBody<CanonImportBody>(req);
  if (!body.text?.trim()) return json({ error: 'text required' }, { status: 400 });
  let works: CanonWork[];
  try {
    works = body.format === 'json' ? parseJsonUpload(body.text) : parseBibTeX(body.text);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'parse failed' }, { status: 400 });
  }
  const combined = body.mode === 'append' ? [...loadCanon(), ...works] : works;
  const n = replaceCanon(combined);
  return json({ imported: works.length, count: n, works: loadCanon() });
});

interface StartRunBody {
  scenario: string;
  societyParams?: Partial<SocietyParams>;
  providerPrefs?: Partial<ProviderPrefs>;
  subset?: number;
  societySize?: number;
  fresh?: boolean;
  canon?: string;
  legalJurisdiction?: LegalJurisdiction;
  justifyAll?: boolean;
  /** Optional. Default true — run the WMTR Monte Carlo before the council so
   *  its evidence injects into every agent's prompt. */
  wmtrEnabled?: boolean;
}

route('POST', '/api/run', async ({ req }) => {
  const body = await readBody<StartRunBody>(req);
  if (!body.scenario || body.scenario.trim().length < 4) {
    return json({ error: 'scenario required' }, { status: 400 });
  }
  const run = startRun({
    scenario: body.scenario.trim(),
    societyParams: body.societyParams,
    providerPrefs: body.providerPrefs,
    subset: body.subset,
    societySize: body.societySize,
    fresh: body.fresh,
    canon: body.canon,
    legalJurisdiction: body.legalJurisdiction,
    justifyAll: body.justifyAll,
    wmtrEnabled: body.wmtrEnabled,
  });
  return json({ runId: run.id, status: run.status });
});

// ─── Population simulation ───────────────────────────────────────────────
//
// The simulator is a different beast from the council/society scenario
// flow: it samples an SA-anchored synthetic population, then runs an
// LLM call per agent with a strict JSON outcome envelope, then rolls
// the per-agent outcomes up to country-level macro figures with cited
// multipliers. Three surfaces:
//   POST /api/simulate            — full run (refs + sample + sim + macro)
//   POST /api/simulate/augment    — augment caller-supplied rows in place
//   POST /api/simulate/references — preview reference bundle only

interface SimulateBody {
  scenario: string;
  /** Drug / compound names to resolve via PubChem / OpenFDA / ChEMBL. */
  drugs?: string[];
  /** Country pop to scale to. Defaults to SA 62.27M. */
  population?: number;
  /** Sample size for the per-agent LLM pass. Defaults to 200. */
  sampleSize?: number;
  /** Concurrency cap on the LLM calls. */
  concurrency?: number;
  /** Bypass the LLM cache. */
  fresh?: boolean;
  /** Population seed. Omit for an independent draw; send one back to
   *  reproduce a previous run exactly. */
  seed?: number;
  /** Stream progress as SSE instead of one JSON body at the end. A full
   *  run is minutes of LLM calls; a silent response that long gets killed
   *  by browser no-headers timeouts (~300s in Chrome), so the swarm client
   *  opts in to this. Plain JSON stays the default — Scelo posts here and
   *  expects the original contract. */
  stream?: boolean;
}

function agentToRow(r: SimulationAgentResult): Record<string, unknown> {
  const a = r.agent;
  const h = a.health;
  const o = r.outcome;
  return {
    id: a.id,
    age: a.age,
    sex: a.sex ?? h?.sex ?? '',
    income_band: a.incomeBand,
    education: a.education,
    region: a.region,
    employment: a.employment,
    culture: a.culture,
    // These four shape every prompt but never reached the table, so nothing
    // downstream could regress an outcome against the drivers that produced
    // it — the dataset showed the answers without the inputs.
    risk_tolerance: Number(a.riskTolerance.toFixed(3)),
    financial_literacy: Number(a.financialLiteracy.toFixed(3)),
    trust_health_system: h ? Number(h.trustInHealthSystem.toFixed(3)) : '',
    health_literacy: h ? Number(h.healthLiteracy.toFixed(3)) : '',
    baseline_mortality: h ? Number(h.baselineMortality.toFixed(5)) : '',
    comorbidities: h?.comorbidities.join(';') ?? '',
    vaccination: h?.vaccinationHistory ?? '',
    insurance_cov: h ? Number(h.insuranceCoverage.toFixed(3)) : 0,
    // Whether this row is an observation at all. Without it a failed agent is
    // indistinguishable from someone who genuinely shrugged.
    sim_status: r.failure ? r.failure.kind : 'ok',
    sim_error: r.failure?.message ?? '',
    sim_treatment_uptake: o.behaviour.treatmentUptake,
    sim_isolation_days: o.behaviour.isolationDays,
    sim_spending_shift: o.behaviour.spendingShift,
    sim_infection_probability: Number(o.health.infectionProbability.toFixed(3)),
    sim_severity_if_infected: o.health.severityIfInfected,
    sim_mortality_probability: Number(o.health.mortalityProbability.toFixed(4)),
    sim_hospitalised: o.health.hospitalised,
    sim_workdays_lost: o.economic.workdaysLost,
    sim_oop_zar: Math.round(o.economic.outOfPocketCostZar),
    sim_insurer_claim_zar: Math.round(o.economic.insurerClaimZar),
    sim_rationale: o.behaviour.rationale,
  };
}

route('POST', '/api/simulate', async ({ req }) => {
  const body = await readBody<SimulateBody>(req);
  if (!body.scenario || body.scenario.trim().length < 4) {
    return json({ error: 'scenario required' }, { status: 400 });
  }
  const sampleSize = Math.max(20, Math.min(2000, body.sampleSize ?? 200));
  const drugs = (body.drugs ?? []).filter((d): d is string => !!d && d.trim().length > 0);

  // Monte Carlo draws must be independent. The seed used to default to a
  // literal 1, so every run sampled the SAME cohort; identical agents
  // produced identical prompts, every prompt hit the LLM cache, and the
  // whole simulation returned the previous run's table in ~1ms. That is not
  // a slow simulation — it is the same simulation, replayed.
  //
  // An explicit seed is still honoured, because reproducing a published
  // figure is a real requirement; it is echoed in the response so any run
  // can be re-run exactly.
  const seed =
    typeof body.seed === 'number' && Number.isFinite(body.seed)
      ? Math.floor(body.seed)
      : Math.floor(Math.random() * 2 ** 31);

  const runFull = async (onProgress?: (e: SimulationProgress) => void) => {
    const t0 = performance.now();
    const refs: ReferenceBundle = await fetchReferenceBundle(drugs);
    const refBlock = formatReferenceBlock(refs);
    const refMs = Math.round(performance.now() - t0);

    const agents = sampleSAPopulation({ size: sampleSize, seed });

    const { results, elapsedMs: simMs } = await runSimulation(agents, {
      scenario: body.scenario.trim(),
      referenceBlock: refBlock,
      concurrency: body.concurrency,
      fresh: body.fresh,
      seed,
      onProgress,
    });

    const macro = aggregateMacro(results, { population: body.population });
    const rows = results.map(agentToRow);
    return {
      scenario: body.scenario.trim(),
      drugs,
      refs,
      macro,
      macroProvenance: SA_MACRO_PROVENANCE,
      rows,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      sampleSize,
      population: macro.population,
      /** Echoed so a run can be reproduced exactly by sending it back. */
      seed,
      timings: { refMs, simMs },
    };
  };

  if (!body.stream) return json(await runFull());

  // SSE variant: headers go out immediately, progress events keep the
  // socket warm for the whole multi-minute run, and the last event
  // carries the exact payload the JSON branch would have returned.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // client went away — let the run finish quietly
        }
      };
      // Progress events land every ~10 agents; on a busy GPU that gap can
      // stretch, so heartbeat comments guard the socket regardless.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);
      send({ type: 'phase', phase: 'refs' });
      try {
        const payload = await runFull((e) => {
          if (e.type === 'sim_start') send({ type: 'phase', phase: 'sim', total: e.total });
          else if (e.type === 'sim_progress') send({ type: 'sim_progress', done: e.done, total: e.total });
          else if (e.type === 'sim_done') send({ type: 'phase', phase: 'macro' });
        });
        send({ type: 'result', ...payload });
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

interface AugmentBody {
  scenario: string;
  drugs?: string[];
  /** Caller-provided rows. We augment IN-PLACE: copy each row + add sim_*
   *  columns derived from the scenario. To keep cost bounded we run the
   *  simulation on a SAMPLE of N agents drawn from the SA population
   *  (not from the caller's rows), then use the median outcome per
   *  age-band × sex × comorbidity bucket as a lookup table applied to
   *  each input row. The result is informative for typical-shape inputs
   *  and inexpensive enough to run on 10k-row datasets. */
  rows: Array<Record<string, unknown>>;
  /** Column names whose presence on the input row should be respected
   *  (just used to validate the augment makes sense — we never trample
   *  caller columns). */
  expectedColumns?: string[];
  /** How many representative agents to simulate for the lookup. */
  sampleSize?: number;
  /** Reference-cohort seed. Omit for an independent draw; send one back to
   *  reproduce a previous augmentation exactly. */
  seed?: number;
  fresh?: boolean;
  /** Stream progress as SSE instead of one JSON body at the end. Strongly
   *  recommended: the reference pass is one LLM call per agent, and a silent
   *  multi-minute response is cut off by the browser. */
  stream?: boolean;
}

route('POST', '/api/simulate/augment', async ({ req }) => {
  const body = await readBody<AugmentBody>(req);
  if (!body.scenario?.trim()) return json({ error: 'scenario required' }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return json({ error: 'rows array required' }, { status: 400 });
  }
  // 400 (the cap) by default. The lookup takes a median inside each
  // age × sex × comorbidity bucket — ~40 buckets — so 120 left roughly 3
  // reference agents per bucket and several backed by one. At 400 the
  // age-balanced draw fills ~41 buckets with far more depth, which is what
  // makes a per-bucket median worth quoting.
  //
  // The cost is one LLM call per reference agent: measured ~2.6s marginal,
  // so a cold 400-agent run is ~17 minutes. That is only survivable because
  // of the streaming branch below — a plain JSON response that silent would
  // be cut off by the browser long before it finished.
  const sampleSize = Math.max(40, Math.min(400, body.sampleSize ?? 400));
  const drugs = (body.drugs ?? []).filter((d): d is string => !!d && d.trim().length > 0);

  const runFull = async (onProgress?: (e: SimulationProgress) => void) => {
  const refs = await fetchReferenceBundle(drugs);
  const refBlock = formatReferenceBlock(refs);
  // The reference cohort is a Monte Carlo draw, and the bucket medians below
  // are estimates from it — so it was wrong to freeze it. The seed used to be
  // a literal 7, which meant the same 120 agents forever: identical prompts,
  // a 100% LLM cache hit, and an augmentation that could never be refreshed
  // or checked for sensitivity to the draw. An explicit seed is still
  // honoured and echoed, so an augmentation used in a report can be
  // reproduced exactly.
  const seed =
    typeof body.seed === 'number' && Number.isFinite(body.seed)
      ? Math.floor(body.seed)
      : Math.floor(Math.random() * 2 ** 31);
  // Age-balanced, NOT representative. The lookup below takes a median within
  // each age × sex × comorbidity bucket, so it needs coverage in every
  // decade rather than a cohort shaped like SA's (very young) pyramid — a
  // representative draw leaves the 80+ buckets empty, which is what forced
  // elderly rows onto the whole-cohort fallback. Conditional estimates are
  // invariant to the marginal age distribution, so this sharpens the elderly
  // buckets without biasing any of them. Safe here precisely because the
  // augment path never aggregates across ages (no aggregateMacro).
  const agents = sampleSAPopulation({ size: sampleSize, seed, ageWeighting: 'age-balanced' });
  const { results: allResults } = await runSimulation(agents, {
    scenario: body.scenario.trim(),
    referenceBlock: refBlock,
    fresh: body.fresh,
    seed,
    onProgress,
  });
  // Failed agents carry a neutral all-zero placeholder. Leaving them in the
  // buckets below would drag every median toward zero and, in a sparse
  // bucket, could BE the median — an input row would then be augmented from
  // a value no agent ever reported.
  const results = allResults.filter((r) => !r.failure);
  const failedCount = allResults.length - results.length;

  // Index the reference cohort at several granularities.
  //
  // A single decade × sex × comorbidity table is too sparse to stand alone:
  // at the default sample size only ~30 of the ~40 possible buckets are
  // occupied and several hold a single agent, so many input rows find no
  // match. The previous fallback claimed to "fall back through coarser
  // buckets" but actually took the FIRST bucket in Map insertion order —
  // i.e. the bucket of whichever agent happened to be simulated first. An
  // 80-year-old man with comorbidities could be handed a 20-year-old
  // woman's outcomes. That was merely stable while the seed was frozen;
  // with an independent draw per run it would have become erratic, so it
  // has to be fixed alongside the seed rather than after it.
  //
  // These indexes let an unmatched row degrade to the nearest sensible
  // neighbourhood — drop comorbidity, then sex, then widen the age band —
  // and only reach the whole cohort as a last resort.
  type Key = string;
  type Bucketed = Map<Key, SimulationAgentResult[]>;
  const byExact: Bucketed = new Map();
  const byDecadeSex: Bucketed = new Map();
  const byDecade: Bucketed = new Map();
  const byBandSex: Bucketed = new Map();
  const byBand: Bucketed = new Map();
  const decadeOf = (age: number) => Math.floor(age / 10) * 10;
  const bandOf = (age: number) => Math.floor(age / 20) * 20;
  const push = (m: Bucketed, k: Key, r: SimulationAgentResult) => {
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  };
  for (const r of results) {
    const age = r.agent.age;
    const sex = r.agent.sex ?? r.agent.health?.sex ?? 'F';
    const hasCom = !!r.agent.health && r.agent.health.comorbidities.length > 0;
    push(byExact, `${decadeOf(age)}|${sex}|${hasCom ? 'c' : '0'}`, r);
    push(byDecadeSex, `${decadeOf(age)}|${sex}`, r);
    push(byDecade, `${decadeOf(age)}`, r);
    push(byBandSex, `${bandOf(age)}|${sex}`, r);
    push(byBand, `${bandOf(age)}`, r);
  }

  /** Nearest populated neighbourhood for a row, plus how it was matched. */
  function resolveBucket(
    age: number,
    sex: string,
    hasCom: boolean,
  ): { arr: SimulationAgentResult[]; match: string } {
    const tries: Array<[Bucketed, Key, string]> = [
      [byExact, `${decadeOf(age)}|${sex}|${hasCom ? 'c' : '0'}`, 'age10+sex+comorbidity'],
      [byDecadeSex, `${decadeOf(age)}|${sex}`, 'age10+sex'],
      [byDecade, `${decadeOf(age)}`, 'age10'],
      [byBandSex, `${bandOf(age)}|${sex}`, 'age20+sex'],
      [byBand, `${bandOf(age)}`, 'age20'],
    ];
    for (const [m, k, match] of tries) {
      const arr = m.get(k);
      if (arr && arr.length > 0) return { arr, match };
    }
    return { arr: results, match: 'cohort' };
  }
  function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function lookup(age: number, sex: string, hasCom: boolean) {
    const { arr, match } = resolveBucket(age, sex, hasCom);
    if (arr.length === 0) return null;
    return {
      // How the estimate was reached and how much evidence backs it. A
      // median over one agent and a median over thirty are not the same
      // claim, and the caller loads these rows straight into a modelling
      // workstation — the distinction has to travel with the data.
      sim_bucket_match: match,
      sim_bucket_n: arr.length,
      sim_treatment_uptake_mode: modeOf(arr.map((r) => r.outcome.behaviour.treatmentUptake)),
      sim_isolation_days_median: median(arr.map((r) => r.outcome.behaviour.isolationDays)),
      sim_spending_shift_mode: modeOf(arr.map((r) => r.outcome.behaviour.spendingShift)),
      sim_infection_probability_median: Number(
        median(arr.map((r) => r.outcome.health.infectionProbability)).toFixed(3),
      ),
      sim_severity_mode: modeOf(arr.map((r) => r.outcome.health.severityIfInfected)),
      sim_mortality_probability_median: Number(
        median(arr.map((r) => r.outcome.health.mortalityProbability)).toFixed(4),
      ),
      sim_hospitalised_rate: Number(
        (arr.filter((r) => r.outcome.health.hospitalised).length / arr.length).toFixed(3),
      ),
      sim_workdays_lost_median: median(arr.map((r) => r.outcome.economic.workdaysLost)),
      sim_oop_zar_median: Math.round(median(arr.map((r) => r.outcome.economic.outOfPocketCostZar))),
      sim_insurer_claim_zar_median: Math.round(
        median(arr.map((r) => r.outcome.economic.insurerClaimZar)),
      ),
    };
  }

  // Apply lookup to each input row. Try to infer age / sex / comorbidity
  // columns case-insensitively; fall back to global defaults if absent.
  function col<T>(r: Record<string, unknown>, names: string[]): T | undefined {
    const lc = new Map(Object.keys(r).map((k) => [k.toLowerCase(), k] as const));
    for (const n of names) {
      const real = lc.get(n.toLowerCase());
      if (real && r[real] != null) return r[real] as T;
    }
    return undefined;
  }
  const augmented = body.rows.map((row) => {
    const age = Number(col<number | string>(row, ['age', 'age_at_entry', 'ageatentry']) ?? 35);
    const sexRaw = String(col<string>(row, ['sex', 'gender']) ?? 'F').slice(0, 1).toUpperCase();
    const sex = sexRaw === 'M' ? 'M' : 'F';
    const hasCom = !!col<string>(row, ['comorbidities']);
    const out = lookup(age, sex, hasCom);
    return { ...row, ...(out ?? {}) };
  });

  return {
    scenario: body.scenario.trim(),
    drugs,
    refs,
    /** Reference agents that actually answered — the basis of every bucket. */
    sampleSize: results.length,
    /** Requested cohort size, and how many of it failed. */
    requestedSampleSize: sampleSize,
    failedCount,
    /** Echoed so an augmentation can be reproduced exactly. */
    seed,
    /** The reference cohort is deliberately age-balanced, not representative
     *  of SA's pyramid — say so, since these are per-bucket estimates and
     *  the cohort must not be read as a population sample. */
    referenceWeighting: 'age-balanced',
    inputRows: body.rows.length,
    augmentedColumns: Object.keys(augmented[0] ?? {}).filter((k) => k.startsWith('sim_')),
    rows: augmented,
  };
  };

  if (!body.stream) return json(await runFull());

  // SSE variant, same contract as /api/simulate: headers go out immediately
  // so the browser never sees a silent socket, progress events report the
  // reference pass, and the final event carries exactly the payload the JSON
  // branch would have returned.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // client went away — let the run finish quietly
        }
      };
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 20_000);
      send({ type: 'phase', phase: 'refs' });
      try {
        const payload = await runFull((e) => {
          if (e.type === 'sim_start') send({ type: 'phase', phase: 'sim', total: e.total });
          else if (e.type === 'sim_progress')
            send({ type: 'sim_progress', done: e.done, total: e.total });
          else if (e.type === 'sim_done') send({ type: 'phase', phase: 'macro' });
        });
        send({ type: 'result', ...payload });
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
});

interface RefsBody {
  drugs: string[];
}

route('POST', '/api/simulate/references', async ({ req }) => {
  const body = await readBody<RefsBody>(req);
  const drugs = (body.drugs ?? []).filter((d): d is string => !!d && d.trim().length > 0);
  const refs = await fetchReferenceBundle(drugs);
  return json({ refs, formatted: formatReferenceBlock(refs) });
});

function modeOf<T extends string>(xs: T[]): T | '' {
  if (xs.length === 0) return '' as T;
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T = xs[0];
  let bestN = -1;
  for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
  return best;
}

route('GET', '/api/run/:id', ({ params }) => {
  const run = getRun(params.id);
  if (!run) return json({ error: 'run not found' }, { status: 404 });
  return json(run);
});

route('GET', '/api/run/:id/agents/:agentId', ({ params }) => {
  const r = getAgentResult(params.id, params.agentId);
  if (!r) return json({ error: 'agent not found' }, { status: 404 });
  return json(r);
});

interface JustifyBody {
  fresh?: boolean;
  legalJurisdiction?: LegalJurisdiction;
}

route('POST', '/api/run/:id/agents/:agentId/justify', async ({ req, params }) => {
  const run = getRun(params.id);
  if (!run) return json({ error: 'run not found' }, { status: 404 });
  if (params.agentId.startsWith('s-')) {
    return json({ error: 'society agents do not justify' }, { status: 400 });
  }
  const agent = run.councilResults.find((r) => r.agent.id === params.agentId);
  if (!agent) return json({ error: 'agent not found in run' }, { status: 404 });
  const body = await readBody<JustifyBody>(req).catch(() => ({}) as JustifyBody);
  try {
    const canonText = buildCondensedCanon();
    const { record, cached } = await justifyAgent(run, agent, canonText, {
      fresh: body.fresh,
      legalJurisdiction: body.legalJurisdiction,
    });
    return json({
      agentId: record.agentId,
      cached,
      generatedAt: record.generatedAt,
      toolkitVersion: record.toolkitVersion,
      justification: record.justification,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'justify failed' }, { status: 500 });
  }
});

route('GET', '/api/run/:id/agents/:agentId/justify', ({ params }) => {
  const rec = readJustification(params.id, params.agentId);
  if (!rec) return json({ error: 'no justification cached' }, { status: 404 });
  return json({
    agentId: rec.agentId,
    cached: true,
    generatedAt: rec.generatedAt,
    toolkitVersion: rec.toolkitVersion,
    justification: rec.justification,
  });
});

interface JustifyGroupBody {
  fresh?: boolean;
  legalJurisdiction?: LegalJurisdiction;
}

route('POST', '/api/run/:id/group/:profession/justify', async ({ req, params }) => {
  const run = getRun(params.id);
  if (!run) return json({ error: 'run not found' }, { status: 404 });
  const prof = decodeURIComponent(params.profession);
  if (!isProfession(prof)) {
    return json({ error: 'unknown profession' }, { status: 400 });
  }
  const body = await readBody<JustifyGroupBody>(req).catch(() => ({}) as JustifyGroupBody);
  try {
    const canonText = buildCondensedCanon();
    const { record, cached, size } = await justifyGroup(run, prof, canonText, {
      fresh: body.fresh,
      legalJurisdiction: body.legalJurisdiction,
    });
    return json({
      profession: prof,
      groupSize: size,
      cached,
      generatedAt: record.generatedAt,
      toolkitVersion: record.toolkitVersion,
      justification: record.justification,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'justify failed' }, { status: 500 });
  }
});

route('GET', '/api/run/:id/group/:profession/justify', ({ params }) => {
  const prof = decodeURIComponent(params.profession);
  if (!isProfession(prof)) {
    return json({ error: 'unknown profession' }, { status: 400 });
  }
  const rec = readJustification(params.id, groupAgentId(prof));
  if (!rec) return json({ error: 'no group justification cached' }, { status: 404 });
  const run = getRun(params.id);
  const size = run?.councilResults.filter((r) => r.agent.profession === prof).length ?? 0;
  return json({
    profession: prof,
    groupSize: size,
    cached: true,
    generatedAt: rec.generatedAt,
    toolkitVersion: rec.toolkitVersion,
    justification: rec.justification,
  });
});

interface JustifyAllBody {
  fresh?: boolean;
  legalJurisdiction?: LegalJurisdiction;
}

route('POST', '/api/run/:id/justify-all', async ({ req, params }) => {
  const body = await readBody<JustifyAllBody>(req).catch(() => ({}) as JustifyAllBody);
  const handle = startJustifyAllJob(params.id, {
    fresh: body.fresh,
    legalJurisdiction: body.legalJurisdiction,
  });
  if (!handle) {
    return json({ error: 'run not found or has no council results' }, { status: 404 });
  }
  return json(handle);
});

route('GET', '/api/run/:id/justify-all', ({ params }) => {
  const run = getRun(params.id);
  if (!run) return json({ error: 'run not found' }, { status: 404 });
  return json({
    runId: params.id,
    total: run.councilResults.length,
    running: isJustifyAllRunning(params.id),
  });
});

route('GET', '/api/run/:id/justify-all/stream', ({ params }) => {
  let sub: ReturnType<typeof subscribe> = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (ev: SSEEvent) => {
        if (closed) return;
        // forward only justify-related events on this dedicated stream
        if (
          ev.type !== 'justify_start' &&
          ev.type !== 'justify_progress' &&
          ev.type !== 'justify_done' &&
          ev.type !== 'error'
        ) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* controller already closed */
        }
        if (ev.type === 'justify_done' || ev.type === 'error') {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* noop */
          }
        }
      };
      sub = subscribe(params.id, send);
      if (!sub) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error', message: 'run not found' })}\n\n`),
        );
        controller.close();
        return;
      }
      // replay only justify events from history so a late-attaching client catches up
      for (const ev of sub.replay) send(ev);
      // Keep the socket alive across slow per-agent justification calls.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 20_000);
    },
    cancel() {
      sub?.unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

route('GET', '/api/run/:id/justifications', ({ params }) => {
  const items = listJustifications(params.id);
  return json({
    items: items.map((r) => ({
      agentId: r.agentId,
      cached: true,
      generatedAt: r.generatedAt,
      toolkitVersion: r.toolkitVersion,
      justification: r.justification,
    })),
  });
});

interface ChatBody {
  runId: string;
  message: string;
  history?: ChatMessage[];
  fresh?: boolean;
}

// Chat audit trail. Scelo's history view fetches this and merges it with its
// own chat log so one timeline covers every chatbot in the system. `since`
// (epoch ms, exclusive) lets a caller poll for just what is new.
route('GET', '/api/chat-log', async ({ req }) => {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  // Bounded so a long-lived DB can't hand back a 50MB JSON body.
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) || 500, 1), 2000);
  try {
    const rows = db
      .prepare(
        `SELECT id, run_id, role, content, provider, model, created_at
           FROM chat_log
          WHERE created_at > ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(since, limit) as Array<{
      id: number;
      run_id: string;
      role: string;
      content: string;
      provider: string | null;
      model: string | null;
      created_at: number;
    }>;
    return json({
      entries: rows.map((r) => ({
        id: `swarm-${r.id}`,
        ts: r.created_at,
        runId: r.run_id,
        role: r.role,
        content: r.content,
        provider: r.provider,
        model: r.model,
      })),
      // Tells the caller whether it hit the cap and should page further back.
      truncated: rows.length === limit,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), entries: [] }, { status: 500 });
  }
});

route('POST', '/api/chat', async ({ req }) => {
  const body = await readBody<ChatBody>(req);
  if (!body.runId || !body.message?.trim()) {
    return new Response(JSON.stringify({ error: 'runId and message required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      // Time-to-first-token on a local model with a long context can exceed
      // idle timeouts; comment heartbeats keep the socket warm until tokens flow.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      try {
        const gen = streamChat(body.runId, body.message.trim(), body.history ?? [], {
          fresh: body.fresh,
        });
        let res: IteratorResult<string, { provider: string; model: string; full: string }>;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          res = await gen.next();
          if (res.done) {
            send({ type: 'done', provider: res.value.provider, model: res.value.model });
            break;
          }
          send({ type: 'chunk', text: res.value });
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

route('GET', '/api/run/:id/stream', ({ params }) => {
  let sub: ReturnType<typeof subscribe> = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      sub = subscribe(params.id, send);
      if (!sub) {
        // Run not in-memory; emit the persisted terminal state, then close.
        // EVERY branch must send a terminal event: EventSource silently
        // reconnects to a stream that closes without data, so an empty close
        // here left the client re-polling forever with the UI stuck on
        // "running…" — the post-restart freeze. A run that the DB still calls
        // running/pending without an in-memory record is an orphan the boot
        // reconciliation somehow missed; report it as interrupted.
        const run = getRun(params.id);
        if (!run) {
          send({ type: 'error', message: 'run not found' });
        } else if (run.summary) {
          send({ type: 'status', status: run.status });
          send({ type: 'done', runId: run.id, summary: run.summary });
        } else if (run.status === 'failed') {
          send({ type: 'status', status: run.status });
          send({ type: 'error', message: run.error ?? 'run failed' });
        } else {
          send({ type: 'status', status: 'failed' });
          send({ type: 'error', message: 'interrupted: server restarted before the run completed' });
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      // replay history first
      for (const ev of sub.replay) send(ev);
      // Heartbeat comments keep the socket alive through idle timeouts (Bun
      // caps idleTimeout at 255s; a single slow LLM call between events can
      // exceed it). EventSource ignores `:`-prefixed lines.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 20_000);
    },
    cancel() {
      sub?.unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

function redact(s: string): string {
  // strip anything that looks like a bearer token / key from upstream error bodies
  return s.replace(/(sk-[A-Za-z0-9_\-]{8,})/g, '<key>').replace(/(Bearer\s+[^\s"']+)/g, 'Bearer <key>');
}

await router.init();
const canonInit = await initCanon();
console.log(`[swarm-council] canon: ${canonInit.source} (${canonInit.count} works)`);

const server = Bun.serve({
  port: PORT,
  // Bun's default idleTimeout is 10s, which kills any response that goes
  // quiet — observed in the wild on SSE streams whose next event (an LLM
  // call) took longer than that. 255 is the maximum Bun accepts.
  idleTimeout: 255,
  development: process.env.NODE_ENV !== 'production',
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let resp: Response;
      try {
        resp = await r.handler({ req, url, params });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resp = new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      const headers = new Headers(resp.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(resp.body, { status: resp.status, headers });
    }

    return new Response('not found', { status: 404 });
  },
});

const info = router.info();
console.log(`[swarm-council] api on http://localhost:${server.port}`);
console.log(
  `[swarm-council] ollama models: ${info.ollamaModels.length} (selected: ${info.ollamaSelected ?? 'none'})`,
);
