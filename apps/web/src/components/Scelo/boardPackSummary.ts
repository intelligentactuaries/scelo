// The board pack's executive summary, in plain English.
//
// Written for the people who sign: the signing actuary, the head of the
// actuarial function, a board. It leads with the figure that matters, says
// how far the methods agree, gives the uncertainty as a range in words, and
// ends with what the numbers rest on and what to check before relying on
// them. It never mentions software ("bundled CPython", "in-browser", engine
// names) or statistical shorthand (CV, p5–p95, R², AUC) — it says what they
// mean. Actuarial vocabulary (IBNR, standard error, present value) stays: the
// readers are actuaries.
//
// Deterministic and built only from the run results, so every figure in it
// is one the pack computed. It replaced a summary that strung the runs'
// technical one-liners together ("Bundled-CPython numpy reserving engine
// (mack) across 7 origins produced IBNR = 1,500,955 (CV 22.60%) …").

import type { Dataset } from "@scelo/core";
import { MODEL_BY_ID } from "./modelCatalog";
import type { RunResult } from "./modelRunner";

// ── plain numbers ──────────────────────────────────────────────────────────

/** 1,500,955 → "1.50 million"; 486,771 → "487,000"; 7.9436 → "7.94". */
export function plainAmount(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "minus " : "";
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)} billion`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)} million`;
  if (a >= 1e4) return `${sign}${Number(a.toPrecision(3)).toLocaleString("en-US")}`;
  if (a >= 1) return `${sign}${Number(a.toFixed(2)).toLocaleString("en-US")}`;
  return `${sign}${Number(a.toPrecision(3))}`;
}

