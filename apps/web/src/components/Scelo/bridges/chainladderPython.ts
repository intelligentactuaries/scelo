// Optional Python delegation for the reserving family.
//
// Same pattern as bridges/lifelibBasicTermPython.ts: when running inside the
// Scelo IDE desktop shell we pipe the triangle as JSON into a small Python
// script that computes the reserving estimates (chain-ladder / Mack / BF / ODP
// bootstrap) with numpy and returns ultimates + IBNR as JSON.
//
// Why numpy and not the `chainladder` library: chainladder builds its Triangle
// from origin/valuation DATES and infers the development axis from the calendar
// diagonal. Real triangles are frequently "development-truncated" parallelograms
// (e.g. the three oldest origins each carry the full N dev periods) whose latest
// diagonal spans MORE calendar years than there are development periods —
// chainladder then fabricates phantom origins and returns NaN ultimates for the
// oldest, fully-developed cohorts. The engine below indexes purely by
// development PERIOD (like the in-browser modelRunner.buildTriangle), so it is
// correct for any triangle shape. It matches chainladder's numbers exactly on a
// proper runoff (validated) while staying finite on the parallelograms that make
// the library NaN. The in-browser TS port remains a fast, guard-heavy estimate;
// this is the more rigorous Python cross-check (real Mack SE, real ODP bootstrap).

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

export type ReservingMethod = "chain-ladder" | "mack" | "bornhuetter-ferguson" | "bootstrap";

export interface ChainladderPythonOutput {
  method: ReservingMethod;
  ultimates: number[];
  ibnr: number;
  cv?: number;            // Mack only — coefficient of variation
  se?: number;            // Mack / bootstrap — standard error
  byOrigin: Array<{
    origin: number;
    latest: number;
    ultimate: number;
    ibnr: number;
  }>;
  source: "scelo-reserving-numpy";
}

/** numpy reserving engine — indexes by development PERIOD (not calendar date),
 *  so it is robust to development-truncated / parallelogram triangles that make
 *  the chainladder library emit NaN. Reads `{method, origins, devs, cumByRow}`
 *  on stdin; prints strict JSON (allow_nan=False) or `{"error": …}` + exit 1. */
