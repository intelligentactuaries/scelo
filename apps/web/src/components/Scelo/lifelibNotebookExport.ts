// lifelibNotebookExport.ts
//
// Bridge from a Scelo Hard Data result back to runnable lifelib Python.
// For each life-family model the user has executed in-browser, we can emit
// a Jupyter notebook (`.ipynb` JSON) pre-filled with:
//   1. A pip install cell pinned to the lifelib / modelx Scelo is verified
//      against (LIFELIB_VERSION in @scelo/core).
//   2. A cell that copies the lifelib library out of site-packages
//      (`lifelib.create`) and reads the model with `modelx.read_model` —
//      lifelib is a library of modelx models, there is nothing to import
//      from `lifelib.libraries`.
//   3. The user's model-point file embedded as a CSV-string-to-DataFrame
//      (so the user doesn't have to re-upload) plus a normalisation cell
//      that maps Scelo's MP columns onto what the model expects.
//   4. The model invocation for the model they picked — the same calls the
//      IDE's Python bridges make (bridges/*.ts), so notebook and card agree.
//   5. A plot cell that mirrors the in-app result chart.
//
// The model → library table lives in @scelo/core (LIFELIB_TARGETS) so the
// catalog, the bridges and this exporter cannot drift apart. Every run cell
// below was executed against lifelib 0.14.0 / modelx 0.32.0 on the bundled
// sample MP file (lifelibNotebookExport.test.ts drives the same code
// through a real interpreter when SCELO_LIFELIB_PYTHON is set).
//
// Output is a notebook string the caller can offer for download. Nothing
// is uploaded; everything is generated on the client.

import type { Dataset, Row } from "@scelo/core";
import {
  LIFELIB_PIP_REQUIREMENTS,
  LIFELIB_VERSION,
  type LifelibTarget,
  MODELX_VERSION,
  isLifelibModel as coreIsLifelibModel,
  lifelibTargetFor as coreLifelibTargetFor,
  lifelibLibrary,
} from "@scelo/core";

export function isLifelibModel(modelId: string): boolean {
  return coreIsLifelibModel(modelId);
}