/** 0.2260 → "23%"; 0.047 → "4.7%"; 0.0199 as a probability → "1.99%". */
export function plainPct(x: number, probability = false): string {
  if (!Number.isFinite(x)) return "—";
  const p = 100 * x;
  if (probability) return `${p.toFixed(Math.abs(p) < 10 ? 2 : 1)}%`;
  return `${p.toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`;
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
function count(n: number): string {
  return n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

// ── names as they read in a sentence ──────────────────────────────────────

const PROSE_NAME: Record<string, string> = {
  "chain-ladder": "chain ladder",
  mack: "Mack",
  "bornhuetter-ferguson": "Bornhuetter–Ferguson",
  "bootstrap-ibnr": "the bootstrap",
  "glm-frequency": "the claim-frequency model",
  "glm-severity": "the claim-size model",
  gbm: "the gradient-boosting model",
  shap: "the driver analysis",
  "lee-carter": "Lee–Carter",
  cbd: "Cairns–Blake–Dowd",
  lifecontingencies: "the annuity valuation",
  descriptive: "the data profile",
};

function proseName(id: string): string {
  return PROSE_NAME[id] ?? MODEL_BY_ID.get(id)?.name ?? id;
}

/** Catalog name, for lists ("Lee–Carter and Life Contingencies"). */
function titleName(id: string): string {
  return MODEL_BY_ID.get(id)?.name ?? id;
}

// ── helpers over run payloads ─────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Accident years behind a reserving run, when it carries them. */
function originsOf(r: RunResult): number[] {
  const byOrigin = r.detail?.byOrigin;
  if (Array.isArray(byOrigin)) {
    return byOrigin
      .map((b) => num((b as { origin?: unknown }).origin))
      .filter((o): o is number => o !== null);
  }
  if (r.series?.x.every((x) => /^\d{4}$/.test(x))) return r.series.x.map(Number);
  return [];
}

/** Does the run say its figure is a simplified stand-in rather than a model? */
function isApproximation(r: RunResult): boolean {
  const text = [r.headline.label, ...r.secondary.map((s) => `${s.label} ${s.value}`)].join(" ");
  return /approximation|\(mock\)|synthetic loss model|illustrative/i.test(text);
}

// ── family paragraphs ─────────────────────────────────────────────────────

function reservingParagraph(runs: RunResult[]): { text: string; caveats: string[] } {
  const caveats: string[] = [];
  const est = runs.map((r) => ({ r, id: r.modelId, v: r.headline.value }));
  const sorted = [...est].sort((a, b) => a.v - b.v);
  const values = sorted.map((e) => e.v);
  const mid =
    values.length % 2
      ? values[(values.length - 1) / 2]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  const sentences: string[] = [];

  if (est.length === 1) {
    sentences.push(
      `${capitalise(proseName(est[0].id))} estimates outstanding claims (IBNR) of ${plainAmount(est[0].v)}.`,
    );
  } else {
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const spread = mid !== 0 ? (hi.v - lo.v) / Math.abs(mid) : 0;
    // Methods that land on the same figure are named together.
    const groups = new Map<string, string[]>();
    for (const e of est) {
      const k = plainAmount(e.v);
      groups.set(k, [...(groups.get(k) ?? []), proseName(e.id)]);
    }
    const detail = [...groups]
      .map(
        ([amount, names]) => `${listJoin(names)} ${names.length > 1 ? "give" : "gives"} ${amount}`,
      )
      .join("; ");
    sentences.push(
      `The ${count(est.length)} reserving methods put outstanding claims (IBNR) at about ${plainAmount(mid)}: ${detail}.`,
    );
    if (spread <= 0.1) {
      sentences.push(
        `They agree closely (within ${plainPct(spread)}), so the choice of method does not materially change the answer.`,
      );
    } else if (spread <= 0.25) {
      sentences.push(
        `They differ by up to ${plainPct(spread)}; the choice of method matters and should be justified in the sign-off.`,
      );
    } else {
      sentences.push(
        `They differ by ${plainPct(spread)} between the lowest (${proseName(lo.id)}) and the highest (${proseName(hi.id)}); the reason should be understood before a figure is signed off.`,
      );
    }
  }

  // Uncertainty, in words.
  const mack = runs.find((r) => r.modelId === "mack");
  const se = num(mack?.detail?.se);
  const mackIbnr = mack ? mack.headline.value : null;
  const boot = runs.find((r) => r.modelId === "bootstrap-ibnr");
  const p5 = num(boot?.detail?.p5);
  const p95 = num(boot?.detail?.p95);
  const unc: string[] = [];
  if (se !== null && mackIbnr) {
    unc.push(
      `Mack's standard error is about ${plainPct(se / Math.abs(mackIbnr))} of the reserve, or roughly ${plainAmount(mackIbnr - se)} to ${plainAmount(mackIbnr + se)} for one standard error either side`,
    );
  }
  if (p5 !== null && p95 !== null) {
    unc.push(
      `the bootstrap puts 90% of simulated outcomes between ${plainAmount(p5)} and ${plainAmount(p95)}`,
    );
    if (boot && isApproximation(boot)) {
      caveats.push(
        "The bootstrap range is a simplified approximation in this version, not a full resampling simulation.",
      );
    }
  }
  if (unc.length > 0) sentences.push(`${capitalise(unc.join("; "))}.`);

  // What the Bornhuetter–Ferguson figure leans on.
  const bf = runs.find((r) => r.modelId === "bornhuetter-ferguson");
  if (bf) {
    const wiredCl = bf.wiredFrom?.some((w) => w.id === "chain-ladder");
    caveats.push(
      wiredCl
        ? "The Bornhuetter–Ferguson prior was taken from the chain-ladder ultimates, so it is not an independent view."
        : "The Bornhuetter–Ferguson prior is the book-average ultimate rather than a plan or pricing loss ratio; a signed figure would normally use the latter.",
    );
  }

  // Thin history.
  const origins = new Set(runs.flatMap(originsOf));
  if (origins.size > 0 && origins.size <= 7) {
    caveats.push(
      `With ${count(origins.size)} accident years of history, the later development factors rest on very few observations.`,
    );
  }
  return { text: sentences.join(" "), caveats };
}

function pricingParagraph(runs: RunResult[]): string {
  const sentences: string[] = [];
  const freq = runs.find((r) => r.modelId === "glm-frequency");
  const sev = runs.find((r) => r.modelId === "glm-severity");
  if (freq) {
    const target = String(freq.detail?.target ?? "claims");
    sentences.push(
      freq.source === "python-bridge"
        ? `The claim-frequency model puts the baseline claim rate (the reference group) at ${plainAmount(freq.headline.value)} per policy.`
        : `Claims (${target}) occur at an average rate of ${plainAmount(freq.headline.value)} per policy.`,
    );
  }
  if (sev) {
    const pp = num(sev.detail?.purePremium);
    sentences.push(
      sev.source === "python-bridge"
        ? `The claim-size model puts the baseline average claim (the reference group) at ${plainAmount(sev.headline.value)}.`
        : pp !== null
          ? `The average claim costs ${plainAmount(sev.headline.value)}, which with the claim rate gives an expected claims cost (pure premium) of about ${plainAmount(pp)} per policy.`
          : `The average claim costs ${plainAmount(sev.headline.value)}.`,
    );
  }
  const gbm = runs.find((r) => r.modelId === "gbm");
  if (gbm) {
    const m = gbm.detail?.metrics as { primaryName?: string; primary?: number } | undefined;
    const target = String(gbm.detail?.target ?? "the target");
    const v = num(m?.primary);
    if (m?.primaryName === "AUC" && v !== null) {
      const quality =
        v >= 0.8
          ? "well"
          : v >= 0.7
            ? "reasonably well"
            : v >= 0.6
              ? "only weakly"
              : "barely better than chance";
      sentences.push(
        `The gradient-boosting model separates higher- from lower-risk cases ${quality}: on cases it had not seen, it ranks a ${target} case above a non-case ${plainPct(v)} of the time.`,
      );
    } else if (v !== null) {
      const what = m?.primaryName === "deviance explained" ? `claim counts (${target})` : target;
      sentences.push(
        v < 0.05
          ? `The gradient-boosting model has little or no predictive power for ${what} on data it had not seen.`
          : `The gradient-boosting model explains ${plainPct(v)} of the variation in ${what} on data it had not seen.`,
      );
    }
  }
  const shap = runs.find((r) => r.modelId === "shap");
  const s = shap?.detail?.shap as
    | { features?: string[]; share?: number[]; direction?: Array<string | null> }
    | undefined;
  if (s?.features?.length && s.share?.length) {
    const top = s.features.slice(0, 2).map((f, i) => `${f} (${plainPct(s.share?.[i] ?? 0)})`);
    const dir = s.direction?.[0];
    const lead =
      dir === "up"
        ? ` — higher ${s.features[0]} pushes predictions up`
        : dir === "down"
          ? ` — higher ${s.features[0]} pushes predictions down`
          : "";
    sentences.push(`Its predictions are driven mainly by ${listJoin(top)}${lead}.`);
  }
  return sentences.join(" ");
}

function mortalityParagraph(runs: RunResult[]): string {
  const sentences: string[] = [];
  for (const id of ["lee-carter", "cbd"]) {
    const r = runs.find((x) => x.modelId === id);
    if (!r) continue;
    const q = Array.isArray(r.detail?.qx) ? (r.detail?.qx as number[]) : [];
    const years = Array.isArray(r.detail?.projYears) ? (r.detail?.projYears as number[]) : [];
    const age = num(r.detail?.headlineAge) ?? 65;
    const imp = num(r.detail?.annualImprovement);
    if (q.length === 0 || years.length === 0) continue;
    sentences.push(
      `${capitalise(proseName(id))} projects that a ${age}-year-old's chance of dying within the year falls to ${plainPct(q[q.length - 1], true)} by ${years[years.length - 1]}${imp !== null ? `, an improvement of about ${plainPct(imp)} a year` : ""}.`,
    );
  }
  const life = runs.find((r) => r.modelId === "lifecontingencies");
  if (life) {
    const x = num(life.detail?.x) ?? 65;
    const n = num(life.detail?.term) ?? 10;
    const i = num(life.detail?.interest);
    const src =
      life.detail?.mortalitySource === "lee-carter"
        ? "the projected Lee–Carter mortality"
        : "the dataset's own life table";
    sentences.push(
      `An annuity of 1 a year for ${n} years to a ${x}-year-old is worth ${plainAmount(life.headline.value)}${i !== null ? ` at ${plainPct(i)} interest` : ""}, using ${src}.`,
    );
  }
  return sentences.join(" ");
}

function workspaceSentence(r: RunResult): string {
  const d = r.detail ?? {};
  const codes = Array.isArray(d.codes) ? d.codes : Array.isArray(d.codeNames) ? d.codeNames : [];
  const fields = Array.isArray(d.heads) ? d.heads.length : null;
  const rebuilt = num(d.reconstructionR2);
  if (codes.length === 0 || rebuilt === null) return genericSentence(r);
  // Code names read "a up, b up, c down" — say it as a sentence.
  const terms = String(codes[0])
    .split(/,\s*/)
    .map((t) => /^(.*)\s+(up|down)$/.exec(t.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  const ups = terms.filter((m) => m[2] === "up").map((m) => m[1]);
  const downs = terms.filter((m) => m[2] === "down").map((m) => m[1]);
  const lead =
    ups.length > 0 && downs.length > 0
      ? `; the strongest moves ${listJoin(ups)} up and ${listJoin(downs)} down together`
      : ups.length + downs.length > 0
        ? `; the strongest moves ${listJoin([...ups, ...downs])} together`
        : "";
  return `The ${fields ?? "numeric"} fields boil down to ${count(codes.length)} underlying factors, which reproduce ${plainPct(rebuilt)} of their variation${lead}.`;
}

/** Everything else: "<Model>: <what it measures> of <value>." */
function genericSentence(r: RunResult): string {
  const label = r.headline.label.replace(/\s*\((in-browser )?approximation\)/i, "").trim();
  return `${titleName(r.modelId)}: ${label} of ${plainAmount(r.headline.value)}.`;
}

function descriptiveSentence(r: RunResult, dataset: Dataset): string {
  const profiles = Array.isArray(r.detail?.profiles)
    ? (r.detail?.profiles as Array<{ missingPct?: number }>)
    : [];
  const gappy = profiles.filter((p) => (p.missingPct ?? 0) > 0.1).length;
  if (profiles.length === 0)
    return `The data has no numeric fields to profile (${dataset.rows.length.toLocaleString("en-US")} records).`;
  return gappy > 0
    ? `Of the data's ${profiles.length} numeric fields, ${gappy} ${gappy === 1 ? "is" : "are"} more than 10% incomplete — worth resolving before relying on any fit.`
    : `The data's ${profiles.length} numeric fields have no material gaps.`;
}

// ── the summary ───────────────────────────────────────────────────────────

const FAMILY_ORDER = [
  "reserving",
  "pricing",
  "mortality",
  "life",
  "pensions",
  "climate",
  "capital",
  "forecast",
  "workspace",
  "general",
];

export function executiveSummary(args: { dataset: Dataset; runs: RunResult[] }): string {
  const { dataset, runs } = args;
  if (runs.length === 0) {
    return `No models are attached to ${dataset.name} yet — choose them in Tools to build the pack.`;
  }
  const done = runs.filter((r) => r.status === "done");
  const notApplicable = runs.filter((r) => r.status === "error" && r.notApplicable);
  const failed = runs.filter((r) => r.status === "error" && !r.notApplicable);
  if (done.length === 0) {
    return notApplicable.length === runs.length
      ? `None of the ${count(runs.length)} attached models can run on ${dataset.name} — its data does not contain what they need. Choose different models in Tools.`
      : `None of the ${count(runs.length)} attached models produced a result on ${dataset.name}; each card says why.`;
  }

  const paragraphs: string[] = [];
  const caveats: string[] = [];

  // What was analysed.
  const meta = dataset as Dataset & { sampled?: boolean; sourceTotalRows?: number };
  const records =
    meta.sampled && (meta.sourceTotalRows ?? 0) > dataset.rows.length
      ? `a sample of ${dataset.rows.length.toLocaleString("en-US")} of ${meta.sourceTotalRows?.toLocaleString("en-US")} records`
      : `${dataset.rows.length.toLocaleString("en-US")} records`;
  const origins = new Set(done.filter((r) => r.family === "reserving").flatMap(originsOf));
  const span =
    origins.size > 0 ? `, accident years ${Math.min(...origins)}–${Math.max(...origins)}` : "";
  const onlyFamily = new Set(done.map((r) => r.family)).size === 1 ? done[0].family : null;
  const kind = onlyFamily && onlyFamily !== "general" ? `${onlyFamily} ` : "";
  paragraphs.push(
    `This pack summarises ${count(done.length)} ${kind}${done.length === 1 ? "analysis" : "analyses"} of ${dataset.name} — ${records}${span}.`,
  );

  // One paragraph per family, most decision-relevant first.
  const byFamily = new Map<string, RunResult[]>();
  for (const r of done) byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  const families = [...byFamily.keys()].sort(
    (a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b),
  );
  for (const family of families) {
    const group = byFamily.get(family) ?? [];
    let text = "";
    if (family === "reserving") {
      const res = reservingParagraph(group);
      text = res.text;
      caveats.push(...res.caveats);
    } else if (family === "pricing") {
      text = pricingParagraph(group);
    } else if (family === "mortality") {
      text = mortalityParagraph(group);
    } else if (family === "workspace") {
      text = group
        .map((r) =>
          r.modelId === "workspace-bottleneck" ? workspaceSentence(r) : genericSentence(r),
        )
        .join(" ");
    } else if (family === "general") {
      text = group
        .map((r) =>
          r.modelId === "descriptive" ? descriptiveSentence(r, dataset) : genericSentence(r),
        )
        .join(" ");
    } else {
      text = group.map(genericSentence).join(" ");
    }
    if (text) paragraphs.push(text);
  }

  // What could not be done.
  const byReason = new Map<string, string[]>();
  for (const r of notApplicable) {
    const gist = (r.error ?? "its inputs are missing").split(/(?<=\.)\s/)[0].replace(/\.$/, "");
    byReason.set(gist, [...(byReason.get(gist) ?? []), titleName(r.modelId)]);
  }
  for (const [gist, names] of byReason) {
    // "Needs a mortality table …" → "they need a mortality table …".
    const clause = /^needs\b/i.test(gist)
      ? `${names.length > 1 ? "they need" : "it needs"}${gist.slice(5)}`
      : `${gist.charAt(0).toLowerCase()}${gist.slice(1)}`;
    caveats.push(`${listJoin(names)} could not be applied to this data (${clause}).`);
  }
  if (failed.length > 0) {
    caveats.push(
      `${listJoin(failed.map((r) => titleName(r.modelId)))} failed to run and ${failed.length === 1 ? "is" : "are"} not reflected above.`,
    );
  }

  // What the figures rest on.
  const approx = done.filter((r) => r.modelId !== "bootstrap-ibnr" && isApproximation(r));
  if (approx.length > 0) {
    caveats.push(
      `The ${listJoin(approx.map((r) => titleName(r.modelId)))} ${approx.length === 1 ? "figure is a simplified approximation" : "figures are simplified approximations"} rather than a full model and should not be relied on for sign-off.`,
    );
  }
  if (/synthetic|demo/i.test(dataset.name)) {
    caveats.push("The data is synthetic, so the figures are illustrative only.");
  }
  if (caveats.length > 0) {
    // "…, note that the bootstrap range …" — lower-case only a plain opening
    // word, never a name ("Lee–Carter …" stays as it is).
    const [first, ...rest] = caveats;
    const opening = /^(The|With|A|An|This|These|Some)\b/.test(first)
      ? first.charAt(0).toLowerCase() + first.slice(1)
      : first;
    paragraphs.push([`Before relying on these figures, note that ${opening}`, ...rest].join(" "));
  }

  // Plain text for memos: no code formatting around column names.
  return paragraphs.join("\n\n").replace(/`([^`]*)`/g, "$1");
}
