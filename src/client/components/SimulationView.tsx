// SIMULATION tab — population simulation surface for the swarms app.
//
// Inputs:
//   • scenario text (medical or social shock)
//   • optional drug list resolved via PubChem / OpenFDA / ChEMBL
//   • SA-anchored sample size (default 200, capped at 2000)
//   • country population scaling (default SA 62.27M)
//
// Output panels:
//   • macro dashboard — workdays lost, GDP drag, mortality, claims, etc.
//   • reference data preview — what we pulled and will inject verbatim
//   • per-agent rows — Scelo-ready table with download / send-to-Scelo
//   • narrative provenance — every macro multiplier with its source

import { useCallback, useEffect, useMemo, useState } from 'react';
import { colorsForTheme } from '../../shared/constants';
import { AGE_BANDS, ageBandLabel } from '../../shared/bands';
import { useTheme } from '../lib/theme';
import { EditableNumber, magnitudeEdit } from './EditableNumber';
import { DeliberationOverlay, useElapsed } from './DeliberationOverlay';
import { HalfDonut } from './HalfDonut';
import { BarChart } from './BarChart';

type SimRow = Record<string, string | number | boolean>;

interface RefSummary {
  drugs: Array<{
    name: string;
    pubchem: { cid: number; formula: string; molecularWeight: number; iupac: string } | null;
    openFda: { totalReports: number; topReactions: Array<{ term: string; count: number }> } | null;
    chembl: {
      preferredName: string;
      maxPhase: number;
      mechanism: string | null;
      target: string | null;
    } | null;
  }>;
}

interface MacroSummary {
  population: number;
  /** Agents that answered. Every macro figure scales off this, not off the
   *  requested sample size. */
  sampleSize: number;
  /** Agents whose call failed and were excluded. */
  failedCount: number;
  scaleFactor: number;
  workdaysLostTotal: number;
  gdpDragZar: number;
  severeOrCriticalCount: number;
  excessMortality: number;
  insurerClaimsZar: number;
  oopCostsZar: number;
  hospitalAdmissions: number;
  hospitalCostZar: number;
  severeIllnessCostZar: number;
  workdaysByAge: Array<{ band: string; lost: number }>;
  mortalityByComorbidity: Array<{ status: string; deaths: number }>;
  uptake: { accepted: number; declined: number; unsure: number };
  spending: { reduced: number; unchanged: number; increased: number };
}

interface SimResponse {
  scenario: string;
  drugs: string[];
  refs: RefSummary;
  macro: MacroSummary;
  macroProvenance: string[];
  rows: SimRow[];
  columns: string[];
  sampleSize: number;
  population: number;
  /** Population seed the server actually used — pin it to reproduce a run. */
  seed: number;
  timings: { refMs: number; simMs: number };
}

const TEMPLATES: Array<{ label: string; scenario: string; drugs: string[] }> = [
  {
    label: 'Novel respiratory virus + paxlovid',
    scenario:
      'A novel SARS-CoV-2-like respiratory virus is spreading in SA: R₀≈2.4, IFR concentrated in 65+ and immunocompromised. Paxlovid (nirmatrelvir/ritonavir) is available within 5 days of symptom onset, R5,800 / course at private pharmacies, free at public clinics for high-risk patients. Hospitals run at 85% baseline occupancy. Describe what you would do.',
    drugs: ['nirmatrelvir', 'ritonavir'],
  },
  {
    label: 'HIV: dolutegravir-based ART regimen change',
    scenario:
      'The SA National Department of Health is switching first-line ART from EFV-based to dolutegravir-based (DTG/3TC/TDF) for all adults on treatment. Switch happens at next clinic visit; existing patients keep prior regimen until then. Some concern about weight gain and rare hypersensitivity. What changes for you?',
    drugs: ['dolutegravir', 'lamivudine', 'tenofovir'],
  },
  {
    label: 'New oral GLP-1 for diabetes + obesity',
    scenario:
      'A new oral GLP-1 agonist is launched in SA at R3,200/month for diabetes + adjunct obesity management. Medical schemes cover for HbA1c ≥7.5 only. Off-label use for weight loss is common in private clinics. Some risk of GI side effects in first 4 weeks; rare pancreatitis. Would you start treatment?',
    drugs: ['semaglutide'],
  },
  {
    label: 'Social: pension contribution rate hike',
    scenario:
      'Treasury announces a mandatory increase in retirement-fund contributions from 7.5% to 12% of pensionable salary, effective in 12 months. Employer match cap unchanged. How would you adjust spending, savings, and any private retirement provision?',
    drugs: [],
  },
];

