// SimulateScenarioModal — Scelo Soft Data integration point for the
// swarms population simulator at :3010.
//
// Two modes:
//   • generate — create a brand-new synthetic dataset from a scenario
//                + reference data, load it as the Soft Data dataset.
//   • augment  — given the currently-loaded dataset, derive sim_*
//                columns per row via a sample-then-extrapolate pattern
//                so 10k-row datasets don't trigger 10k LLM calls.

import { Arrow } from "@/components/Arrow";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EditableNumber } from "./EditableNumber";
import type { CellValue, Dataset, Row } from "./SoftDataWorkstation";
import { UploadIndicator, type UploadState } from "./UploadIndicator";

import { swarmApiLabel, swarmApiUrl, swarmStartHint } from "../../lib/swarmConfig";

// Augment serialises EVERY dataset row into a single JSON request body.
// Past ~100k rows that stops being viable: a default Bun server severs
// bodies over ~128 MB (surfacing as a bare "Failed to fetch"), and
// JSON.stringify itself throws a RangeError around ~1M rows. Import
// caps datasets at 250k rows, so oversize datasets do reach this modal.
const AUGMENT_ROW_LIMIT = 100_000;

// When a network-level failure coincides with a request body this
// large, the severed-body explanation is at least as likely as
// "server not running" — say so instead of only blaming the server.
const BODY_SIZE_HINT_BYTES = 64 * 1024 * 1024;

/** Error surface for a failed swarm call: what happened + (optionally)
 *  what to do about it. Only network-level failures get the "is the
 *  server running" hint — an HTTP error proves the server is up. */
export type SwarmFailure = { message: string; hint: string | null };

/** Pre-flight guard for augment mode. Returns the blocking message, or
 *  null when the dataset is small enough to send. Exported for tests. */
export function augmentRowGuard(rowCount: number, sourceTotalRows?: number): string | null {
  if (rowCount <= AUGMENT_ROW_LIMIT) return null;
  const sampleNote =
    sourceTotalRows && sourceTotalRows > rowCount
      ? ` (a sample of ${sourceTotalRows.toLocaleString()})`
      : "";
  return `augment sends every row to the swarm server — your dataset has ${rowCount.toLocaleString()} rows${sampleNote}; the practical limit is ~${AUGMENT_ROW_LIMIT.toLocaleString()}. Import with a smaller sample or filter first.`;
}

/** fetch() rejected — the request never got an HTTP response. That
 *  means connection refused / DNS / a severed socket, NOT an HTTP
 *  error (those resolve normally and go to describeHttpFailure). */
export function describeNetworkFailure(requestBytes: number): SwarmFailure {
  const mb = requestBytes / (1024 * 1024);
  const sizeNote =
    requestBytes > BODY_SIZE_HINT_BYTES
      ? ` Note: the request body was ~${Math.round(mb)} MB — a default Bun server severs bodies over ~128 MB, which surfaces as this same network error; reduce rows first.`
      : "";
  return {
    message: `swarm server unreachable at ${swarmApiLabel()} — is it running?`,
    hint: `${swarmStartHint()}${sizeNote}`,
  };
}

/** The server answered with a non-2xx status: it IS running, so no
 *  start instructions — show what it actually said instead. */
export function describeHttpFailure(
  endpoint: string,
  status: number,
  statusText: string,
  body: string,
): SwarmFailure {
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    message: `swarm ${endpoint} responded ${status}${statusText ? ` ${statusText}` : ""}${
      snippet ? ` — ${snippet}` : ""
    }`,
    hint: null,
  };
}

/** Scelo's Row type accepts number | string | null only. The swarms
 *  server emits booleans (e.g. sim_hospitalised) and may emit nested
 *  shapes in detail fields. Coerce each cell into a CellValue. */
function coerceCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return String(v);
}

function coerceRows(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) out[k] = coerceCell(v);
    return out;
  });
}

