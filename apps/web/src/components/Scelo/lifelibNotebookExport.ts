// lifelibNotebookExport.ts
//
// Bridge from a Scelo Hard Data result back to runnable lifelib Python.
// For each life-family model the user has executed in-browser, we can emit
// a Jupyter notebook (`.ipynb` JSON) pre-filled with:
//   1. A pip install cell — `lifelib`, `modelx`, `pandas`, `numpy`.
//   2. The user's model-point file embedded as a CSV-string-to-DataFrame
//      (so the user doesn't have to re-upload).
//   3. The lifelib library import + `Projection` invocation for the model
//      they picked.
//   4. A plot cell that mirrors the in-app result chart, using the same
//      column names lifelib produces.
//
// Output is a notebook string the caller can offer for download. Nothing
// is uploaded; everything is generated on the client.

import type { Dataset, Row } from "./SoftDataWorkstation";

// ─── Model → lifelib library mapping ─────────────────────────────────────

const LIFELIB_TARGETS: Record<
  string,
  { library: string; model: string; description: string }
> = {
  "basicterm-projection": {
    library: "basiclife",
    model: "BasicTerm_M",
    description: "Monthly term-life projection on a model-point file.",
  },
  "cashvalue-savings": {
    library: "savings",
    model: "CashValue_ME",
    description: "Universal-life / savings projection with account value.",
  },
  "ifrs17-csm": {
    library: "ifrs17sim",
    model: "IFRS17",
    description: "IFRS 17 LRC / LIC / CSM roll-forward.",
  },
  "solvency2-life": {
    library: "solvency2",
    model: "Projection",
    description: "Solvency II standard formula life underwriting SCR.",
  },
  "nested-stochastic": {
    library: "nestedlife",
    model: "Projection",
    description: "Outer real-world × inner risk-neutral nested projection.",
  },
  "smithwilson-curve": {
    library: "smithwilson",
    model: "Build",
    description: "EIOPA Smith-Wilson zero curve extrapolation to UFR.",
  },
  "cluster-modelpoints": {
    library: "cluster",
    model: "Cluster",
    description: "Model-point compression preserving liability sensitivity.",
  },
  "economic-curves": {
    library: "economic_curves",
    model: "Curves",
    description: "Bootstrap zero / forward / discount curves.",
  },
};

export function isLifelibModel(modelId: string): boolean {
  return modelId in LIFELIB_TARGETS;
}

export function lifelibTargetFor(modelId: string): {
  library: string;
  model: string;
  description: string;
} | null {
  return LIFELIB_TARGETS[modelId] ?? null;
}

// ─── CSV serialisation ──────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function datasetToCsv(dataset: Dataset): string {
  const lines: string[] = [];
  lines.push(dataset.columns.map(csvEscape).join(","));
  for (const row of dataset.rows) {
    lines.push(dataset.columns.map((c) => csvEscape((row as Row)[c])).join(","));
  }
  return lines.join("\n");
}

// ─── Notebook cell helpers ───────────────────────────────────────────────

interface NbCell {
  cell_type: "markdown" | "code";
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: unknown[];
  execution_count?: null;
}

function md(text: string): NbCell {
  return {
    cell_type: "markdown",
    metadata: {},
    source: text.split("\n").map((l, i, arr) => (i === arr.length - 1 ? l : l + "\n")),
  };
}

function code(text: string): NbCell {
  return {
    cell_type: "code",
    metadata: {},
    execution_count: null,
    outputs: [],
    source: text.split("\n").map((l, i, arr) => (i === arr.length - 1 ? l : l + "\n")),
  };
}

// ─── Per-model run cell ──────────────────────────────────────────────────

