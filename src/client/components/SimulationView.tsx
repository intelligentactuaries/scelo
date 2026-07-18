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

import { useCallback, useEffect, useState } from 'react';

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
  sampleSize: number;
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
  }, [scenario, drugsText, sampleSize, population]);

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
          <label className="simulation-control">
            <span className="panel-label">sample size · {sampleSize}</span>
            <input
              type="range"
              min={20}
              max={1000}
              step={20}
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
              disabled={busy}
            />
          </label>
          <label className="simulation-control">
            <span className="panel-label">population · {ZAR(population).replace('R', '')}</span>
            <input
              type="range"
              min={1_000_000}
              max={200_000_000}
              step={1_000_000}
              value={population}
              onChange={(e) => setPopulation(Number(e.target.value))}
              disabled={busy}
            />
          </label>
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
      {result && <SimulationResults result={result} />}
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

// The dataset carries ~10 demographic columns before the sim_* outputs, so a
// naive first-N slice used to preview demographics only — the one thing the
// panel exists to show (the simulated outcomes) never made it on screen.
const PREVIEW_COLUMNS = [
  'id',
  'age',
  'sex',
  'region',
  'employment',
  'sim_treatment_uptake',
  'sim_severity_if_infected',
  'sim_workdays_lost',
  'sim_oop_zar',
  'sim_rationale',
];

function previewColumns(all: string[]): string[] {
  const curated = PREVIEW_COLUMNS.filter((c) => all.includes(c));
  return curated.length > 0 ? curated : all.slice(0, 8);
}

function SimulationResults({ result }: { result: SimResponse }) {
  const cols = previewColumns(result.columns);
  return (
    <div className="simulation-results">
      <section className="simulation-section">
        <div className="panel-label">macro impact · scaled to {ZAR(result.population).replace('R', '')} population</div>
        <div className="simulation-macro-grid">
          <MacroTile label="workdays lost" value={fmt(result.macro.workdaysLostTotal)} sub="agent × day" accent="warn" />
          <MacroTile label="GDP drag" value={ZAR(result.macro.gdpDragZar)} sub="lost wage value" accent="warn" />
          <MacroTile label="excess mortality" value={fmt(result.macro.excessMortality)} sub="modelled deaths" accent="error" />
          <MacroTile label="severe / critical" value={fmt(result.macro.severeOrCriticalCount)} sub="cases requiring care" accent="error" />
          <MacroTile label="hospital admissions" value={fmt(result.macro.hospitalAdmissions)} sub="surge above baseline" accent="error" />
          <MacroTile label="hospital cost" value={ZAR(result.macro.hospitalCostZar)} sub="admissions × R18.5k avg" accent="error" />
          <MacroTile label="insurer claims" value={ZAR(result.macro.insurerClaimsZar)} sub="liability impact" accent="ok" />
          <MacroTile label="out-of-pocket" value={ZAR(result.macro.oopCostsZar)} sub="household burden" accent="ok" />
        </div>
      </section>

      <section className="simulation-section">
        <div className="panel-label">treatment uptake · spending response</div>
        <div className="simulation-breakdown">
          <div className="simulation-breakdown-col">
            <div className="muted small">treatment uptake</div>
            <BreakdownBar values={result.macro.uptake} order={['accepted', 'declined', 'unsure']} colors={{ accepted: 'var(--consensus)', declined: 'var(--adversarial)', unsure: 'var(--muted)' }} />
          </div>
          <div className="simulation-breakdown-col">
            <div className="muted small">spending response</div>
            <BreakdownBar values={result.macro.spending} order={['reduced', 'unchanged', 'increased']} colors={{ reduced: 'var(--adversarial)', unchanged: 'var(--muted)', increased: 'var(--consensus)' }} />
          </div>
        </div>
      </section>

      <section className="simulation-section">
        <div className="panel-label">distributional · workdays lost by age</div>
        <table className="syn-table">
          <thead>
            <tr><th>age band</th><th className="num">workdays lost (scaled)</th></tr>
          </thead>
          <tbody>
            {result.macro.workdaysByAge.map((r) => (
              <tr key={r.band}><td>{r.band}</td><td className="num">{fmt(r.lost)}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="simulation-section">
        <div className="panel-label">distributional · excess mortality by comorbidity status</div>
        <table className="syn-table">
          <thead>
            <tr><th>status</th><th className="num">deaths (scaled)</th></tr>
          </thead>
          <tbody>
            {result.macro.mortalityByComorbidity.map((r) => (
              <tr key={r.status}><td>{r.status}</td><td className="num">{fmt(r.deaths)}</td></tr>
            ))}
          </tbody>
        </table>
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
        <div className="simulation-table-wrap">
          <table className="simulation-rows-table">
            <thead>
              <tr>
                {cols.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 20).map((r, i) => (
                <tr key={String(r.id ?? i)}>
                  {cols.map((c) => (
                    <td key={c}>{String(r[c] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > 20 && (
            <div className="muted small" style={{ padding: '6px 10px' }}>
              … {result.rows.length - 20} more rows in the CSV.
            </div>
          )}
        </div>
      </section>

      <footer className="muted small simulation-footer">
        simulated in {(result.timings.simMs / 1000).toFixed(1)}s · references resolved in {(result.timings.refMs / 1000).toFixed(2)}s · scale factor {result.macro.scaleFactor.toFixed(0)}×
      </footer>
    </div>
  );
}

function MacroTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent: 'ok' | 'warn' | 'error';
}) {
  const color = accent === 'ok' ? 'var(--consensus)' : accent === 'warn' ? 'var(--dissent)' : 'var(--adversarial)';
  return (
    <div className="simulation-macro-tile">
      <div className="panel-label">{label}</div>
      <div className="simulation-macro-value" style={{ color }}>{value}</div>
      <div className="muted small">{sub}</div>
    </div>
  );
}

function BreakdownBar({
  values,
  order,
  colors,
}: {
  values: Record<string, number>;
  order: string[];
  colors: Record<string, string>;
}) {
  const total = order.reduce((s, k) => s + (values[k] ?? 0), 0);
  return (
    <div>
      <div className="stack-bar">
        {order.map((k) => (
          <div
            key={k}
            className="stack-seg"
            style={{ flex: Math.max(values[k] ?? 0, 0.0001), background: colors[k] }}
          />
        ))}
      </div>
      <div className="syn-legend muted small" style={{ marginTop: 4 }}>
        {order.map((k) => (
          <span key={k}>
            <i style={{ background: colors[k] }} /> {k} {total > 0 ? `${Math.round(((values[k] ?? 0) / total) * 100)}%` : '—'}
          </span>
        ))}
      </div>
    </div>
  );
}