const TEMPLATES: Array<{ label: string; scenario: string; drugs: string[] }> = [
  {
    label: "Novel respiratory virus + paxlovid",
    scenario:
      "A novel SARS-CoV-2-like respiratory virus is spreading in SA: R₀≈2.4, IFR concentrated in 65+ and immunocompromised. Paxlovid (nirmatrelvir/ritonavir) is available within 5 days of symptom onset, R5,800 / course at private pharmacies, free at public clinics for high-risk patients. Hospitals run at 85% baseline occupancy. Describe what you would do.",
    drugs: ["nirmatrelvir", "ritonavir"],
  },
  {
    label: "HIV: dolutegravir switch",
    scenario:
      "The SA National Department of Health is switching first-line ART from EFV-based to dolutegravir-based (DTG/3TC/TDF) for all adults on treatment. Switch happens at next clinic visit. Some concern about weight gain and rare hypersensitivity. What changes for you?",
    drugs: ["dolutegravir", "lamivudine", "tenofovir"],
  },
  {
    label: "New oral GLP-1 launch",
    scenario:
      "A new oral GLP-1 agonist is launched in SA at R3,200/month for diabetes + adjunct obesity management. Medical schemes cover for HbA1c ≥7.5 only. Off-label use for weight loss common in private clinics. Some GI side effects in first 4 weeks; rare pancreatitis. Would you start treatment?",
    drugs: ["semaglutide"],
  },
  {
    label: "Social: pension contribution hike",
    scenario:
      "Treasury announces a mandatory increase in retirement-fund contributions from 7.5% to 12% of pensionable salary, effective in 12 months. How would you adjust spending, savings, and any private retirement provision?",
    drugs: [],
  },
];

type Mode = "generate" | "augment";

/** One swarm SSE event as the progress overlay's state, or null when the
 *  event isn't progress (result / error). Only the agent pass carries an
 *  honest done / total, so only it fills the rail and counts; the reference
 *  lookup and the scaling pass scan. Exported for tests. */
export function simulationProgress(ev: Record<string, unknown>, mode: Mode): UploadState | null {
  // Augment simulates a reference sample and extrapolates it to every row;
  // generate's agents ARE the new dataset's rows.
  const name = mode === "augment" ? "reference agents" : "agents";
  const agentPass = (done: number, total: number): UploadState =>
    total > 0 && Number.isFinite(done)
      ? { verb: "simulating", name, pct: (100 * done) / total, count: { done, total } }
      : { verb: "simulating", name };
  if (ev.type === "phase") {
    if (ev.phase === "refs") return { verb: "resolving", name: "compound references" };
    if (ev.phase === "sim") return agentPass(0, Number(ev.total));
    return { verb: "scaling", name: "results" };
  }
  if (ev.type === "sim_progress") return agentPass(Number(ev.done), Number(ev.total));
  return null;
}

// The columns augment matches rows to reference agents on — the names the
// swarm reads (apps/swarm augmentLookup.ts rowTraits), compared ignoring case.
const PERSON_COLUMNS = ["age", "age_at_entry", "ageatentry", "sex", "gender", "comorbidities"];

/** The columns of a dataset that augment can match people on. Empty means
 *  the swarm can't tell the rows apart, so every row would get the same
 *  cohort-wide medians. Exported for tests. */
export function personColumns(columns: string[]): string[] {
  return columns.filter((c) => PERSON_COLUMNS.includes(c.toLowerCase()));
}

type RunAction = "pause" | "resume" | "stop";

/** Ask the swarm to hold, release or end a streaming run. Resolves to the
 *  run's state as the server now reports it, or null when it couldn't be
 *  reached or no longer knows the run. Exported for tests. */
export async function sendRunAction(runId: string, action: RunAction): Promise<string | null> {
  try {
    const r = await fetch(
      `${swarmApiUrl()}/api/simulate/runs/${encodeURIComponent(runId)}/${action}`,
      { method: "POST" },
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { state?: unknown };
    return typeof body.state === "string" ? body.state : null;
  } catch {
    return null;
  }
}

/** The swarm UI's transport marks (apps/swarm Icons.tsx: same paths, stroke
 *  and 14-unit footprint) rather than ▶ ❚❚ ■ text glyphs, which render at
 *  whatever weight the OS fallback font happens to have. */
function TransportMark({ kind }: { kind: "play" | "pause" | "stop" }) {
  return (
    <svg
      aria-hidden="true"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === "play" && (
        <path d="M7.5 5.2v13.6a.6.6 0 0 0 .92.5l10.7-6.8a.6.6 0 0 0 0-1L8.42 4.7a.6.6 0 0 0-.92.5Z" />
      )}
      {kind === "pause" && (
        <>
          <rect x="6" y="5" width="4.5" height="14" rx="1" />
          <rect x="13.5" y="5" width="4.5" height="14" rx="1" />
        </>
      )}
      {kind === "stop" && <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />}
    </svg>
  );
}

