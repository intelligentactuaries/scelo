// Translate an `ActivityEvent` log into reproducible code in Python / R /
// C++, or into a copy-pasteable LLM prompt. Each generator walks the same
// chronological log; differences are purely in the emitted syntax. Aim:
// the output captures *what* the user did, in order, with enough
// information that a competent reader can rerun the analysis on their own
// machine. Some steps — notably the actuarial model fits — don't have
// first-class libraries everywhere, so we mark gaps with TODO comments
// rather than pretending we generated something the user can run blind.

import type { Filter } from "./SoftDataWorkstation";
import type { ActivityEvent } from "./activityLog";
import { MODEL_BY_ID } from "./modelCatalog";

export type ExportLang = "python" | "r" | "cpp" | "prompt";

// Header line shown at the top of every generated artifact. Anchors the
// reader: when, what tool produced it, which slice of the pipeline is in
// scope. ISO date keeps it locale-stable. The fidelity note matters: the
// script applies filters/cleaning BEFORE any model step, whereas Scelo's
// in-app quick runs execute against the unfiltered in-memory dataset — so
// numbers produced by the script may legitimately differ from the app's.
function headerLines(args: { lang: ExportLang; stage: string; eventCount: number }): string[] {
  const ts = new Date().toISOString();
  const banner = [
    `Reproduces a Scelo workflow (${args.stage}) — ${args.eventCount} step${
      args.eventCount === 1 ? "" : "s"
    }.`,
    `Generated ${ts} by Scelo · /dashboards/scelo`,
    "Note: this script applies the recorded filters/cleaning BEFORE the model",
    "steps. Scelo's in-app quick-run results were computed on the unfiltered",
    "in-memory dataset, so numbers produced here may differ from the app's.",
  ];
  switch (args.lang) {
    case "python":
      return [`"""`, ...banner, `"""`, ""];
    case "r":
      return banner.map((l) => `# ${l}`).concat([""]);
    case "cpp":
      return banner.map((l) => `// ${l}`).concat([""]);
    case "prompt":
      return banner.map((l) => `# ${l}`).concat([""]);
  }
}

// ── shared describers ────────────────────────────────────────────────────

// English description of a single filter — same shape we show in the chip.
function filterDescribe(f: Filter): string {
  switch (f.kind) {
    case "eq":
      return `${f.column} = ${typeof f.value === "string" ? JSON.stringify(f.value) : f.value}`;
    case "iqr":
      return `${formatNum(f.min)} ≤ ${f.column} ≤ ${formatNum(f.max)} (interquartile range)`;
    case "outliers":
      return `${f.column} is an outlier (< ${formatNum(f.loFence)} or > ${formatNum(f.hiFence)})`;
  }
}

function formatNum(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US");
  return String(v);
}

// Quote a string for inclusion as a Python literal — handles backslashes
// and the most common control chars. Single quotes throughout (matches
// PEP-8's default preference for short strings).
function pyStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function rStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function cppStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// strftime-style pattern for a chat-driven date reformat, shared by the
// Python / R exporters (both accept the C strftime codes used here).
function strftimeFor(style: "iso" | "us" | "eu"): string {
  switch (style) {
    case "us":
      return "%m/%d/%Y";
    case "eu":
      return "%d/%m/%Y";
    default:
      return "%Y-%m-%d";
  }
}

function dateStyleLabel(style: "iso" | "us" | "eu"): string {
  switch (style) {
    case "us":
      return "American (MM/DD/YYYY)";
    case "eu":
      return "European (DD/MM/YYYY)";
    default:
      return "ISO 8601 (YYYY-MM-DD)";
  }
}