function ZAR(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `R${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `R${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `R${(n / 1e3).toFixed(1)}k`;
  return `R${n.toFixed(0)}`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function downloadCsv(rows: SimRow[], columns: string[], filename: string): void {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Live progress relayed by the server's SSE variant of /api/simulate.
export interface SimProgress {
  phase: 'refs' | 'sim' | 'macro';
  done: number;
  total: number;
}

// All Simulation-tab state lives here so it can be owned by App (lifted out of
// the view), which keeps the scenario, sliders, and results alive across tab
// switches even when the view itself unmounts.
export interface SimulationState {
  scenario: string;
  setScenario: (s: string) => void;
  drugsText: string;
  setDrugsText: (s: string) => void;
  sampleSize: number;
  setSampleSize: (n: number) => void;
  population: number;
  setPopulation: (n: number) => void;
  busy: boolean;
  error: string | null;
  result: SimResponse | null;
  progress: SimProgress | null;
  /** Overlay tucked away by the user; the run continues regardless. */
  overlayHidden: boolean;
  setOverlayHidden: (v: boolean) => void;
  /** Empty string = draw a fresh cohort each run. */
  seedPin: string;
  setSeedPin: (v: string) => void;
  onTemplate: (idx: number) => void;
  run: () => void;
}

export function useSimulationState(): SimulationState {
  const [scenario, setScenario] = useState<string>(TEMPLATES[0].scenario);
  const [drugsText, setDrugsText] = useState<string>(TEMPLATES[0].drugs.join(', '));
  const [sampleSize, setSampleSize] = useState<number>(120);
  const [population, setPopulation] = useState<number>(62_270_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimResponse | null>(null);
  const [progress, setProgress] = useState<SimProgress | null>(null);
  const [overlayHidden, setOverlayHidden] = useState(false);
  // Blank = an independent draw each run (the default, and what makes this a
  // Monte Carlo rather than a replay). Set = reproduce that exact run.
  const [seedPin, setSeedPin] = useState<string>('');

  const onTemplate = (idx: number) => {
    const t = TEMPLATES[idx];
    setScenario(t.scenario);
    setDrugsText(t.drugs.join(', '));
  };

  const run = useCallback(() => {
    setBusy(true);
    setError(null);
    setResult(null); // clear the prior run so the progress panel shows cleanly
    setProgress(null);
    setOverlayHidden(false);
    const drugs = drugsText
      .split(/[,\n]/)
      .map((d) => d.trim())
      .filter(Boolean);
    // stream:true → SSE. A full run is minutes of LLM calls; a single JSON
    // response that long has no bytes on the wire until the very end and
    // browsers kill it (~300s no-headers timeout in Chrome). The stream
    // sends headers immediately and progress events keep the socket warm.
    (async () => {
      const r = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenario,
          drugs,
          sampleSize,
          population,
          stream: true,
          // Omitted unless pinned — the server then draws an independent
          // cohort, which is the whole point of re-running.
          ...(seedPin.trim() !== '' && Number.isFinite(Number(seedPin))
            ? { seed: Number(seedPin) }
            : {}),
        }),
      });
      if (!r.ok) throw new Error(`/api/simulate ${r.status}`);
      // Old server (no stream support) answers with plain JSON — accept it.
      if (r.headers.get('content-type')?.includes('application/json')) {
        return (await r.json()) as SimResponse;
      }
      if (!r.body) throw new Error('/api/simulate returned no body');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final: SimResponse | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const raw of events) {
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === 'phase') {
            const phase = ev.phase as SimProgress['phase'];
            setProgress((p) => ({
              phase,
              done: phase === 'macro' ? (p?.total ?? 0) : (p?.done ?? 0),
              total: typeof ev.total === 'number' ? ev.total : (p?.total ?? 0),
            }));
          } else if (ev.type === 'sim_progress') {
            setProgress({
              phase: 'sim',
              done: Number(ev.done ?? 0),
              total: Number(ev.total ?? 0),
            });
          } else if (ev.type === 'error') {
            throw new Error(String(ev.message ?? 'simulation failed'));
          } else if (ev.type === 'result') {
            const { type: _type, ...payload } = ev;
            final = payload as unknown as SimResponse;
          }
        }
      }
      if (!final) throw new Error('stream ended without a result');
      return final;
    })()
      .then((res) => setResult(res))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [scenario, drugsText, sampleSize, population, seedPin]);

  return {
    scenario,
    setScenario,
    drugsText,
    setDrugsText,
    sampleSize,
    setSampleSize,
    population,
    setPopulation,
    busy,
    error,
    result,
    progress,
    overlayHidden,
    setOverlayHidden,
    seedPin,
    setSeedPin,
    onTemplate,
    run,
  };
}