function runCellFor(modelId: string, library: string, model: string): string {
  switch (modelId) {
    case "basicterm-projection":
      return [
        "# Load the lifelib BasicTerm_M template and swap in our MPs.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Projection.model_point_table = mp.set_index('policy_id')",
        "",
        "# Project. lifelib returns a Cells object — convert to a frame.",
        "result = proj.Projection.result_pv()  # PV summary (premiums / claims / expenses / net CF)",
        "result",
      ].join("\n");
    case "cashvalue-savings":
      return [
        "# Load lifelib CashValue_ME and swap in our MPs.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Projection.model_point_table = mp.set_index('policy_id')",
        "",
        "result = proj.Projection.result_av()  # AV roll-forward summary",
        "result",
      ].join("\n");
    case "ifrs17-csm":
      return [
        "# Load ifrs17sim. The library auto-builds an IFRS17 cohort space",
        "# from the model-point table.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Projection.model_point_table = mp.set_index('policy_id')",
        "",
        "result = proj.Projection.result_csm()  # CSM roll-forward by period",
        "result",
      ].join("\n");
    case "solvency2-life":
      return [
        "# Solvency II life underwriting SCR via lifelib's solvency2 library.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Projection.model_point_table = mp.set_index('policy_id')",
        "",
        "scr = proj.Projection.life_scr()  # full SCR sub-module breakdown",
        "scr",
      ].join("\n");
    case "nested-stochastic":
      return [
        "# Nested stochastic outer × inner. Heavy — start with small N then scale.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Projection.model_point_table = mp.set_index('policy_id')",
        "",
        "proj.Projection.outer_paths = 200   # bump to 1000+ for production",
        "proj.Projection.inner_paths = 50    # bump to 100+ for production",
        "tvog = proj.Projection.tvog()",
        "tvog",
      ].join("\n");
    case "smithwilson-curve":
      return [
        "# Smith-Wilson curve fit — feed observed swap rates, extrapolate to UFR.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Build.observed = [(1, 0.032), (2, 0.0325), (5, 0.034), (10, 0.035), (20, 0.0355)]",
        "proj.Build.ufr = 0.0345",
        "proj.Build.alpha = 0.1",
        "curve = proj.Build.zero_curve()  # zero rates by tenor up to 100y",
        "curve",
      ].join("\n");
    case "cluster-modelpoints":
      return [
        "# Compress the MP file into K representative clusters.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Cluster.input_mp = mp.set_index('policy_id')",
        "proj.Cluster.K = max(25, len(mp) // 100)  # 1% compression",
        "compressed = proj.Cluster.fit_and_assign()",
        "compressed",
      ].join("\n");
    case "economic-curves":
      return [
        "# Bootstrap zero / forward / discount curves from quoted swaps.",
        `proj = lifelib.create("${library}", "${model}")`,
        "proj.Curves.swap_rates = [(1, 0.032), (2, 0.0325), (5, 0.034), (10, 0.035), (30, 0.0344)]",
        "zero = proj.Curves.zero()",
        "fwd  = proj.Curves.forward()",
        "disc = proj.Curves.discount()",
        "import pandas as pd",
        "pd.DataFrame({'zero': zero, 'fwd': fwd, 'disc': disc})",
      ].join("\n");
    default:
      return `# Model ${modelId} has no canonical lifelib invocation yet.`;
  }
}

// ─── Top-level builder ───────────────────────────────────────────────────

export function buildLifelibNotebook(modelId: string, dataset: Dataset | null): string {
  const target = lifelibTargetFor(modelId);
  if (!target) {
    throw new Error(`no lifelib target for model ${modelId}`);
  }
  const csv = dataset ? datasetToCsv(dataset) : null;

  const cells: NbCell[] = [
    md(
      [
        `# ${target.library} · ${target.model}`,
        "",
        target.description,
        "",
        `Generated from Scelo on ${new Date().toISOString().slice(0, 10)}. ` +
          `This notebook reproduces the in-browser run with the actual ` +
          `Python lifelib library. Run top-to-bottom.`,
        "",
        "**Source:** [github.com/lifelib-dev/lifelib](https://github.com/lifelib-dev/lifelib)",
      ].join("\n"),
    ),
    md("## 1. Install dependencies"),
    code(["# One-time install. Skip if your env already has lifelib.", "%pip install --quiet lifelib pandas numpy matplotlib"].join("\n")),
    md("## 2. Imports"),
    code(["import lifelib", "import pandas as pd", "import numpy as np", "import matplotlib.pyplot as plt"].join("\n")),
  ];

  if (csv) {
    cells.push(md(
      [
        "## 3. Model-point file",
        "",
        `Inlined from your Scelo dataset \`${dataset!.name}\` ` +
          `(${dataset!.rows.length} rows × ${dataset!.columns.length} cols). ` +
          `Replace with \`pd.read_csv(\"your_file.csv\")\` for production runs.`,
      ].join("\n"),
    ));
    cells.push(code([
      "from io import StringIO",
      "",
      "csv_data = '''" + csv.replace(/'''/g, "''' + \"'''\" + r'''") + "'''",
      "",
      "mp = pd.read_csv(StringIO(csv_data))",
      "mp.head()",
    ].join("\n")));
  } else {
    cells.push(md("## 3. Model-point file"));
    cells.push(code([
      "# No MP file attached. Replace with your own:",
      "# mp = pd.read_csv('your_model_points.csv')",
      "mp = pd.DataFrame(columns=['policy_id', 'age_at_entry', 'sex', 'sum_assured', 'policy_term', 'duration_mth', 'premium_pp'])",
    ].join("\n")));
  }

  cells.push(md("## 4. Run lifelib"));
  cells.push(code(runCellFor(modelId, target.library, target.model)));

  cells.push(md("## 5. Plot"));
  cells.push(code([
    "# Adjust the columns/series to match the result frame returned above.",
    "try:",
    "    result.plot(figsize=(10, 4))",
    "    plt.title('lifelib " + target.library + " / " + target.model + "')",
    "    plt.tight_layout()",
    "    plt.show()",
    "except Exception as e:",
    "    print('Plot helper failed:', e)",
    "    print('Frame is in `result` — call .plot() on the slice you want.')",
  ].join("\n")));

  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.11",
      },
    },
    cells,
  };
  return JSON.stringify(notebook, null, 2);
}

// Convenience: trigger a browser download. Caller passes the notebook
// string + a filename.
export function triggerNotebookDownload(filename: string, notebookJson: string): void {
  const blob = new Blob([notebookJson], { type: "application/x-ipynb+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
