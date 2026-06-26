// SimulateScenarioModal — Scelo Soft Data integration point for the
// swarms population simulator at :3010.
//
// Two modes:
//   • generate — create a brand-new synthetic dataset from a scenario
//                + reference data, load it as the Soft Data dataset.
//   • augment  — given the currently-loaded dataset, derive sim_*
//                columns per row via a sample-then-extrapolate pattern
//                so 10k-row datasets don't trigger 10k LLM calls.

import { useState } from "react";
import type { CellValue, Dataset, Row } from "./SoftDataWorkstation";

const SWARM_BASE = "http://localhost:3010";

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

export function SimulateScenarioModal({
  open,
  onClose,
  onDataset,
  existingDataset,
}: {
  open: boolean;
  onClose: () => void;
  onDataset: (d: Dataset) => void;
  existingDataset: Dataset | null;
}) {
  const [mode, setMode] = useState<Mode>(existingDataset ? "augment" : "generate");
  const [scenario, setScenario] = useState(TEMPLATES[0].scenario);
  const [drugsText, setDrugsText] = useState(TEMPLATES[0].drugs.join(", "));
  const [sampleSize, setSampleSize] = useState(120);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const pickTemplate = (i: number) => {
    const t = TEMPLATES[i];
    setScenario(t.scenario);
    setDrugsText(t.drugs.join(", "));
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    const drugs = drugsText.split(/[,\n]/).map((d) => d.trim()).filter(Boolean);
    try {
      if (mode === "generate") {
        const r = await fetch(`${SWARM_BASE}/api/simulate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario, drugs, sampleSize }),
        });
        if (!r.ok) throw new Error(`swarm /api/simulate ${r.status}`);
        const json = (await r.json()) as {
          rows: Array<Record<string, unknown>>;
          columns: string[];
        };
        const ds: Dataset = {
          name: `swarm_simulation_${Date.now()}`,
          columns: json.columns,
          rows: coerceRows(json.rows),
        };
        onDataset(ds);
        onClose();
      } else {
        if (!existingDataset) throw new Error("no dataset loaded to augment");
        const r = await fetch(`${SWARM_BASE}/api/simulate/augment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scenario,
            drugs,
            sampleSize,
            rows: existingDataset.rows,
            expectedColumns: existingDataset.columns,
          }),
        });
        if (!r.ok) throw new Error(`swarm /api/simulate/augment ${r.status}`);
        const json = (await r.json()) as {
          rows: Array<Record<string, unknown>>;
          augmentedColumns: string[];
        };
        const newCols = [...existingDataset.columns];
        for (const c of json.augmentedColumns) {
          if (!newCols.includes(c)) newCols.push(c);
        }
        onDataset({
          name: `${existingDataset.name} + sim`,
          columns: newCols,
          rows: coerceRows(json.rows),
        });
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="relative max-h-[88vh] w-[min(680px,92vw)] overflow-auto rounded-md border border-border bg-bg-1 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-medium text-fg">simulate from scenario · swarm @ :3010</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg"
            aria-label="close"
          >
            ×
          </button>
        </div>
        <p className="mb-4 text-[12px] text-fg-mute">
          Population simulator at the swarms server. SA-anchored synthetic population (StatsSA + SADHS priors). Each agent runs through a strict JSON outcome envelope. Real drug data pulled from PubChem / OpenFDA / ChEMBL and cited verbatim.
        </p>

        {existingDataset && (
          <div className="mb-3 flex gap-px overflow-hidden rounded border border-border">
            {(["generate", "augment"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
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

        <label className="mb-4 flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            sample size · {sampleSize}{" "}
            <span className="text-fg-dim normal-case tracking-normal">
              ({mode === "augment" ? "agents simulated for the lookup, applied to all rows" : "agents in the new dataset"})
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
          />
        </label>

        {error && (
          <div className="mb-3 rounded border border-error/40 bg-error/10 p-2 font-mono text-[11px] text-error">
            {error}
            <div className="mt-1 text-[10px] text-fg-dim">
              Is the swarms server running? Start it with `PORT=3010 bun run dev` in{" "}
              <code>swarms/</code> — it must listen on port 3010 (its default is 3000).
            </div>
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
            onClick={run}
            disabled={busy || scenario.trim().length < 4}
            className="rounded border border-primary bg-primary px-4 py-1.5 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
          >
            {busy
              ? "simulating…"
              : mode === "generate"
                ? "▷ generate dataset"
                : "▷ augment dataset"}
          </button>
        </div>
      </div>
    </div>
  );
}