export function SimulationView({ state }: { state: SimulationState }) {
  const {
    scenario,
    setScenario,
    drugsText,
    setDrugsText,
    sampleSize,
    setSampleSize,
    population,
    setPopulation,
    busy,
    error,
    result,
    progress,
    overlayHidden,
    setOverlayHidden,
    seedPin,
    setSeedPin,
    onTemplate,
    run,
  } = state;

  return (
    <div className="simulation-view">
      <header className="simulation-header">
        <div className="panel-label">scenario · medical or social shock</div>
        <div className="simulation-templates">
          {TEMPLATES.map((t, i) => (
            <button
              key={t.label}
              type="button"
              className="scenario-preset-chip"
              onClick={() => onTemplate(i)}
              disabled={busy}
              title={t.scenario}
            >
              {t.label}
            </button>
          ))}
        </div>
        <textarea
          className="scenario-card-input"
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          placeholder="paste a medical or social scenario…"
          rows={5}
          disabled={busy}
        />
        <div className="simulation-controls">
          <label className="simulation-control">
            <span className="panel-label">drugs / compounds</span>
            <input
              type="text"
              value={drugsText}
              onChange={(e) => setDrugsText(e.target.value)}
              placeholder="comma-separated · resolved via PubChem + OpenFDA + ChEMBL"
              disabled={busy}
            />
          </label>
          <div className="simulation-control">
            <span className="panel-label">
              sample size ·{' '}
              <EditableNumber
                value={sampleSize}
                min={20}
                max={1000}
                step={20}
                format={(v) => String(v)}
                onChange={setSampleSize}
                disabled={busy}
                ariaLabel="sample size value"
              />
            </span>
            <input
              type="range"
              min={20}
              max={1000}
              step={20}
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
              disabled={busy}
              aria-label="sample size"
            />
          </div>
          <div className="simulation-control">
            <span className="panel-label">
              seed{' '}
              <span className="sim-seed-hint">
                {seedPin.trim() === '' ? 'random each run' : 'pinned — reproduces exactly'}
              </span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={seedPin}
              onChange={(e) => setSeedPin(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="blank = new draw"
              disabled={busy}
            />
          </div>
          <div className="simulation-control">
            <span className="panel-label">
              population ·{' '}
              <EditableNumber
                value={population}
                min={1_000_000}
                max={200_000_000}
                step={1_000_000}
                format={(v) => ZAR(v).replace('R', '')}
                onChange={setPopulation}
                disabled={busy}
                ariaLabel="population value"
                {...magnitudeEdit}
              />
            </span>
            <input
              type="range"
              min={1_000_000}
              max={200_000_000}
              step={1_000_000}
              value={population}
              onChange={(e) => setPopulation(Number(e.target.value))}
              disabled={busy}
              aria-label="population"
            />
          </div>
          <button
            type="button"
            className="primary-btn pill-btn"
            onClick={run}
            disabled={busy || scenario.trim().length < 4}
          >
            {busy ? 'simulating…' : '▶ run simulation'}
          </button>
        </div>
        {error && <div className="simulation-error">error: {error}</div>}
      </header>

      {busy && !result && <SimulationProgress progress={progress} />}
      {busy && !result && !overlayHidden && (
        <SimulationOverlay
          progress={progress}
          sampleSize={sampleSize}
          onHide={() => setOverlayHidden(true)}
        />
      )}
      {result && <SimulationResults result={result} onPinSeed={setSeedPin} />}
    </div>
  );
}

// In-progress panel for /api/simulate. The SSE stream reports which pipeline
// phase the server is actually in plus a done/total counter for the per-agent
// pass, so the panel shows real progress; the elapsed timer runs locally.
const SIM_PHASES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'refs', label: 'Resolving compound references', hint: 'PubChem · OpenFDA · ChEMBL' },
  { key: 'sim', label: 'Simulating agent outcomes', hint: 'per-agent disease course' },
  { key: 'macro', label: 'Scaling macro impact', hint: 'cohort → national' },
];

