// Optional Python delegation for the reserving family.
//
// Same pattern as bridges/lifelibBasicTermPython.ts: when the user is
// running inside the Scelo IDE desktop shell and the bundled CPython
// interpreter has the `chainladder` package available, we pipe the
// triangle as JSON into a small Python script that runs the canonical
// chainladder.Mack / chainladder.BornhuetterFerguson / chainladder.Bootstrap
// implementations and returns the ultimates + IBNR as JSON.
//
// Why "canonical" matters here: Scelo's in-browser TS port of chain-
// ladder is good for live exploration, but a reserving Board report
// referenced against chainladder's MackChainladder is the actual gold
// standard auditors expect. Same number out of two independent
// implementations is the cheapest possible reasonability check.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

export type ReservingMethod = "chain-ladder" | "mack" | "bornhuetter-ferguson" | "bootstrap";

export interface ChainladderPythonOutput {
  method: ReservingMethod;
  ultimates: number[];
  ibnr: number;
  cv?: number;            // Mack only — coefficient of variation
  se?: number;            // Mack only — standard error
  byOrigin: Array<{
    origin: number;
    latest: number;
    ultimate: number;
    ibnr: number;
  }>;
  source: "chainladder-python";
}

/** Common Python script — branches on the `method` argv to pick a runner.
 *  Reads `{origins:[…], devs:[…], cumByRow:[[…],[…]…]}` on stdin. */
const SCRIPT = `
import json, sys
try:
    payload = json.load(sys.stdin)
    method = payload.get("method", "chain-ladder")
    origins = payload["origins"]
    devs = payload["devs"]
    cum = payload["cumByRow"]   # rows in origin-order, dev-order
    import pandas as pd
    import chainladder as cl
    # chainladder expects a long-format DataFrame keyed by origin + valuation.
    long = []
    for oi, o in enumerate(origins):
        for di, d in enumerate(devs):
            v = cum[oi][di]
            if v is None: continue
            long.append({"origin": o, "valuation": o + d, "values": float(v)})
    df = pd.DataFrame(long)
    tri = cl.Triangle(df, origin="origin", development="valuation",
                      columns="values", cumulative=True)
    if method == "mack":
        m = cl.MackChainladder().fit(tri)
        ult = m.ultimate_.values.flatten().tolist()
        ibnr_total = float(m.ibnr_.values.sum())
        se = float(m.full_std_err_.iloc[:, -1].sum())
        cv = se / ibnr_total if ibnr_total else 0.0
        extra = {"se": se, "cv": cv}
    elif method == "bornhuetter-ferguson":
        # Apriori = expected loss ratio × latest premium proxy = sum of latest diagonal.
        apriori = float(tri.latest_diagonal.sum())
        bf = cl.BornhuetterFerguson(apriori=apriori).fit(tri)
        ult = bf.ultimate_.values.flatten().tolist()
        ibnr_total = float(bf.ibnr_.values.sum())
        extra = {}
    elif method == "bootstrap":
        bs = cl.BootstrapODPSample(n_sims=500).fit_transform(tri)
        m = cl.MackChainladder().fit(bs)
        ult = m.ultimate_.values.flatten().tolist()
        ibnr_total = float(m.ibnr_.values.sum())
        extra = {"se": float(m.full_std_err_.iloc[:, -1].sum())}
    else:
        # Vanilla volume-weighted chain-ladder.
        m = cl.Chainladder().fit(tri)
        ult = m.ultimate_.values.flatten().tolist()
        ibnr_total = float(m.ibnr_.values.sum())
        extra = {}
    latest_by_o = tri.latest_diagonal.values.flatten().tolist()
    by_origin = [
        {"origin": int(origins[i]), "latest": float(latest_by_o[i]),
         "ultimate": float(ult[i]), "ibnr": float(ult[i] - latest_by_o[i])}
        for i in range(len(origins))
    ]
    print(json.dumps({
        "method": method,
        "ultimates": [float(x) for x in ult],
        "ibnr": ibnr_total,
        "byOrigin": by_origin,
        "source": "chainladder-python",
        **extra,
    }))
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

export async function runChainladderPython(
  dataset: Dataset,
  method: ReservingMethod,
): Promise<ChainladderPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const tri = buildTrianglePayload(dataset);
  if (!tri) return null;
  const stdin = JSON.stringify({ method, ...tri });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as ChainladderPythonOutput;
  } catch {
    return null;
  }
}