// Each language has slightly different idioms for the same filter; expressed
// as a small `expr` helper so the per-event branches stay readable. "iqr"
// keeps the data inside the interquartile range; "outliers" KEEPS the
// outlying rows (matches the UI's behavior — clicking the outlier band
// filters TO the outliers, for inspection).
function pyFilterExpr(f: Filter): string {
  switch (f.kind) {
    case "eq": {
      const v = typeof f.value === "string" ? pyStr(f.value) : String(f.value);
      return `df[${pyStr(f.column)}] == ${v}`;
    }
    case "iqr":
      return `df[${pyStr(f.column)}].between(${formatNum(f.min)}, ${formatNum(f.max)})`;
    case "outliers":
      return `(df[${pyStr(f.column)}] < ${formatNum(f.loFence)}) | (df[${pyStr(f.column)}] > ${formatNum(f.hiFence)})`;
  }
}

function rFilterExpr(f: Filter): string {
  switch (f.kind) {
    case "eq": {
      const v = typeof f.value === "string" ? rStr(f.value) : String(f.value);
      return `${f.column} == ${v}`;
    }
    case "iqr":
      return `${f.column} >= ${formatNum(f.min)} & ${f.column} <= ${formatNum(f.max)}`;
    case "outliers":
      return `${f.column} < ${formatNum(f.loFence)} | ${f.column} > ${formatNum(f.hiFence)}`;
  }
}