/** Drives the shared deliberation overlay from the simulation's own feed.
 *  The ring's seats are agents in the sample; the centre ticks are the three
 *  server phases. Only the 'sim' phase reports counts, so the other two show
 *  the indeterminate comet rather than a fabricated bar. */
function SimulationOverlay({
  progress,
  sampleSize,
  onHide,
}: {
  progress: SimProgress | null;
  sampleSize: number;
  onHide: () => void;
}) {
  const elapsed = useElapsed(true);
  const phaseIdx = Math.max(0, SIM_PHASES.findIndex((p) => p.key === (progress?.phase ?? 'refs')));
  const inSim = progress?.phase === 'sim' && progress.total > 0;
  const ph = SIM_PHASES[phaseIdx];
  // Reference resolution and the macro roll-up report no counts of their own,
  // so the bar tracks phase position there and the real agent count during the
  // simulation itself — never a fabricated crawl.
  const simFrac = inSim
    ? progress.total > 0
      ? progress.done / progress.total
      : 0
    : phaseIdx / Math.max(1, SIM_PHASES.length - 1);

  return (
    <DeliberationOverlay
      eyebrow={`simulation · ${sampleSize} agents`}
      elapsed={elapsed}
      title={ph.label}
      subtitle={inSim ? `${progress.done} / ${progress.total} agents simulated` : ph.hint}
      total={inSim ? progress.total : sampleSize}
      litSeats={inSim ? progress.done : progress?.phase === 'macro' ? sampleSize : 0}
      ticks={SIM_PHASES.length}
      tickCurrent={phaseIdx + 1}
      // The council overlay has always had a bar; this one passed null and so
      // rendered none, leaving the reference and macro phases with nothing but
      // three pips to say how far along they were.
      outerFrac={simFrac}
      indeterminate={!inSim}
      onHide={onHide}
    />
  );
}