export function lifelibTargetFor(modelId: string): LifelibTarget | null {
  return coreLifelibTargetFor(modelId);
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

// ─── Shared cells ────────────────────────────────────────────────────────

/** Cell 2: imports + `lifelib.create` into ./lifelib_<version>/<library>
 *  (idempotent) so `mx.read_model` has a folder to read. */
function loadLibraryCell(library: string): string {
  return [
    "import os",
    "import lifelib",
    "import modelx as mx",
    "import pandas as pd",
    "import numpy as np",
    "import matplotlib.pyplot as plt",
    "",
    `LIBRARY = ${JSON.stringify(library)}`,
    `LIB_DIR = os.path.join(f"lifelib_{lifelib.__version__}", LIBRARY)`,
    "if not os.path.isdir(LIB_DIR):",
    "    # lifelib is a library of modelx models: create() copies the library",
    "    # folder out of site-packages; read_model() loads a model from it.",
    "    lifelib.create(LIBRARY, LIB_DIR)",
    'print(f"lifelib {lifelib.__version__} · modelx {mx.__version__} · {LIB_DIR}")',
  ].join("\n");
}

/** Cell 3b: normalise Scelo's MP columns (case-insensitive aliases, sex to
 *  M/F, numeric coercion) into the canonical frame the run cells expect. */
const NORMALISE_MP_CELL = [
  "# Normalise the Scelo model-point columns. Same aliases the IDE accepts.",
  "ALIASES = {",
  '    "policy_id":    ["policy_id", "policyid", "policy", "id", "model_point_id", "mp_id", "point_id"],',
  '    "age_at_entry": ["age_at_entry", "ageatentry", "issue_age", "issueage", "age"],',
  '    "sex":          ["sex", "gender"],',
  '    "sum_assured":  ["sum_assured", "sumassured", "sa", "face_amount", "face", "benefit"],',
  '    "policy_term":  ["policy_term", "policyterm", "term", "term_years"],',
  '    "duration_mth": ["duration_mth", "durationmth", "duration_months", "duration"],',
  '    "premium_pp":   ["premium_pp", "premiumpp", "premium", "monthly_premium"],',
  '    "policy_count": ["policy_count", "policycount", "count", "lives"],',
  '    "account_value":["account_value", "av", "av_pp_init", "fund_value"],',
  "}",
  "low = {c.lower(): c for c in mp.columns}",
  "col = {k: next((low[a] for a in v if a in low), None) for k, v in ALIASES.items()}",
  "",
  "mpn = pd.DataFrame(index=mp.index)",
  'mpn["age_at_entry"] = pd.to_numeric(mp[col["age_at_entry"]], errors="coerce")',
  'mpn["sum_assured"]  = pd.to_numeric(mp[col["sum_assured"]], errors="coerce")',
  'mpn["policy_term"]  = pd.to_numeric(mp[col["policy_term"]], errors="coerce")',
  'mpn["sex"]          = mp[col["sex"]].astype(str).str.strip().str[:1].str.upper().replace({"W": "F"}).where(lambda s: s.isin(["M", "F"]), "M") if col["sex"] else "M"',
  'mpn["duration_mth"] = pd.to_numeric(mp[col["duration_mth"]], errors="coerce").fillna(0) if col["duration_mth"] else 0',
  'mpn["policy_count"] = pd.to_numeric(mp[col["policy_count"]], errors="coerce").fillna(1) if col["policy_count"] else 1',
  'if col["premium_pp"]:',
  '    mpn["premium_pp"] = pd.to_numeric(mp[col["premium_pp"]], errors="coerce")',
  'if col["account_value"]:',
  '    mpn["account_value"] = pd.to_numeric(mp[col["account_value"]], errors="coerce").fillna(0)',
  'mpn.index = pd.Index(mp[col["policy_id"]].astype(str) if col["policy_id"] else [f"MP{i+1}" for i in range(len(mp))], name="policy_id")',
  'mpn = mpn.dropna(subset=["age_at_entry", "sum_assured", "policy_term"])',
  'mpn = mpn.astype({"age_at_entry": int, "policy_term": int, "duration_mth": int})',
  "mpn.head()",
].join("\n");

// ─── Per-model run cell ──────────────────────────────────────────────────

function runCellFor(modelId: string, model: string): string {
  switch (modelId) {
    case "basicterm-projection":
      return [
        `# basiclife / ${model}: monthly in-force term projection.`,
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "P = m.Projection",
        'P.model_point_table = mpn[["age_at_entry", "sex", "policy_term", "policy_count", "sum_assured", "duration_mth"] + (["premium_pp"] if "premium_pp" in mpn else [])]',
        'if "premium_pp" in mpn:',
        "    # Use the file's premiums instead of lifelib's premium_table.",
        "    P.premium_pp.formula = lambda: model_point()['premium_pp']",
        "",
        "result = P.result_pv()      # per-policy PV Premiums / Claims / Expenses / Commissions / Net Cashflow",
        "cashflows = P.result_cf()   # aggregate monthly cash flows",
        'print("PV net cash flow:", round(result["PV Net Cashflow"].sum()))',
        "result.head()",
      ].join("\n");
    case "cashvalue-savings":
      return [
        `# savings / ${model}: account-value roll-forward. The library's product`,
        "# specs A-D are single-premium (A, B) or level-premium whole-life (C, D);",
        "# a Scelo MP file carries a monthly premium on a fixed term, so we add a",
        "# level-premium, fixed-term spec and point every model point at it.",
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "P = m.Projection",
        "spec = P.product_spec_table.copy()",
        'spec.loc["SCELO"] = {"premium_type": "LEVEL", "has_surr_charge": False, "surr_charge_id": np.nan, "load_prem_rate": 0.10, "is_wl": False}',
        "P.product_spec_table = spec",
        "table = pd.DataFrame({",
        '    "spec_id": "SCELO",',
        '    "age_at_entry": mpn["age_at_entry"], "sex": mpn["sex"], "policy_term": mpn["policy_term"],',
        '    "policy_count": mpn["policy_count"], "sum_assured": mpn["sum_assured"], "duration_mth": mpn["duration_mth"],',
        '    "premium_pp": mpn["premium_pp"] if "premium_pp" in mpn else mpn["sum_assured"] * 0.002,',
        '    "av_pp_init": mpn["account_value"] if "account_value" in mpn else 0.0,',
        '    "accum_prem_init_pp": 0.0,',
        "}, index=mpn.index)",
        "P.model_point_table = table",
        "P.scen_id = 1               # 1..10 pre-drawn investment-return scenarios",
        "result = P.result_pv()      # Premiums / Death / Surrender / Maturity / Expenses / Commissions / Investment Income / Change in AV / Net Cashflow",
        'print("PV net cash flow:", round(result["Net Cashflow"].sum()))',
        "result.head()",
      ].join("\n");
    case "ifrs17-csm":
      return [
        "# ifrs17sim (LEGACY — deprecated with simplelife in lifelib 0.12.0; ifrs17a is",
        "# the active IFRS 17 engine but is driven from nominal cash flows). Policies",
        "# are a (PolicyID, column) mapping in simplelife's PolicyData layout.",
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "custom = {}",
        "for pid, (_, r) in enumerate(mpn.iterrows(), start=1):",
        "    custom.update({",
        '        (pid, "Product"): "TERM", (pid, "PolicyType"): 1, (pid, "Gen"): 1, (pid, "Channel"): 1,',
        '        (pid, "Duration"): int(r["duration_mth"]) // 12, (pid, "Sex"): r["sex"], (pid, "IssueAge"): int(r["age_at_entry"]),',
        '        (pid, "PaymentMode"): 1, (pid, "PremFreq"): 12, (pid, "PolicyTerm"): int(r["policy_term"]),',
        '        (pid, "MaxPolicyTerm"): max(int(r["policy_term"]), 65), (pid, "PolicyCount"): float(r["policy_count"]),',
        '        (pid, "SumAssured"): float(r["sum_assured"]),',
        "    })",
        "m.Input.PolicyData = custom",
        "m.OuterProj.Policy.PolicyData = custom",
        "",
        "csm = {}",
        "for pid in range(1, len(mpn) + 1):",
        "    p = m.OuterProj[pid]",
        "    for t in range(p.last_t() + 1):",
        "        csm[t] = csm.get(t, 0.0) + p.CSM(t)",
        'result = pd.Series(csm, name="CSM balance").sort_index()',
        'print("CSM at initial recognition:", round(result.iloc[0]))',
        "result.head()",
      ].join("\n");
    case "solvency2-life":
      return [
        `# annuallife / ${model}: per-policy annual projection with the Solvency II`,
        "# life stresses as inner projections (successor to the deprecated solvency2).",
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "pol = pd.DataFrame({",
        '    "Product": "TERM", "PolType": 1, "Gen": 1, "Channel": np.nan,',
        '    "Duration": (mpn["duration_mth"] // 12).values, "Sex": mpn["sex"].values,',
        '    "IssueAge": mpn["age_at_entry"].values, "PaymentMode": 1, "PremFreq": 12,',
        '    "PolicyTerm": mpn["policy_term"].values, "MaxPolicyTerm": np.maximum(mpn["policy_term"].values, 65),',
        '    "PolicyCount": mpn["policy_count"].astype(float).values, "SumAssured": mpn["sum_assured"].astype(float).values,',
        '}, index=pd.Index(range(1, len(mpn) + 1), name="Policy"))',
        "m.InputData.scelo_policy_data = pol",
        'm.InputData.policy_data.formula = "def policy_data():\\n    return scelo_policy_data"',
        "",
        "R = m.Enums.LifeRiskID",
        'RISKS = [("mortality", R.MORT), ("longevity", R.LONGV), ("disability", R.DISAB),',
        '         ("lapse", R.LAPSE), ("expense", R.EXPS), ("revision", R.REV), ("cat", R.CAT)]',
        "subs = {k: 0.0 for k, _ in RISKS}",
        "for idx in range(len(pol)):          # ~0.1-0.5 s per term policy",
        "    p = m.Projection[idx]",
        "    for k, code in RISKS:",
        "        subs[k] += p.risk_life_sub(0, code)",
        "corr = [[m.Assumptions.life_corr(a, b) for _, b in RISKS] for _, a in RISKS]",
        "vals = list(subs.values())",
        "scr_life = sum(corr[i][j] * vals[i] * vals[j] for i in range(len(vals)) for j in range(len(vals))) ** 0.5",
        'result = pd.Series(subs, name="shock charge")',
        'print("Life SCR:", round(scr_life))',
        "result",
      ].join("\n");
    case "nested-stochastic":
      return [
        "# nestedlife (LEGACY — deprecated with simplelife in lifelib 0.12.0). Outer",
        "# projection per policy; InnerProj[t0] re-projects from t0, e.g. under a",
        "# surrender shock. Same PolicyData mapping as ifrs17sim.",
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "custom = {}",
        "for pid, (_, r) in enumerate(mpn.iterrows(), start=1):",
        "    custom.update({",
        '        (pid, "Product"): "TERM", (pid, "PolicyType"): 1, (pid, "Gen"): 1, (pid, "Channel"): 1,',
        '        (pid, "Duration"): int(r["duration_mth"]) // 12, (pid, "Sex"): r["sex"], (pid, "IssueAge"): int(r["age_at_entry"]),',
        '        (pid, "PaymentMode"): 1, (pid, "PremFreq"): 12, (pid, "PolicyTerm"): int(r["policy_term"]),',
        '        (pid, "MaxPolicyTerm"): max(int(r["policy_term"]), 65), (pid, "PolicyCount"): float(r["policy_count"]),',
        '        (pid, "SumAssured"): float(r["sum_assured"]),',
        "    })",
        "m.Input.PolicyData = custom",
        "m.OuterProj.Policy.PolicyData = custom",
        "",
        "T0 = 2                                  # re-project from year 2",
        "rows = []",
        "for pid in range(1, len(mpn) + 1):",
        "    o = m.OuterProj[pid]",
        "    inner = o.InnerProj[T0]",
        "    inner.asmp.SurrRateMult[T0] = 2      # inner scenario: doubled surrenders",
        "    rows.append({",
        '        "policy": mpn.index[pid - 1],',
        '        "outer_pv_net_cf_t0": o.PV_NetCashflow(T0),',
        '        "inner_pv_net_cf_t0": inner.PV_NetCashflow(T0),',
        "    })",
        'result = pd.DataFrame(rows).set_index("policy")',
        'result["shock_impact"] = result["inner_pv_net_cf_t0"] - result["outer_pv_net_cf_t0"]',
        "result.head()",
      ].join("\n");
    case "smithwilson-curve":
      return [
        "# smithwilson / model: EIOPA Smith-Wilson extrapolation. spot_rates are",
        "# annual-compound observed rates at u(i) (1-based tenor index); UFR is",
        "# CONTINUOUS (ln(1+ufr)); alpha is the convergence speed.",
        `m = mx.read_model(os.path.join(LIB_DIR, ${JSON.stringify(model)}))`,
        "sw = m.SmithWilson",
        "tenors = [1, 2, 5, 10, 20]                       # replace with your liquid tenors",
        "sw.spot_rates = [0.032, 0.0325, 0.034, 0.035, 0.0355]",
        "sw.N = len(tenors)",
        "sw.UFR = float(np.log(1 + 0.0345))",
        "sw.alpha = 0.1",
        "sw.tenors = tenors",
        "sw.u.formula = lambda i: tenors[i - 1]",
        "",
        "@mx.defcells(space=sw)",
        "def W_t(t, j):",
        "    uj = u(j)",
        "    return exp(-UFR * (t + uj)) * (alpha * min(t, uj) - 0.5 * exp(-alpha * max(t, uj)) * (exp(alpha * min(t, uj)) - exp(-alpha * min(t, uj))))",
        "",
        "@mx.defcells(space=sw)",
        "def P_t(t):",
        "    return exp(-UFR * t) + sum(zeta(j) * W_t(t, j) for j in range(1, N + 1))",
        "",
        "@mx.defcells(space=sw)",
        "def R_t(t):",
        "    return (1 / P_t(t)) ** (1 / t) - 1",
        "",
        'result = pd.Series({t: sw.R_t(t) for t in range(1, 101)}, name="zero rate")',
        "result.iloc[[0, 4, 9, 19, 39, 59, 99]]",
      ].join("\n");
    case "cluster-modelpoints":
      return [
        "# cluster: the library is a notebook (cluster_model_points.ipynb) — the",
        "# recipe is k-means over per-policy cash flows or PVs, then the nearest",
        "# real policy to each centroid becomes the representative, weighted by",
        "# cluster size. Here we cluster on the MP attributes; swap X for a",
        "# per-policy PV frame (e.g. BasicTerm_ME result_pv()) for better fidelity.",
        "from sklearn.cluster import KMeans",
        "from sklearn.metrics import pairwise_distances_argmin_min",
        "",
        'X = mpn[["age_at_entry", "sum_assured", "policy_term", "duration_mth"]].astype(float)',
        "X = (X - X.min()) / (X.max() - X.min()).replace(0, 1)",
        "K = max(2, min(len(X) // 4, 1000))",
        "km = KMeans(n_clusters=K, random_state=0, n_init=10).fit(X.to_numpy())",
        "closest, _ = pairwise_distances_argmin_min(km.cluster_centers_, X.to_numpy())",
        'labels = pd.Series(km.labels_, index=mpn.index, name="cluster_id")',
        "weights = labels.value_counts().sort_index()",
        "weights.index = mpn.index[closest]",
        "result = mpn.iloc[closest].copy()",
        'result["weight"] = weights',
        'print(f"{len(mpn)} policies → {K} representatives")',
        "result.head()",
      ].join("\n");
    case "economic-curves":
      return [
        "# economic_curves / smith_wilson: plain-numpy Smith-Wilson (ufr here is",
        "# ANNUAL-compound); economic / BasicHullWhite for stochastic short rates.",
        "import sys",
        'sys.path.insert(0, os.path.join(LIB_DIR, "smith_wilson"))',
        "from smith_wilson_funcs import SWCalibrate, SWExtrapolate",
        "",
        "M_obs = np.array([1, 2, 5, 10, 30])",
        "r_obs = np.array([0.032, 0.0325, 0.034, 0.035, 0.0344])",
        "ufr, alpha = 0.042, 0.1",
        "b = SWCalibrate(r_obs, M_obs, ufr, alpha)",
        "M_target = np.arange(1, 61)",
        "zero = SWExtrapolate(M_target, M_obs, b, ufr, alpha)",
        "disc = (1 + zero) ** (-M_target)",
        "fwd = np.append(disc[:-1] / disc[1:] - 1, np.nan)",
        'result = pd.DataFrame({"zero": zero, "disc": disc, "fwd_1y": fwd}, index=pd.Index(M_target, name="tenor"))',
        "result.iloc[[0, 1, 4, 9, 29, 59]]",
      ].join("\n");
    default:
      return `# Model ${modelId} has no canonical lifelib invocation yet.`;
  }
}

/** Libraries whose run cell needs a second `lifelib.create` (economic-curves
 *  also wants `economic`, cluster wants nothing beyond scikit-learn). */
function extraLibrariesFor(modelId: string): string[] {
  return modelId === "economic-curves" ? ["economic"] : [];
}

function pipCell(modelId: string): string {
  const extra = modelId === "cluster-modelpoints" ? ["scikit-learn"] : [];
  const reqs = [...LIFELIB_PIP_REQUIREMENTS, ...extra];
  return [
    `# One-time install. Scelo is verified against lifelib ${LIFELIB_VERSION} / modelx ${MODELX_VERSION}.`,
    `%pip install --quiet ${reqs.join(" ")}`,
  ].join("\n");
}

// ─── Top-level builder ───────────────────────────────────────────────────

export function buildLifelibNotebook(modelId: string, dataset: Dataset | null): string {
  const target = lifelibTargetFor(modelId);
  if (!target) {
    throw new Error(`no lifelib target for model ${modelId}`);
  }
  const lib = lifelibLibrary(target.library);
  const csv = dataset ? datasetToCsv(dataset) : null;
  const statusLine =
    target.status === "legacy"
      ? `\n\n> **Legacy library.** \`${target.library}\` is deprecated in lifelib ${lib?.deprecatedIn ?? "0.12.0"} (still shipped, still runs)${target.successor ? `; \`${target.successor}\` is the active successor` : ""}. Scelo keeps targeting it because it answers this question on a model-point file.`
      : "";

  const cells: NbCell[] = [
    md(
      [
        `# ${target.library} · ${target.model}`,
        "",
        target.description,
        "",
        `Generated from Scelo on ${new Date().toISOString().slice(0, 10)} against ` +
          `**lifelib ${LIFELIB_VERSION} · modelx ${MODELX_VERSION}**. This notebook reproduces ` +
          `the in-app result with the actual lifelib model — the same calls the Scelo IDE's ` +
          `bundled-Python bridge makes. Run top-to-bottom.`,
        "",
        "**Source:** [github.com/lifelib-dev/lifelib](https://github.com/lifelib-dev/lifelib) · [lifelib.io](https://lifelib.io)" +
          statusLine,
      ].join("\n"),
    ),
    md("## 1. Install dependencies"),
    code(pipCell(modelId)),
    md("## 2. Load the lifelib library"),
    code(loadLibraryCell(target.library)),
  ];
  for (const extra of extraLibrariesFor(modelId)) {
    cells.push(
      code(
        [
          `EXTRA_DIR = os.path.join(f"lifelib_{lifelib.__version__}", ${JSON.stringify(extra)})`,
          "if not os.path.isdir(EXTRA_DIR):",
          `    lifelib.create(${JSON.stringify(extra)}, EXTRA_DIR)`,
        ].join("\n"),
      ),
    );
  }

  if (csv) {
    cells.push(
      md(
        [
          "## 3. Model-point file",
          "",
          `Inlined from your Scelo dataset \`${dataset!.name}\` ` +
            `(${dataset!.rows.length} rows × ${dataset!.columns.length} cols). ` +
            `Replace with \`pd.read_csv(\"your_file.csv\")\` for production runs.`,
        ].join("\n"),
      ),
    );
    cells.push(
      code(
        [
          "from io import StringIO",
          "",
          "csv_data = '''" + csv.replace(/'''/g, "''' + \"'''\" + r'''") + "'''",
          "",
          "mp = pd.read_csv(StringIO(csv_data))",
          "mp.head()",
        ].join("\n"),
      ),
    );
  } else {
    cells.push(md("## 3. Model-point file"));
    cells.push(
      code(
        [
          "# No MP file attached. Replace with your own:",
          "# mp = pd.read_csv('your_model_points.csv')",
          "mp = pd.DataFrame(columns=['policy_id', 'age_at_entry', 'sex', 'sum_assured', 'policy_term', 'duration_mth', 'premium_pp'])",
        ].join("\n"),
      ),
    );
  }
  cells.push(code(NORMALISE_MP_CELL));

  cells.push(md("## 4. Run lifelib"));
  cells.push(code(runCellFor(modelId, target.model)));

  cells.push(md("## 5. Plot"));
  cells.push(
    code(
      [
        "# Adjust the columns/series to match the result frame returned above.",
        "try:",
        "    result.plot(figsize=(10, 4))",
        "    plt.title('lifelib " + target.library + " / " + target.model + "')",
        "    plt.tight_layout()",
        "    plt.show()",
        "except Exception as e:",
        "    print('Plot helper failed:', e)",
        "    print('Frame is in `result` — call .plot() on the slice you want.')",
      ].join("\n"),
    ),
  );

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
      scelo: {
        modelId,
        lifelib: LIFELIB_VERSION,
        modelx: MODELX_VERSION,
        library: target.library,
        model: target.model,
        libraryStatus: target.status,
      },
    },
    cells,
  };
  return JSON.stringify(notebook, null, 2);
}

/** Concatenated code cells (minus IPython magics) — what the test harness
 *  executes through a real interpreter to prove the notebook runs. */
export function notebookCodeAsScript(notebookJson: string): string {
  const nb = JSON.parse(notebookJson) as { cells: NbCell[] };
  return nb.cells
    .filter((c) => c.cell_type === "code")
    .map((c) =>
      c.source
        .join("")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("%"))
        .join("\n"),
    )
    .join("\n\n");
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