// Generated formulae use the column names directly (same surface the user
// typed). Their syntax (`paid / premium`, `if(a, b, c)`) maps cleanly to
// Python and R with light adjustment.
function pyFormula(formula: string): string {
  // Replace `if(c, a, b)` → `np.where(c, a, b)`. Map Math.* helpers. Column
  // refs stay as bare identifiers — they reach pandas through df.eval().
  return formula
    .replace(/\bif\(/g, "np.where(")
    .replace(/\bisnull\(/g, "pd.isna(")
    .replace(/\bMath\.(\w+)\(/g, "np.$1(")
    .replace(/\b(log|log10|log2|exp|sqrt|abs|sin|cos|tan|floor|ceil|round|pow|sign)\(/g, "np.$1(");
}

function rFormula(formula: string): string {
  return formula
    .replace(/\bif\(/g, "ifelse(")
    .replace(/\bisnull\(/g, "is.na(")
    .replace(/\bMath\.(\w+)\(/g, "$1(")
    .replace(/\bcoalesce\(/g, "coalesce(");
}

// ── Python ───────────────────────────────────────────────────────────────

export function generatePython(events: ActivityEvent[], stage: string): string {
  const out: string[] = [];
  out.push(...headerLines({ lang: "python", stage, eventCount: events.length }));
  out.push("import pandas as pd");
  out.push("import numpy as np");
  out.push("");

  let datasetName: string | null = null;
  let modelsAttached: string[] = [];

  for (const [i, ev] of events.entries()) {
    const stepNo = i + 1;
    out.push(`# ── step ${stepNo} · ${ev.stage} · ${ev.kind} ────────────────────────`);
    switch (ev.kind) {
      case "dataset.load": {
        datasetName = ev.payload.name;
        const suffix = datasetName.toLowerCase().endsWith(".parquet")
          ? `pd.read_parquet(${pyStr(datasetName)})`
          : `pd.read_csv(${pyStr(datasetName)})`;
        out.push(
          `# Loaded ${ev.payload.source === "sample" ? "the bundled sample" : "an imported file"}: ${ev.payload.rows.toLocaleString()} rows × ${ev.payload.cols} cols`,
        );
        out.push(`# Columns: ${ev.payload.columns.join(", ")}`);
        if (ev.payload.source === "sample") {
          out.push(
            "# (Sample is a synthetic claims dataset bundled with Scelo. Substitute your own CSV/Parquet path.)",
          );
        }
        out.push(`df = ${suffix}`);
        break;
      }
      case "dataset.clear":
        out.push("# Dataset cleared in the UI — keep `df` for downstream steps below.");
        break;
      case "filter.add":
        out.push(`# ${ev.payload.description}`);
        out.push(`df = df[${pyFilterExpr(ev.payload.spec)}]`);
        break;
      case "filter.remove":
        out.push(`# Filter on ${ev.payload.column} removed in the UI — no-op in the script.`);
        break;
      case "filters.clearAll":
        out.push("# All filters cleared in the UI — no-op in the script.");
        break;
      case "cleaning.apply":
        out.push("# Cleaning ops applied via the banner:");
        for (const op of ev.payload.opLabels) out.push(`#   • ${op}`);
        out.push("for c in df.select_dtypes(include='object').columns:");
        out.push("    df[c] = df[c].astype(str).str.strip()");
        out.push("df = df.dropna(axis=1, how='all')");
        out.push("df = df.drop_duplicates()");
        break;
      case "cleaning.reformat-dates": {
        const fmt = strftimeFor(ev.payload.style);
        out.push(`# Reformat date column(s) to ${dateStyleLabel(ev.payload.style)}:`);
        for (const c of ev.payload.columns) {
          out.push(
            `df[${pyStr(c)}] = pd.to_datetime(df[${pyStr(c)}], errors="coerce").dt.strftime(${pyStr(fmt)})`,
          );
        }
        break;
      }
      case "cleaning.column":
        out.push(
          `# Column ${pyStr(ev.payload.column)} — ${ev.payload.action} (${ev.payload.affected} cells).`,
        );
        break;
      case "data.augment":
        out.push(
          `# Data augmentation: +${ev.payload.added} synthetic rows (${ev.payload.method}).`,
        );
        out.push(
          `df = pd.concat([df, df.sample(n=${ev.payload.added}, replace=True, random_state=0)], ignore_index=True)`,
        );
        out.push("# (the app also adds light Gaussian jitter to numeric columns)");
        break;
      case "derived.add":
        out.push(`# Derived column: ${ev.payload.name} = ${ev.payload.formula}`);
        out.push(
          `df[${pyStr(ev.payload.name)}] = df.eval(${pyStr(pyFormula(ev.payload.formula))})`,
        );
        break;
      case "models.aiPick": {
        out.push(`# Domain identified as: ${ev.payload.domain}`);
        out.push(`# AI picker (${ev.payload.source}) summary:`);
        out.push(`#   ${ev.payload.summary}`);
        out.push("# Selected models:");
        for (const m of ev.payload.models) {
          const cat = MODEL_BY_ID.get(m.id);
          out.push(`#   • ${cat?.name ?? m.id}${m.rationale ? ` — ${m.rationale}` : ""}`);
        }
        modelsAttached = ev.payload.models.map((m) => m.id);
        out.push(`models = [${modelsAttached.map((m) => pyStr(m)).join(", ")}]`);
        break;
      }
      case "model.toggle":
        out.push(`# Model ${ev.payload.id} ${ev.payload.enabled ? "enabled" : "disabled"}.`);
        if (!ev.payload.enabled) {
          out.push(`models = [m for m in models if m != ${pyStr(ev.payload.id)}]`);
        } else {
          out.push(
            `if ${pyStr(ev.payload.id)} not in models: models.append(${pyStr(ev.payload.id)})`,
          );
        }
        break;
      case "model.add":
        out.push(`# Manually added model: ${ev.payload.id}`);
        out.push(
          `if ${pyStr(ev.payload.id)} not in models: models.append(${pyStr(ev.payload.id)})`,
        );
        break;
      case "model.remove":
        out.push(`# Manually removed model: ${ev.payload.id}`);
        out.push(`models = [m for m in models if m != ${pyStr(ev.payload.id)}]`);
        break;
      case "runs.execute":
        out.push("# Run all enabled models against the prepared dataset.");
        out.push(
          "# Scelo's in-browser runner is a deterministic mock; in real use, fit each model",
        );
        out.push("# using the package most idiomatic for the family. Reserving models map to");
        out.push("# `chainladder` (pip install chainladder); pricing to `statsmodels` GLMs; etc.");
        out.push("results = {}");
        out.push("for model_id in models:");
        out.push("    # TODO: dispatch on model_id → fit the appropriate model.");
        out.push("    results[model_id] = None  # placeholder");
        break;
      case "workspace.validate":
        out.push(
          `# Global-workspace validation of ${ev.payload.modelId} (readout: ${ev.payload.readout}).`,
        );
        out.push(
          `#   participation ratio ${ev.payload.participationRatio.toFixed(2)}${ev.payload.swapR2 != null ? `, swap-consistency R2 ${ev.payload.swapR2.toFixed(2)}` : ""}.`,
        );
        out.push(`#   workspace directions: ${ev.payload.directions.join("; ") || "(none)"}.`);
        out.push("# Reproduce: build the gradient covariance C = E[grad f grad f^T] of a");
        out.push("# differentiable surrogate for the readout over the drivers, eigendecompose it");
        out.push("# (the active subspace), then validate by swap + ablation. numpy.linalg.eigh on");
        out.push("# the gradient covariance is the estimator; scikit-learn fits the surrogate.");
        break;
    }
    out.push("");
  }

  return out.join("\n");
}

// ── R ────────────────────────────────────────────────────────────────────

export function generateR(events: ActivityEvent[], stage: string): string {
  const out: string[] = [];
  out.push(...headerLines({ lang: "r", stage, eventCount: events.length }));
  out.push("library(readr)");
  out.push("library(dplyr)");
  out.push("library(tidyr)");
  out.push("");

  for (const [i, ev] of events.entries()) {
    out.push(`# ── step ${i + 1} · ${ev.stage} · ${ev.kind} ────────────────────────`);
    switch (ev.kind) {
      case "dataset.load": {
        const reader = ev.payload.name.toLowerCase().endsWith(".parquet")
          ? `arrow::read_parquet(${rStr(ev.payload.name)})`
          : `read_csv(${rStr(ev.payload.name)})`;
        out.push(
          `# Loaded ${ev.payload.source === "sample" ? "the bundled sample" : "an imported file"}: ${ev.payload.rows} rows × ${ev.payload.cols} cols`,
        );
        out.push(`df <- ${reader}`);
        break;
      }
      case "dataset.clear":
        out.push("# Dataset cleared in the UI — keep `df` for downstream steps.");
        break;
      case "filter.add":
        out.push(`# ${ev.payload.description}`);
        out.push(`df <- df %>% filter(${rFilterExpr(ev.payload.spec)})`);
        break;
      case "filter.remove":
      case "filters.clearAll":
        out.push("# Filter change in the UI — no-op in the script.");
        break;
      case "cleaning.apply":
        out.push("# Cleaning ops applied via the banner:");
        for (const op of ev.payload.opLabels) out.push(`#   • ${op}`);
        out.push("df <- df %>%");
        out.push("  mutate(across(where(is.character), stringr::str_trim)) %>%");
        out.push("  select(where(~ !all(is.na(.)))) %>%");
        out.push("  distinct()");
        break;
      case "cleaning.reformat-dates": {
        const fmt = strftimeFor(ev.payload.style);
        out.push(`# Reformat date column(s) to ${dateStyleLabel(ev.payload.style)}:`);
        for (const c of ev.payload.columns) {
          out.push(`df <- df %>% mutate(${c} = format(lubridate::as_date(${c}), ${rStr(fmt)}))`);
        }
        break;
      }
      case "cleaning.column":
        out.push(
          `# Column ${rStr(ev.payload.column)} — ${ev.payload.action} (${ev.payload.affected} cells).`,
        );
        break;
      case "data.augment":
        out.push(
          `# Data augmentation: +${ev.payload.added} synthetic rows (${ev.payload.method}).`,
        );
        out.push(
          `df <- dplyr::bind_rows(df, dplyr::slice_sample(df, n = ${ev.payload.added}, replace = TRUE))`,
        );
        break;
      case "derived.add":
        out.push(`# Derived column: ${ev.payload.name} = ${ev.payload.formula}`);
        out.push(`df <- df %>% mutate(${ev.payload.name} = ${rFormula(ev.payload.formula)})`);
        break;
      case "models.aiPick": {
        out.push(`# Domain identified as: ${ev.payload.domain}`);
        out.push(`# AI picker (${ev.payload.source}) summary: ${ev.payload.summary}`);
        for (const m of ev.payload.models) {
          const cat = MODEL_BY_ID.get(m.id);
          out.push(`#   • ${cat?.name ?? m.id}${m.rationale ? ` — ${m.rationale}` : ""}`);
        }
        const ids = ev.payload.models.map((m) => rStr(m.id)).join(", ");
        out.push(`models <- c(${ids})`);
        break;
      }
      case "model.toggle":
        out.push(`# Model ${ev.payload.id} ${ev.payload.enabled ? "enabled" : "disabled"}.`);
        if (!ev.payload.enabled) {
          out.push(`models <- setdiff(models, c(${rStr(ev.payload.id)}))`);
        } else {
          out.push(`models <- union(models, c(${rStr(ev.payload.id)}))`);
        }
        break;
      case "model.add":
        out.push(`models <- union(models, c(${rStr(ev.payload.id)}))`);
        break;
      case "model.remove":
        out.push(`models <- setdiff(models, c(${rStr(ev.payload.id)}))`);
        break;
      case "runs.execute":
        out.push("# Run all enabled models. Reserving models map to `ChainLadder`;");
        out.push("# mortality to `StMoMo`; pricing GLMs to base `glm()`.");
        out.push("results <- list()");
        out.push("for (m in models) {");
        out.push("  # TODO: dispatch on m → fit the appropriate model.");
        out.push("  results[[m]] <- NULL");
        out.push("}");
        break;
      case "workspace.validate":
        out.push(
          `# Global-workspace validation of ${ev.payload.modelId} (readout: ${ev.payload.readout}).`,
        );
        out.push(
          `#   participation ratio ${ev.payload.participationRatio.toFixed(2)}${ev.payload.swapR2 != null ? `, swap R2 ${ev.payload.swapR2.toFixed(2)}` : ""}; directions: ${ev.payload.directions.join("; ") || "(none)"}.`,
        );
        out.push(
          "# Reproduce: eigendecompose the readout's gradient covariance (active subspace),",
        );
        out.push("# then validate by swap + ablation interventions.");
        break;
    }
    out.push("");
  }

  return out.join("\n");
}

// ── C++ ──────────────────────────────────────────────────────────────────

// C++ has no first-class actuarial library in mainstream use — the
// generator emits a workflow skeleton (CSV read, filtering, derived
// columns) using <vector>/<unordered_map>, and leaves the model fits as
// TODO with a pointer to the canonical package in another language. The
// goal is to encode WHAT to do, not to be the user's complete codebase.
export function generateCpp(events: ActivityEvent[], stage: string): string {
  const out: string[] = [];
  out.push(...headerLines({ lang: "cpp", stage, eventCount: events.length }));
  out.push("// build: g++ -std=c++20 scelo_workflow.cpp -o scelo_workflow");
  out.push("");
  out.push("#include <algorithm>");
  out.push("#include <cmath>");
  out.push("#include <fstream>");
  out.push("#include <iostream>");
  out.push("#include <sstream>");
  out.push("#include <string>");
  out.push("#include <unordered_map>");
  out.push("#include <vector>");
  out.push("");
  out.push("using Row = std::unordered_map<std::string, std::string>;");
  out.push("");
  out.push("// Minimal CSV reader — assumes RFC4180-ish, no embedded commas.");
  out.push("static std::vector<Row> read_csv(const std::string& path) {");
  out.push("    std::ifstream f(path);");
  out.push("    std::string line;");
  out.push("    std::vector<std::string> header;");
  out.push("    std::vector<Row> rows;");
  out.push("    if (!std::getline(f, line)) return rows;");
  out.push("    {");
  out.push("        std::stringstream ss(line); std::string cell;");
  out.push("        while (std::getline(ss, cell, ',')) header.push_back(cell);");
  out.push("    }");
  out.push("    while (std::getline(f, line)) {");
  out.push("        Row r; std::stringstream ss(line); std::string cell; size_t i = 0;");
  out.push("        while (std::getline(ss, cell, ',') && i < header.size()) {");
  out.push("            r[header[i++]] = cell;");
  out.push("        }");
  out.push("        rows.push_back(r);");
  out.push("    }");
  out.push("    return rows;");
  out.push("}");
  out.push("");
  out.push("int main() {");

  for (const [i, ev] of events.entries()) {
    out.push(`    // ── step ${i + 1} · ${ev.stage} · ${ev.kind} ──`);
    switch (ev.kind) {
      case "dataset.load":
        out.push(
          `    // Loaded ${ev.payload.source === "sample" ? "bundled sample" : "imported file"}: ${ev.payload.rows} rows × ${ev.payload.cols} cols`,
        );
        out.push(`    auto df = read_csv(${cppStr(ev.payload.name)});`);
        break;
      case "dataset.clear":
        out.push("    // Dataset cleared in the UI — no-op in script.");
        break;
      case "filter.add": {
        out.push(`    // ${ev.payload.description}`);
        const spec = ev.payload.spec;
        const col = cppStr(spec.column);
        if (spec.kind === "eq") {
          const val = typeof spec.value === "string" ? cppStr(spec.value) : String(spec.value);
          out.push("    df.erase(std::remove_if(df.begin(), df.end(),");
          out.push(`        [&](const Row& r){ return r.at(${col}) != ${val}; }),`);
          out.push("        df.end());");
        } else if (spec.kind === "iqr") {
          out.push("    df.erase(std::remove_if(df.begin(), df.end(),");
          out.push(
            `        [&](const Row& r){ double v = std::stod(r.at(${col})); return !(v >= ${spec.min} && v <= ${spec.max}); }),`,
          );
          out.push("        df.end());");
        } else {
          // outliers — keep the rows OUTSIDE the fences.
          out.push("    df.erase(std::remove_if(df.begin(), df.end(),");
          out.push(
            `        [&](const Row& r){ double v = std::stod(r.at(${col})); return !(v < ${spec.loFence} || v > ${spec.hiFence}); }),`,
          );
          out.push("        df.end());");
        }
        break;
      }
      case "filter.remove":
      case "filters.clearAll":
        out.push("    // Filter change in the UI — no-op in script.");
        break;
      case "cleaning.apply":
        out.push("    // Cleaning ops applied via the banner:");
        for (const op of ev.payload.opLabels) out.push(`    //   • ${op}`);
        out.push("    // TODO: per-cell trim / null-normalise / dedupe pass.");
        break;
      case "cleaning.reformat-dates":
        out.push(`    // Reformat date column(s) to ${dateStyleLabel(ev.payload.style)}:`);
        for (const c of ev.payload.columns) {
          out.push(
            `    //   • parse ${cppStr(c)} and re-emit as ${strftimeFor(ev.payload.style)}.`,
          );
        }
        break;
      case "cleaning.column":
        out.push(
          `    // Column ${cppStr(ev.payload.column)} — ${ev.payload.action} (${ev.payload.affected} cells).`,
        );
        break;
      case "data.augment":
        out.push(
          `    // Data augmentation: +${ev.payload.added} synthetic rows (${ev.payload.method}).`,
        );
        break;
      case "derived.add":
        out.push(`    // Derived column: ${ev.payload.name} = ${ev.payload.formula}`);
        out.push(
          `    // TODO: evaluate the formula per row and assign to r[${cppStr(ev.payload.name)}].`,
        );
        break;
      case "models.aiPick":
        out.push(`    // Domain: ${ev.payload.domain}`);
        out.push(`    // AI picker (${ev.payload.source}): ${ev.payload.summary}`);
        for (const m of ev.payload.models) {
          const cat = MODEL_BY_ID.get(m.id);
          out.push(`    //   • ${cat?.name ?? m.id}${m.rationale ? ` — ${m.rationale}` : ""}`);
        }
        out.push(
          `    std::vector<std::string> models = {${ev.payload.models.map((m) => cppStr(m.id)).join(", ")}};`,
        );
        break;
      case "model.toggle":
        out.push(`    // Model ${ev.payload.id} ${ev.payload.enabled ? "enabled" : "disabled"}.`);
        break;
      case "model.add":
        out.push(`    models.push_back(${cppStr(ev.payload.id)});`);
        break;
      case "model.remove":
        out.push(
          `    models.erase(std::remove(models.begin(), models.end(), ${cppStr(ev.payload.id)}), models.end());`,
        );
        break;
      case "runs.execute":
        out.push("    // TODO: dispatch on each model_id and fit. No mainstream C++ actuarial");
        out.push("    //       library is widely available — consider linking against Python via");
        out.push("    //       pybind11 to reuse `chainladder` / `lifelib` / `statsmodels`.");
        break;
      case "workspace.validate":
        out.push(
          `    // Global-workspace validation of ${ev.payload.modelId} (readout: ${ev.payload.readout}).`,
        );
        out.push(
          `    //   participation ratio ${ev.payload.participationRatio.toFixed(2)}; directions: ${ev.payload.directions.join("; ") || "(none)"}.`,
        );
        out.push(
          "    // TODO: gradient-covariance eigendecomposition (active subspace) + swap/ablate.",
        );
        break;
    }
    out.push("");
  }

  out.push('    std::cout << "workflow complete — rows: " << df.size() << "\\n";');
  out.push("    return 0;");
  out.push("}");
  return out.join("\n");
}

// ── LLM-prompt ───────────────────────────────────────────────────────────

// Plain-language reproducible prompt. Designed to be pasted into any
// frontier LLM ("Claude, ChatGPT, Gemini, …") with a follow-up like "write
// Python that does this" — every step is described unambiguously enough
// that a competent model can re-emit code in any language.
export function generatePrompt(events: ActivityEvent[], stage: string): string {
  const out: string[] = [];
  out.push(...headerLines({ lang: "prompt", stage, eventCount: events.length }));
  out.push("You are helping me reproduce an actuarial analysis I built in Scelo.");
  out.push(
    "Below is a chronological log of every meaningful step I took (including the AI-initiated picks). Please write code in whichever language I name next that loads my dataset and reproduces every step exactly, in order, using idiomatic libraries.",
  );
  out.push("");
  out.push("Steps:");

  if (events.length === 0) {
    out.push("(no steps recorded yet — load a dataset to begin.)");
    return out.join("\n");
  }

  for (const [i, ev] of events.entries()) {
    const n = i + 1;
    switch (ev.kind) {
      case "dataset.load": {
        const src =
          ev.payload.source === "sample"
            ? "the bundled synthetic sample dataset"
            : `an imported file named "${ev.payload.name}"`;
        out.push(
          `${n}. Loaded ${src} (${ev.payload.rows.toLocaleString()} rows × ${ev.payload.cols} columns: ${ev.payload.columns.join(", ")}).`,
        );
        break;
      }
      case "dataset.clear":
        out.push(`${n}. Cleared the active dataset.`);
        break;
      case "filter.add":
        out.push(`${n}. Applied filter: ${filterDescribe(ev.payload.spec)}.`);
        break;
      case "filter.remove":
        out.push(`${n}. Removed the filter on \`${ev.payload.column}\`.`);
        break;
      case "filters.clearAll":
        out.push(`${n}. Cleared all filters.`);
        break;
      case "cleaning.apply":
        out.push(
          `${n}. Applied data-cleaning ops: ${ev.payload.opLabels.join(", ") || "(no specific ops)"}.`,
        );
        break;
      case "cleaning.reformat-dates":
        out.push(
          `${n}. Reformatted the date column(s) ${ev.payload.columns.map((c) => `\`${c}\``).join(", ")} to ${dateStyleLabel(ev.payload.style)}.`,
        );
        break;
      case "cleaning.column":
        out.push(
          `${n}. On column \`${ev.payload.column}\`: ${ev.payload.action} (${ev.payload.affected} cells).`,
        );
        break;
      case "data.augment":
        out.push(
          `${n}. Augmented the dataset: added ${ev.payload.added} synthetic rows (${ev.payload.method}).`,
        );
        break;
      case "derived.add":
        out.push(
          `${n}. Added a derived column \`${ev.payload.name}\` defined as \`${ev.payload.formula}\`.`,
        );
        break;
      case "models.aiPick": {
        const names = ev.payload.models.map((m) => MODEL_BY_ID.get(m.id)?.name ?? m.id).join(", ");
        out.push(
          `${n}. The AI (source: ${ev.payload.source}) identified the domain as **${ev.payload.domain}** and selected these models: ${names}. Rationale summary: ${ev.payload.summary}.`,
        );
        for (const m of ev.payload.models) {
          if (m.rationale) {
            out.push(`    - ${MODEL_BY_ID.get(m.id)?.name ?? m.id}: ${m.rationale}`);
          }
        }
        break;
      }
      case "model.toggle":
        out.push(
          `${n}. ${ev.payload.enabled ? "Enabled" : "Disabled"} the model \`${ev.payload.id}\`.`,
        );
        break;
      case "model.add":
        out.push(`${n}. Manually added the model \`${ev.payload.id}\`.`);
        break;
      case "model.remove":
        out.push(`${n}. Manually removed the model \`${ev.payload.id}\`.`);
        break;
      case "runs.execute":
        out.push(
          `${n}. Ran all enabled models (${ev.payload.models.join(", ")}). In your reproduction, fit them against the dataset as prepared by the steps above (filters/cleaning applied). Note: Scelo's in-app quick-run numbers were computed on the unfiltered in-memory dataset, so your results may legitimately differ.`,
        );
        break;
      case "workspace.validate":
        out.push(
          `${n}. Validated the global workspace of \`${ev.payload.modelId}\` against the readout \`${ev.payload.readout}\`: participation ratio ${ev.payload.participationRatio.toFixed(2)}${ev.payload.swapR2 != null ? `, swap-consistency R2 ${ev.payload.swapR2.toFixed(2)}` : ""}. The decision-relevant directions were: ${ev.payload.directions.join("; ") || "(none)"}. Reproduce by building the active subspace (eigenvectors of the gradient covariance E[grad f grad f^T]) of a differentiable surrogate for the readout, then validating with swap and ablation interventions.`,
        );
        break;
    }
  }

  out.push("");
  out.push(
    "If anything is ambiguous, use sensible defaults and explain your choices inline. Use widely-installed libraries (pandas / chainladder for Python; tidyverse / ChainLadder for R; std + pybind11 hand-offs for C++).",
  );
  return out.join("\n");
}

// One entry point: generate the artifact for a given language.
export function generateScript(args: {
  lang: ExportLang;
  events: ActivityEvent[];
  stage: string;
}): string {
  switch (args.lang) {
    case "python":
      return generatePython(args.events, args.stage);
    case "r":
      return generateR(args.events, args.stage);
    case "cpp":
      return generateCpp(args.events, args.stage);
    case "prompt":
      return generatePrompt(args.events, args.stage);
  }
}

export function fileExtensionFor(lang: ExportLang): string {
  switch (lang) {
    case "python":
      return "py";
    case "r":
      return "R";
    case "cpp":
      return "cpp";
    case "prompt":
      return "md";
  }
}