function SimulationProgress({ progress }: { progress: SimProgress | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t0 = performance.now();
    const tick = window.setInterval(() => setElapsed((performance.now() - t0) / 1000), 100);
    return () => window.clearInterval(tick);
  }, []);

  const phase = Math.max(
    0,
    SIM_PHASES.findIndex((p) => p.key === (progress?.phase ?? 'refs')),
  );
  const pct =
    progress && progress.phase === 'sim' && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;

  return (
    <div className="sim-progress" role="status" aria-live="polite">
      <div className="sim-progress-head">
        <span className="sim-progress-eyebrow">simulating</span>
        <span className="sim-progress-elapsed">{elapsed.toFixed(1)}s</span>
      </div>
      <ul className="sim-progress-phases">
        {SIM_PHASES.map((ph, i) => {
          const state = i < phase ? 'done' : i === phase ? 'active' : 'pending';
          const counter =
            ph.key === 'sim' && progress && progress.total > 0 && i <= phase
              ? ` · ${progress.done}/${progress.total} agents${pct !== null ? ` (${pct}%)` : ''}`
              : '';
          return (
            <li key={ph.key} className={`sim-phase is-${state}`}>
              <span className="sim-phase-dot" aria-hidden />
              <span className="sim-phase-label">{ph.label}{counter}</span>
              <span className="sim-phase-hint">{ph.hint}</span>
            </li>
          );
        })}
      </ul>
      <div className="sim-progress-bar" aria-hidden>
        <span
          style={
            pct !== null
              ? { width: `${pct}%`, left: 0, animation: 'none', transition: 'width 0.4s ease' }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function SimulationResults({
  result,
  onPinSeed,
}: { result: SimResponse; onPinSeed: (seed: string) => void }) {
  return (
    <div className="simulation-results">
      <section className="simulation-section">
        <div className="panel-label">macro impact · scaled to {ZAR(result.population).replace('R', '')} population</div>
        <MacroLedger macro={result.macro} />
      </section>

      <section className="simulation-section">
        <div className="panel-label">treatment uptake · spending response</div>
        <div className="simulation-breakdown">
          <div className="simulation-breakdown-col">
            <div className="muted small">treatment uptake</div>
            <BreakdownBar
              name="treatment uptake"
              values={result.macro.uptake}
              order={[
                { key: 'accepted', tone: 'ok' },
                { key: 'declined', tone: 'bad' },
                { key: 'unsure', tone: 'neutral' },
              ]}
            />
          </div>
          <div className="simulation-breakdown-col">
            <div className="muted small">spending response</div>
            <BreakdownBar
              name="spending response"
              values={result.macro.spending}
              order={[
                { key: 'reduced', tone: 'bad' },
                { key: 'unchanged', tone: 'neutral' },
                { key: 'increased', tone: 'ok' },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="simulation-section">
        <div className="panel-label">distributional · workdays lost by age (scaled)</div>
        <Distributional macro={result.macro} />
      </section>

      {result.refs.drugs.length > 0 && (
        <section className="simulation-section">
          <div className="panel-label">reference data · cited verbatim into every agent's prompt</div>
          <div className="simulation-refs">
            {result.refs.drugs.map((d) => (
              <div key={d.name} className="simulation-ref">
                <div className="simulation-ref-head">{d.name}</div>
                {d.pubchem && (
                  <div className="muted small">
                    PubChem CID {d.pubchem.cid} · {d.pubchem.formula} · MW {d.pubchem.molecularWeight.toFixed(2)}
                  </div>
                )}
                {d.chembl && (
                  <div className="muted small">
                    ChEMBL · {d.chembl.preferredName} · phase {d.chembl.maxPhase}
                    {d.chembl.mechanism && <span> · {d.chembl.mechanism}</span>}
                  </div>
                )}
                {d.openFda && d.openFda.totalReports > 0 && (
                  <div className="muted small">
                    OpenFDA · {d.openFda.totalReports.toLocaleString()} FAERS reports · top: {d.openFda.topReactions.slice(0, 5).map((r) => `${r.term} (${r.count})`).join(', ')}
                  </div>
                )}
                {!d.pubchem && !d.chembl && (!d.openFda || d.openFda.totalReports === 0) && (
                  <div className="muted small">no reference data resolved</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="simulation-section">
        <div className="panel-label">macro multipliers · provenance</div>
        <ul className="simulation-provenance">
          {result.macroProvenance.map((p) => (
            <li key={p} className="muted small">{p}</li>
          ))}
        </ul>
      </section>

      {result.macro.failedCount > 0 && (
        <section className="simulation-section">
          <div className="muted small" style={{ color: 'var(--status-err, #d66)' }}>
            {result.macro.failedCount} of {result.macro.failedCount + result.macro.sampleSize} agents
            returned nothing usable and were excluded — the macro figures above scale off the{' '}
            {result.macro.sampleSize} that answered. Those rows are kept in the dataset with{' '}
            <code>sim_status</code> set to the reason and an empty rationale; filter them out before
            modelling.
          </div>
        </section>
      )}

      <section className="simulation-section">
        <div className="panel-label">
          per-agent simulated dataset · {result.rows.length} rows × {result.columns.length} cols
          <button
            type="button"
            className="ghost-btn"
            style={{ marginLeft: '12px' }}
            onClick={() => downloadCsv(result.rows, result.columns, `simulation-${Date.now()}.csv`)}
          >
            ↓ download CSV
          </button>
        </div>
        <p className="muted small">
          Same shape Scelo's Soft Data expects — load directly into the <code>/dashboards/scelo/soft</code> workstation
          for cleaning, modelling, or further analytics.
        </p>

        <DatasetDashboard rows={result.rows} />
      </section>

      <footer className="muted small simulation-footer">
        simulated in {(result.timings.simMs / 1000).toFixed(1)}s · references resolved in {(result.timings.refMs / 1000).toFixed(2)}s · scale factor {result.macro.scaleFactor.toFixed(0)}×
        {result.seed !== undefined && (
          <>
            {' · seed '}
            <span className="sim-seed-value">{result.seed}</span>{' '}
            <button
              type="button"
              className="sim-seed-pin"
              onClick={() => onPinSeed(String(result.seed))}
              title="Pin this seed so the next run reproduces this exact cohort and table"
            >
              pin
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

// ── Per-agent dashboard ────────────────────────────────────────────────────
//
// The CSV is the deliverable — 120 rows × 29 columns, exactly the shape
// Scelo's Soft Data expects. This is how you read it without downloading it:
// nobody learns the shape of a cohort from the first 20 of its rows, which is
// all the preview table ever showed before it was removed.
//
// Everything here is computed from the rows themselves rather than handed
// down from the macro layer, so it describes the table you are about to
// download rather than a parallel summary of it. Failed agents are excluded
// on the same rule the macro layer uses: their placeholder outcome is all
// zeros and would read as a cohort of people who shrugged.

const SEVERITY_ORDER = ['asymptomatic', 'mild', 'moderate', 'severe', 'critical'];

function tally<T extends string>(rows: SimRow[], key: string, keys: readonly T[]): Record<T, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<T, number>;
  for (const r of rows) {
    const v = String(r[key] ?? '') as T;
    if (v in out) out[v] += 1;
  }
  return out;
}

/** Distinct values of a column, most common first — the axis order for a
 *  categorical the server never declared a canonical order for. */
function categoriesOf(rows: SimRow[], key: string): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = String(r[key] ?? '').trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function DatasetDashboard({ rows }: { rows: SimRow[] }) {
  const { resolved } = useTheme();
  const c = colorsForTheme(resolved);
  const usable = useMemo(() => rows.filter((r) => String(r.sim_status ?? 'ok') === 'ok'), [rows]);

  const charts = useMemo(() => {
    const bands = [...AGE_BANDS];
    const bandOf = (r: SimRow) => ageBandLabel(Number(r.age) || 0);

    // Cohort by age × sex — who was actually simulated, before any outcome.
    const bySexBand = (sex: string) =>
      bands.map((b) => usable.filter((r) => bandOf(r) === b && String(r.sex) === sex).length);

    // Uptake by age band: the cross-cut a single uptake share cannot show —
    // whether refusal concentrates anywhere in particular.
    const uptakeIn = (band: string, uptake: string) =>
      usable.filter((r) => bandOf(r) === band && String(r.sim_treatment_uptake) === uptake).length;

    const severity = tally(usable, 'sim_severity_if_infected', SEVERITY_ORDER);

    // Out-of-pocket by income band — median, not mean: a single R5,800 course
    // in a band of six drags a mean into describing nobody.
    const incomeBands = categoriesOf(usable, 'income_band');
    const oopByIncome = incomeBands.map((b) =>
      median(usable.filter((r) => String(r.income_band) === b).map((r) => Number(r.sim_oop_zar) || 0)),
    );

    return { bands, bySexBand, uptakeIn, severity, incomeBands, oopByIncome };
  }, [usable]);

  if (usable.length === 0) return null;

  return (
    <div className="sim-chart-grid">
      <div className="sim-chart">
        <div className="muted small sim-chart-title">cohort · age × sex</div>
        {/* The palette's categorical trio, not the status ramp: sex has no
            valence, and consensus-green against adversarial-red would encode
            one sex as the good outcome. Olive and steel also sidestep the
            pink/blue convention. (`accent` is byte-identical to `consensus`,
            so the two series here used to render as one colour.) */}
        <BarChart
          stacked
          categories={charts.bands}
          series={[
            { name: 'female', color: c.chartT, data: charts.bySexBand('F') },
            { name: 'male', color: c.chartM, data: charts.bySexBand('M') },
          ]}
        />
      </div>

      <div className="sim-chart">
        <div className="muted small sim-chart-title">treatment uptake · by age band</div>
        <BarChart
          stacked
          categories={charts.bands}
          series={[
            { name: 'accepted', color: c.consensus, data: charts.bands.map((b) => charts.uptakeIn(b, 'accepted')) },
            { name: 'declined', color: c.adversarial, data: charts.bands.map((b) => charts.uptakeIn(b, 'declined')) },
            { name: 'unsure', color: c.muted, data: charts.bands.map((b) => charts.uptakeIn(b, 'unsure')) },
          ]}
        />
      </div>

      <div className="sim-chart">
        <div className="muted small sim-chart-title">severity if infected · agents</div>
        <BarChart
          categories={SEVERITY_ORDER}
          series={[
            {
              name: 'agents',
              color: c.dissent,
              data: SEVERITY_ORDER.map((k) => charts.severity[k as keyof typeof charts.severity]),
            },
          ]}
        />
      </div>

      <div className="sim-chart">
        <div className="muted small sim-chart-title">out-of-pocket · median per agent by income band</div>
        <BarChart
          horizontal
          categories={charts.incomeBands}
          series={[{ name: 'median ZAR', color: c.chartR, data: charts.oopByIncome }]}
          format={(v) => (v >= 1000 ? `R${(v / 1000).toFixed(1)}k` : `R${Math.round(v)}`)}
        />
      </div>
    </div>
  );
}

// ── Distributional charts ──────────────────────────────────────────────────
//
// Both of these were tables. `age band | workdays lost` over eight rows asks
// the reader to compare eight formatted numbers by eye — which is the one
// thing a bar chart does for free, and the only reason anyone reads a
// distribution. The figures are still exact on hover.

function Distributional({ macro }: { macro: MacroSummary }) {
  const { resolved } = useTheme();
  const c = colorsForTheme(resolved);
  return (
    <div className="sim-chart-grid">
      <div className="sim-chart">
        <BarChart
          categories={macro.workdaysByAge.map((r) => r.band)}
          series={[{ name: 'workdays lost', color: c.dissent, data: macro.workdaysByAge.map((r) => r.lost) }]}
          format={compact}
        />
      </div>
      <div className="sim-chart">
        <div className="muted small sim-chart-title">excess mortality by comorbidity status</div>
        <BarChart
          horizontal
          height={150}
          categories={macro.mortalityByComorbidity.map((r) => r.status)}
          series={[
            {
              name: 'deaths',
              color: c.adversarial,
              data: macro.mortalityByComorbidity.map((r) => r.deaths),
            },
          ]}
          format={compact}
        />
      </div>
    </div>
  );
}

/** Axis-friendly magnitudes — 12,558,655 on every tick is a wall of digits. */
function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

// ── Macro impact ───────────────────────────────────────────────────────────
//
// Eight figures. As eight bordered cards they read as a template: a `0` got
// the same box, border and colour block as R75B, the auto-fit grid wrapped to
// a 7 + 1 orphan row, and nothing on screen said which numbers belonged
// together.
//
// Rendered as a statement instead. Three columns by subject, values
// right-aligned in a tabular column so magnitudes line up and can be compared
// down the column — the thing a grid of cards actively prevents — with the
// unit as a dim note after the label. Hairline under each heading, no card
// chrome anywhere.

type MacroStat = {
  label: string;
  value: string;
  sub: string;
  accent: 'ok' | 'warn' | 'error';
};

type MacroGroup = { title: string; stats: MacroStat[] };

function macroGroups(macro: MacroSummary): MacroGroup[] {
  return [
    {
      title: 'labour',
      stats: [
        { label: 'workdays lost', value: fmt(macro.workdaysLostTotal), sub: 'agent × day', accent: 'warn' },
        { label: 'GDP drag', value: ZAR(macro.gdpDragZar), sub: 'lost wage value', accent: 'warn' },
      ],
    },
    {
      title: 'health',
      stats: [
        { label: 'excess mortality', value: fmt(macro.excessMortality), sub: 'modelled deaths', accent: 'error' },
        { label: 'severe / critical', value: fmt(macro.severeOrCriticalCount), sub: 'cases requiring care', accent: 'error' },
        { label: 'hospital admissions', value: fmt(macro.hospitalAdmissions), sub: 'surge above baseline', accent: 'error' },
      ],
    },
    {
      title: 'cost',
      stats: [
        { label: 'hospital cost', value: ZAR(macro.hospitalCostZar), sub: 'admissions × R18.5k avg', accent: 'error' },
        { label: 'insurer claims', value: ZAR(macro.insurerClaimsZar), sub: 'liability impact', accent: 'ok' },
        { label: 'out-of-pocket', value: ZAR(macro.oopCostsZar), sub: 'household burden', accent: 'ok' },
      ],
    },
  ];
}

function accentColor(accent: MacroStat['accent']): string {
  return accent === 'ok'
    ? 'var(--consensus)'
    : accent === 'warn'
      ? 'var(--dissent)'
      : 'var(--adversarial)';
}

function MacroLedger({ macro }: { macro: MacroSummary }) {
  return (
    <div className="macro-ledger">
      {macroGroups(macro).map((g) => (
        <div key={g.title} className="macro-group">
          <div className="panel-label macro-group-title">{g.title}</div>
          {g.stats.map((s) => (
            <div key={s.label} className="macro-row">
              <span className="macro-row-value num" style={{ color: accentColor(s.accent) }}>
                {s.value}
              </span>
              <span className="macro-row-text">
                {s.label}
                <span className="macro-row-sub muted small"> · {s.sub}</span>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Semantic slice tone, resolved to a theme colour here rather than at the
 *  call site: these used to be `var(--consensus)` CSS variables, which a
 *  canvas renderer cannot resolve — ECharts would have drawn them as its
 *  default palette. */
type Tone = 'ok' | 'bad' | 'neutral';

function BreakdownBar({
  name,
  values,
  order,
}: {
  name: string;
  values: Record<string, number>;
  order: Array<{ key: string; tone: Tone }>;
}) {
  const { resolved } = useTheme();
  const c = colorsForTheme(resolved);
  const tone: Record<Tone, string> = {
    ok: c.consensus,
    bad: c.adversarial,
    neutral: c.muted,
  };
  return (
    <HalfDonut
      name={name}
      data={order.map(({ key, tone: t }) => ({
        name: key,
        value: values[key] ?? 0,
        color: tone[t],
      }))}
    />
  );
}