const SCRIPT = `
import json, sys, warnings, math
warnings.filterwarnings("ignore")


def compute(payload):
    method = payload.get("method", "chain-ladder")
    origins = payload["origins"]
    devs = payload["devs"]
    cum = payload["cumByRow"]
    import numpy as np

    n_o, n_d = len(origins), len(devs)
    C = np.full((n_o, n_d), np.nan)
    for i in range(n_o):
        for k in range(n_d):
            v = cum[i][k]
            if v is not None:
                C[i, k] = float(v)

    last_k = np.array([
        max([k for k in range(n_d) if np.isfinite(C[i, k])], default=-1)
        for i in range(n_o)
    ])
    if np.all(last_k < 0):
        raise ValueError("triangle has no observed cells")

    # Volume-weighted age-to-age factors + Mack sigma^2 (zero-denominator
    # guarded; mirrors modelRunner.ataFactors: skip c_k==0/non-finite, factor
    # -> 1.0 on a zero-volume column). Sk_used[k] = column volume behind f[k].
    f = np.ones(n_d - 1)
    sig2 = np.full(n_d - 1, np.nan)
    Sk_used = np.zeros(n_d - 1)
    for k in range(n_d - 1):
        num = den = 0.0
        obs = []
        for i in range(n_o):
            ck, ck1 = C[i, k], C[i, k + 1]
            if not np.isfinite(ck) or not np.isfinite(ck1) or ck == 0:
                continue
            num += ck1
            den += ck
            obs.append((ck, ck1 / ck))
        f[k] = (num / den) if den > 0 else 1.0
        Sk_used[k] = den
        if len(obs) >= 2:
            sig2[k] = sum(c * (r - f[k]) ** 2 for c, r in obs) / (len(obs) - 1)

    # Mack tail sigma for single-observation factors.
    for k in range(n_d - 1):
        if not np.isfinite(sig2[k]):
            if k >= 2 and np.isfinite(sig2[k - 1]) and np.isfinite(sig2[k - 2]) and sig2[k - 2] > 0:
                sig2[k] = min(sig2[k - 1] ** 2 / sig2[k - 2], sig2[k - 2], sig2[k - 1])
            elif k >= 1 and np.isfinite(sig2[k - 1]):
                sig2[k] = sig2[k - 1]
            else:
                sig2[k] = 0.0

    cdf = np.ones(n_d)
    for k in range(n_d - 2, -1, -1):
        cdf[k] = f[k] * cdf[k + 1]
    latest = np.array([C[i, last_k[i]] for i in range(n_o)])
    ult_cl = latest * np.array([cdf[last_k[i]] for i in range(n_o)])
    ibnr_cl = ult_cl - latest

    def fin(x):
        try:
            x = float(x)
        except (TypeError, ValueError):
            return None
        return x if math.isfinite(x) else None

    def by_origin(ult):
        return [
            {"origin": int(origins[i]), "latest": fin(latest[i]),
             "ultimate": fin(ult[i]), "ibnr": fin(ult[i] - latest[i])}
            for i in range(n_o)
        ]

    extra = {}
    if method == "mack":
        ult = ult_cl
        Chat = C.copy()
        for i in range(n_o):
            for k in range(last_k[i], n_d - 1):
                Chat[i, k + 1] = Chat[i, k] * f[k]
        mse_i = np.zeros(n_o)
        for i in range(n_o):
            s = 0.0
            for k in range(last_k[i], n_d - 1):
                if f[k] == 0 or Sk_used[k] <= 0 or not np.isfinite(Chat[i, k]):
                    continue
                s += (sig2[k] / f[k] ** 2) * (1.0 / Chat[i, k] + 1.0 / Sk_used[k])
            mse_i[i] = ult[i] ** 2 * s
        total_mse = float(np.nansum(mse_i))
        for i in range(n_o):
            for j in range(i + 1, n_o):
                cov = 0.0
                for k in range(max(last_k[i], last_k[j]), n_d - 1):
                    if f[k] == 0 or Sk_used[k] <= 0:
                        continue
                    cov += (sig2[k] / f[k] ** 2) * (1.0 / Sk_used[k])
                total_mse += 2.0 * ult[i] * ult[j] * cov
        ibnr_total = float(np.nansum(ibnr_cl))
        se = math.sqrt(max(total_mse, 0.0))
        cv = se / ibnr_total if ibnr_total else 0.0
        extra = {"se": fin(se), "cv": fin(cv)}
    elif method == "bornhuetter-ferguson":
        # A-priori ultimate = paid-to-date (apriori=1.0, exposure=latest), the
        # convention the original bridge used: BF IBNR = latest x (1 - 1/CDF).
        pct_unreported = np.array([1.0 - 1.0 / cdf[last_k[i]] for i in range(n_o)])
        ult = latest + latest * pct_unreported
        ibnr_total = float(np.nansum(ult - latest))
    elif method == "bootstrap":
        rng = np.random.default_rng(42)
        obs_mask = np.isfinite(C)
        Chat = np.array([[ult_cl[i] / cdf[k] for k in range(n_d)] for i in range(n_o)])
        m_hat = np.diff(Chat, axis=1, prepend=0.0)
        m_obs = np.full((n_o, n_d), np.nan)
        for i in range(n_o):
            prev = 0.0
            for k in range(n_d):
                if obs_mask[i, k]:
                    m_obs[i, k] = C[i, k] - prev
                    prev = C[i, k]
        res, cells = [], []
        for i in range(n_o):
            for k in range(n_d):
                if obs_mask[i, k] and m_hat[i, k] > 0:
                    res.append((m_obs[i, k] - m_hat[i, k]) / math.sqrt(m_hat[i, k]))
                    cells.append((i, k))
        res = np.array(res)
        n_obs = len(res)
        dof = max(n_obs - (n_o + n_d - 1), 1)
        phi = float(np.sum(res ** 2) / dof)
        res_adj = res * math.sqrt(n_obs / dof)
        n_sims = 1000
        totals = np.empty(n_sims)
        for s in range(n_sims):
            samp = rng.choice(res_adj, size=n_obs, replace=True)
            Cstar = np.full((n_o, n_d), np.nan)
            for idx, (i, k) in enumerate(cells):
                mstar = m_hat[i, k] + samp[idx] * math.sqrt(m_hat[i, k])
                Cstar[i, k] = mstar if k == 0 else (Cstar[i, k - 1] if np.isfinite(Cstar[i, k - 1]) else 0.0) + mstar
            fstar = np.ones(n_d - 1)
            for k in range(n_d - 1):
                num = den = 0.0
                for i in range(n_o):
                    a, b = Cstar[i, k], Cstar[i, k + 1]
                    if np.isfinite(a) and np.isfinite(b) and a != 0:
                        num += b
                        den += a
                fstar[k] = (num / den) if den > 0 else 1.0
            reserve = 0.0
            for i in range(n_o):
                lk = last_k[i]
                cproj = C[i, lk]
                for k in range(lk, n_d - 1):
                    cnext = cproj * fstar[k]
                    m = cnext - cproj
                    if m > 0 and phi > 0:
                        shape = m / phi
                        if shape > 0:
                            m = rng.gamma(shape, phi)
                    reserve += max(m, 0.0)
                    cproj = cnext
            totals[s] = reserve
        ult = ult_cl
        ibnr_total = float(np.mean(totals))
        extra = {"se": fin(np.std(totals))}
    else:
        ult = ult_cl
        ibnr_total = float(np.nansum(ibnr_cl))

    if not math.isfinite(ibnr_total) or any(not math.isfinite(u) for u in ult):
        raise ValueError("non-finite reserve after computation")

    out = {
        "method": method,
        "ultimates": [float(x) for x in ult],
        "ibnr": float(ibnr_total),
        "byOrigin": by_origin(ult),
        "source": "scelo-reserving-numpy",
    }
    out.update({k: v for k, v in extra.items()})
    return out


try:
    print(json.dumps(compute(json.load(sys.stdin)), allow_nan=False))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

function buildTrianglePayload(dataset: Dataset): null | {
  origins: number[];
  devs: number[];
  cumByRow: (number | null)[][];
} {
  const cols = dataset.columns.map((c) => c.toLowerCase());
  const oi = cols.indexOf("origin_year");
  const di = cols.indexOf("dev_period");
  const pi = cols.indexOf("paid");
  if (oi < 0 || di < 0 || pi < 0) return null;
  const oCol = dataset.columns[oi];
  const dCol = dataset.columns[di];
  const pCol = dataset.columns[pi];
  const oSet = new Set<number>();
  const dSet = new Set<number>();
  const pairs: Array<{ o: number; d: number; v: number }> = [];
  for (const r of dataset.rows) {
    const o = r[oCol];
    const d = r[dCol];
    const v = r[pCol];
    if (typeof o !== "number" || typeof d !== "number" || typeof v !== "number") continue;
    oSet.add(o);
    dSet.add(d);
    pairs.push({ o, d, v });
  }
  if (oSet.size === 0) return null;
  const origins = [...oSet].sort((a, b) => a - b);
  const devs = [...dSet].sort((a, b) => a - b);
  const inc = new Map<number, Map<number, number>>();
  for (const o of origins) {
    const m = new Map<number, number>();
    for (const d of devs) m.set(d, 0);
    inc.set(o, m);
  }
  for (const p of pairs) {
    inc.get(p.o)?.set(p.d, (inc.get(p.o)?.get(p.d) ?? 0) + p.v);
  }
  const latestCal = pairs.reduce((m, p) => Math.max(m, p.o + p.d), -Infinity);
  const cumByRow: (number | null)[][] = origins.map((o) => {
    let acc = 0;
    return devs.map((d) => {
      if (o + d > latestCal) return null;
      acc += inc.get(o)?.get(d) ?? 0;
      return acc;
    });
  });
  return { origins, devs, cumByRow };
}

/** Pull the most useful failure reason out of a failed bridge exec: the
 *  script's structured {"error": "<Type>: <msg>"} on stdout first (it wraps
 *  everything, imports included, so this is populated on any Python-side
 *  failure), then raw stderr, then the exit code. */
function extractBridgeError(res: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): string {
  const out = (res.stdout || "").trim();
  if (out) {
    try {
      const p = JSON.parse(out) as { error?: unknown };
      if (p && typeof p.error === "string") return p.error;
    } catch {
      /* stdout wasn't JSON — fall through to stderr */
    }
  }
  const err = (res.stderr || "").trim();
  if (err) return err.slice(-300);
  return `exited with code ${res.exitCode ?? "null"}`;
}

// Returns the canonical result, or `null` when there is genuinely nothing to
// run (browser mode, or the dataset isn't a triangle — the in-browser path
// owns those). Anything that represents a *failed* Python attempt THROWS with
// the real reason: the caller (runModelAsync) turns a throw into the card's
// `bridgeError`, so the user sees e.g. "reserving: ModuleNotFoundError: …"
// instead of an opaque "produced no result".
export async function runChainladderPython(
  dataset: Dataset,
  method: ReservingMethod,
): Promise<ChainladderPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) {
    // Desktop IDE but no interpreter resolved — a broken/missing bundled
    // runtime. Surface it rather than silently degrading.
    throw new Error("bundled Python runtime not detected — used in-browser estimate");
  }
  const tri = buildTrianglePayload(dataset);
  if (!tri) return null; // not a triangle — the in-browser path handles that
  // The numpy engine is dev-period indexed and handles any triangle shape
  // (single origin, tiny, parallelogram) without the library's NaN failures,
  // so no shape guards are needed here — a genuinely non-finite reserve is
  // surfaced by the engine's own error.
  const stdin = JSON.stringify({ method, ...tri });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) {
    throw new Error(`reserving: ${extractBridgeError(res)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    const blob = (res.stdout || res.stderr || "").trim();
    throw new Error(`reserving: non-JSON output — ${blob ? blob.slice(0, 200) : "empty stdout"}`);
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(`reserving: ${String((parsed as { error: unknown }).error)}`);
  }
  return parsed as ChainladderPythonOutput;
}