export function SimulateScenarioModal({
  open,
  onClose,
  onDataset,
  existingDataset,
}: {
  open: boolean;
  onClose: () => void;
  /** `focus` names the column to land on — an augment's first sim_* column,
   *  which may replace values in place rather than add a new column. */
  onDataset: (d: Dataset, focus?: string) => void;
  existingDataset: Dataset | null;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>(existingDataset ? "augment" : "generate");
  const [scenario, setScenario] = useState(TEMPLATES[0].scenario);
  const [drugsText, setDrugsText] = useState(TEMPLATES[0].drugs.join(", "));
  const [sampleSize, setSampleSize] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SwarmFailure | null>(null);
  // Generate mode replaces the loaded dataset in one click — arm an
  // explicit confirm step first (see the run button's onClick).
  const [confirmReplace, setConfirmReplace] = useState(false);
  // Overlay state while a run streams (see simulationProgress).
  const [progress, setProgress] = useState<UploadState | null>(null);
  // The run's id from the stream's first event — what pause / resume / stop
  // address. Null until it arrives, and always null on a swarm too old to
  // name its runs (stop still works there: dropping the stream ends it).
  const [runId, setRunId] = useState<string | null>(null);
  const [hold, setHold] = useState<"running" | "pausing" | "paused" | "resuming">("running");
  // Neutral outcome line (a stopped run) — not an error, so not red.
  const [notice, setNotice] = useState<string | null>(null);
  // Aborting the in-flight run's stream is how stop takes effect locally.
  const abortRef = useRef<AbortController | null>(null);

  // The modal stays mounted while closed (`open` only gates the
  // render), so state persists across opens — and every hook must sit
  // above the early return below, or opening it adds a hook and React
  // throws. Re-derive the default mode each time it opens: augment is
  // the non-destructive default whenever a dataset is loaded.
  useEffect(() => {
    if (!open) return;
    setMode(existingDataset ? "augment" : "generate");
    setConfirmReplace(false);
    setError(null);
    setNotice(null);
  }, [open, existingDataset]);

  // Leaving Scelo unmounts the workstation, and a run's result could no
  // longer land anywhere — drop the stream so the swarm stops working on it.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!open) return null;

  // Pre-flight augment guard: sourceTotalRows is what the full-
  // fidelity import had before sampling (optional — read defensively).
  const augmentGuard = existingDataset
    ? augmentRowGuard(existingDataset.rows.length, existingDataset.sourceTotalRows)
    : null;
  const needsReplaceConfirm =
    mode === "generate" && !!existingDataset && existingDataset.rows.length > 0 && !confirmReplace;
  const cohortOnly = !!existingDataset && personColumns(existingDataset.columns).length === 0;

  const pickTemplate = (i: number) => {
    const t = TEMPLATES[i];
    setScenario(t.scenario);
    setDrugsText(t.drugs.join(", "));
  };

  // What a stopped run leaves behind, said plainly: nothing changed.
  const stoppedNotice =
    mode === "augment" && existingDataset
      ? `simulation stopped — ${existingDataset.name} is unchanged`
      : "simulation stopped — no dataset was generated";

  // POST + classify failures. Returns the parsed JSON body, or null
  // after setting `error` (network vs HTTP vs bad-body each get their
  // own message — only network failures blame a missing server).
  /**
   * POST and consume the swarm's SSE variant.
   *
   * A plain JSON POST is silent for the whole reference pass — one LLM call
   * per reference agent — and a browser aborts a fetch that has received no
   * response headers for ~300s. Measured on this stack: a 120-agent augment
   * takes 317s, already past that line, and the new 400-agent default is
   * ~17 minutes. Streaming sends headers immediately and heartbeats the
   * socket, so the run survives; it also gives us real progress to show
   * instead of an unexplained multi-minute freeze.
   *
   * The final `result` event carries exactly the payload the JSON branch
   * would have returned, so callers are unchanged downstream.
   */
  const postStreaming = async (
    endpoint: string,
    payload: unknown,
    onProgress: (state: UploadState) => void,
    signal: AbortSignal,
  ): Promise<unknown | null> => {
    const body = JSON.stringify({ ...(payload as object), stream: true });
    let r: Response;
    try {
      r = await fetch(`${swarmApiUrl()}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      });
    } catch {
      // Stopped before the response came back: the user's doing, not an outage.
      if (!signal.aborted) setError(describeNetworkFailure(body.length));
      return null;
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      setError(describeHttpFailure(endpoint, r.status, r.statusText, text));
      return null;
    }
    if (!r.body) {
      setError({ message: `swarm ${endpoint} returned no body`, hint: null });
      return null;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let result: unknown | null = null;
    let failure: string | null = null;
    let stopped = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; ": hb" heartbeats carry no
        // data line and fall through harmlessly.
        let idx = buf.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
              const step = simulationProgress(ev, mode);
              if (step) {
                onProgress(step);
              } else if (ev.type === "run") {
                if (typeof ev.runId === "string") setRunId(ev.runId);
              } else if (ev.type === "result") {
                result = ev;
              } else if (ev.type === "stopped") {
                stopped = true;
              } else if (ev.type === "error") {
                failure = String(ev.message ?? "unknown swarm error");
              }
            } catch {
              // malformed frame — skip it rather than abandoning the run
            }
          }
          idx = buf.indexOf("\n\n");
        }
      }
    } catch (e) {
      // Dropped on purpose by stop — there is nothing left to read.
      if (signal.aborted) return null;
      throw e;
    }
    if (stopped) {
      setNotice(stoppedNotice);
      return null;
    }
    if (failure) {
      setError({ message: failure, hint: null });
      return null;
    }
    if (!result) {
      setError({
        message: `swarm ${endpoint} closed without returning a result`,
        hint: "the run may have been interrupted by a server restart — try again",
      });
      return null;
    }
    return result;
  };

  const run = async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    setNotice(null);
    setRunId(null);
    setHold("running");
    setProgress({ verb: "connecting", name: `swarm @ ${swarmApiLabel()}` });
    const drugs = drugsText
      .split(/[,\n]/)
      .map((d) => d.trim())
      .filter(Boolean);
    try {
      if (mode === "generate") {
        const json = (await postStreaming(
          "/api/simulate",
          { scenario, drugs, sampleSize },
          setProgress,
          ac.signal,
        )) as {
          rows: Array<Record<string, unknown>>;
          columns: string[];
        } | null;
        // A stop that crossed paths with the result still discards it.
        if (!json || ac.signal.aborted) return;
        const ds: Dataset = {
          name: `swarm_simulation_${Date.now()}`,
          columns: json.columns,
          rows: coerceRows(json.rows),
        };
        onDataset(ds);
        onClose();
      } else {
        if (!existingDataset) {
          setError({ message: "no dataset loaded to augment", hint: null });
          return;
        }
        // Belt-and-braces: the run button is disabled when the guard
        // trips, but never let an oversize body reach JSON.stringify.
        const guard = augmentRowGuard(existingDataset.rows.length, existingDataset.sourceTotalRows);
        if (guard) {
          setError({ message: guard, hint: null });
          return;
        }
        const json = (await postStreaming(
          "/api/simulate/augment",
          {
            scenario,
            drugs,
            sampleSize,
            rows: existingDataset.rows,
            expectedColumns: existingDataset.columns,
          },
          setProgress,
          ac.signal,
        )) as {
          rows: Array<Record<string, unknown>>;
          augmentedColumns: string[];
          failedCount?: number;
          requestedSampleSize?: number;
        } | null;
        if (!json || ac.signal.aborted) return;
        // No sim_* columns means no agent answered. Applying the rows unchanged
        // under a "+ sim" name would read as a success that added nothing.
        if (json.augmentedColumns.length === 0) {
          const failed =
            json.failedCount && json.requestedSampleSize
              ? `${json.failedCount} of ${json.requestedSampleSize}`
              : "all the";
          setError({
            message: `no simulated values came back — ${failed} reference agents failed, so there was nothing to add`,
            hint: "every agent failing usually means the swarm's model provider is down",
          });
          return;
        }
        const newCols = [...existingDataset.columns];
        for (const c of json.augmentedColumns) {
          if (!newCols.includes(c)) newCols.push(c);
        }
        onDataset(
          {
            // A re-run replaces the earlier sim_* values; it doesn't stack.
            name: existingDataset.name.endsWith(" + sim")
              ? existingDataset.name
              : `${existingDataset.name} + sim`,
            columns: newCols,
            rows: coerceRows(json.rows),
          },
          json.augmentedColumns[0],
        );
        onClose();
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        setError({ message: e instanceof Error ? e.message : String(e), hint: null });
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setProgress(null);
      setRunId(null);
      setHold("running");
      setBusy(false);
    }
  };

  // Stop: tell the swarm first so it cancels the agent calls in flight at
  // once, then drop the stream — which also stops the run on its own, a beat
  // later, and is all an older swarm understands.
  const stopRun = () => {
    const ac = abortRef.current;
    if (!ac) return;
    if (runId) void sendRunAction(runId, "stop");
    ac.abort();
    setNotice(stoppedNotice);
  };

  const holdRun = async (action: "pause" | "resume") => {
    const ac = abortRef.current;
    if (!ac || !runId) return;
    setHold(action === "pause" ? "pausing" : "resuming");
    const state = await sendRunAction(runId, action);
    if (abortRef.current !== ac) return; // the run ended meanwhile
    // The server's word wins; if it couldn't be reached, nothing changed.
    setHold(
      state === "paused" || state === "running" ? state : action === "pause" ? "running" : "paused",
    );
  };

  const held = hold === "paused" || hold === "resuming";

  return (
    <div
      className="ia-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="ia-dialog-in relative max-h-[88vh] w-[min(680px,92vw)] overflow-auto rounded-md border border-border bg-bg-1 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-medium text-fg">simulate from scenario · swarm @ {swarmApiLabel()}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg"
            aria-label="close"
          >
            ×
          </button>
        </div>
        {/* Everything under the header shares one positioned box, so a
            run's overlay can cover the disabled form while the × stays
            live — closing mid-run lets the simulation finish behind it. */}
        <div className="relative">
          <p className="mb-4 text-[12px] text-fg-mute">
            Population simulator at the swarms server. SA-anchored synthetic population (StatsSA +
            SADHS priors). Each agent runs through a strict JSON outcome envelope. Real drug data
            pulled from PubChem / OpenFDA / ChEMBL and cited verbatim.
          </p>

          {existingDataset && (
            <div className="mb-3 flex gap-px overflow-hidden rounded border border-border">
              {(["generate", "augment"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setConfirmReplace(false);
                    setError(null);
                  }}
                  className={`flex-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${
                    mode === m ? "bg-primary text-bg" : "bg-bg-2 text-fg-mute hover:text-fg"
                  }`}
                >
                  {m === "generate" ? "generate new dataset" : `augment ${existingDataset.name}`}
                </button>
              ))}
            </div>
          )}

          <div className="mb-3 flex flex-wrap gap-1.5">
            {TEMPLATES.map((t, i) => (
              <button
                key={t.label}
                type="button"
                onClick={() => pickTemplate(i)}
                disabled={busy}
                title={t.scenario}
                className="rounded-full border border-border bg-bg px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-primary hover:text-primary disabled:opacity-50"
              >
                {t.label}
              </button>
            ))}
          </div>

          <label className="mb-3 flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              scenario
            </span>
            <textarea
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              disabled={busy}
              rows={6}
              className="w-full rounded border border-border bg-bg p-2 font-mono text-[12px] text-fg"
            />
          </label>

          <label className="mb-3 flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              drugs / compounds (PubChem + OpenFDA + ChEMBL)
            </span>
            <input
              type="text"
              value={drugsText}
              onChange={(e) => setDrugsText(e.target.value)}
              disabled={busy}
              className="w-full rounded border border-border bg-bg p-2 font-mono text-[12px] text-fg"
              placeholder="comma-separated, e.g. paxlovid, dolutegravir"
            />
          </label>

          <div className="mb-4 flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
              sample size ·{" "}
              <EditableNumber
                value={sampleSize}
                min={20}
                max={mode === "augment" ? 400 : 1000}
                step={20}
                onChange={setSampleSize}
                disabled={busy}
                ariaLabel="sample size value"
              />{" "}
              <span className="text-fg-dim normal-case tracking-normal">
                (
                {mode === "augment"
                  ? "agents simulated for the lookup, applied to all rows"
                  : "agents in the new dataset"}
                )
              </span>
            </span>
            <input
              type="range"
              min={20}
              max={mode === "augment" ? 400 : 1000}
              step={20}
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
              disabled={busy}
              aria-label="sample size"
            />
          </div>

          {mode === "augment" && cohortOnly && existingDataset && (
            <div className="mb-3 rounded border border-border bg-bg-2 p-2 font-mono text-[11px] text-fg-mute">
              {existingDataset.name} has no age, sex or comorbidity column, so the swarm can't tell
              its rows apart — every row will get the same cohort-wide medians. For per-person
              outcomes, generate a new dataset instead.
            </div>
          )}

          {mode === "augment" && augmentGuard && (
            <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2 font-mono text-[11px] text-warn">
              {augmentGuard}
            </div>
          )}

          {confirmReplace && mode === "generate" && existingDataset && (
            <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2 font-mono text-[11px] text-warn">
              Generating will replace <span className="font-medium">{existingDataset.name}</span> (
              {existingDataset.rows.length.toLocaleString()} rows) as the loaded dataset. Click{" "}
              <span className="font-medium">replace dataset</span> to continue, or switch to augment
              to keep it.
            </div>
          )}

          {notice && (
            <div className="mb-3 rounded border border-border bg-bg-2 p-2 font-mono text-[11px] text-fg-mute">
              {notice}
            </div>
          )}

          {error && (
            <div className="mb-3 rounded border border-error/40 bg-error/10 p-2 font-mono text-[11px] text-error">
              {error.message}
              {error.hint && <div className="mt-1 text-[10px] text-fg-dim">{error.hint}</div>}
              {error.hint && (
                <button
                  type="button"
                  onClick={() => navigate("/swarm")}
                  className="mt-2 w-full rounded border border-border bg-bg-2 px-3 py-1.5 font-mono text-[11px] text-fg-mute hover:text-fg"
                  title="Open the full swarm screen — it live-probes the server and shows the embedded swarm UI once it's up"
                >
                  open the swarm screen <Arrow />
                </button>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-border bg-bg-2 px-3 py-1.5 font-mono text-[11px] text-fg-mute hover:text-fg disabled:opacity-50"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => {
                // First click in generate mode over a loaded dataset only
                // arms the confirm box; the second click actually runs.
                if (needsReplaceConfirm) {
                  setConfirmReplace(true);
                  return;
                }
                void run();
              }}
              disabled={
                busy || scenario.trim().length < 4 || (mode === "augment" && augmentGuard !== null)
              }
              className="rounded border border-primary bg-primary px-4 py-1.5 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
            >
              {busy
                ? "simulating…"
                : mode === "generate"
                  ? confirmReplace && existingDataset
                    ? "▷ replace dataset"
                    : "▷ generate dataset"
                  : "▷ augment dataset"}
            </button>
          </div>

          {/* The overlay every long Scelo process uses (building, combining,
              computing, identifying). A 400-agent run is minutes long; the
              rail fills only through the agent pass, the one phase with a
              real done / total. Paused, it freezes where it stands. */}
          {busy && progress && (
            <UploadIndicator
              layout="overlay"
              accent="primary"
              paused={held}
              state={held ? { ...progress, verb: "paused" } : progress}
              actions={
                <>
                  {held ? (
                    <button
                      type="button"
                      onClick={() => void holdRun("resume")}
                      disabled={hold === "resuming"}
                      className="ia-tool-btn border-border"
                    >
                      <TransportMark kind="play" />
                      {hold === "resuming" ? "resuming…" : "resume"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void holdRun("pause")}
                      disabled={!runId || hold === "pausing"}
                      title={
                        runId
                          ? "hold the run — resume picks up where it left off"
                          : progress.verb === "connecting"
                            ? "starting the run…"
                            : "this swarm server can't pause runs"
                      }
                      className="ia-tool-btn border-border"
                    >
                      <TransportMark kind="pause" />
                      {hold === "pausing" ? "pausing…" : "pause"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={stopRun}
                    title="stop the run — nothing is changed"
                    className="ia-tool-btn ia-tool-btn-danger border-border"
                  >
                    <TransportMark kind="stop" />
                    stop
                  </button>
                </>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
