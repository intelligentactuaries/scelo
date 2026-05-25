// Optional Python delegation that consumes the downloaded NFIP claims
// CSV (registered as the `nfip` dataset in apps/scelo-ide/src/main.ts).
// Returns per-state per-decade total paid + claim count + mean severity
// + 95th-percentile severity, ready for the climate flood Tool to use
// as a back-test against its synthetic distribution.
//
// First concrete consumer of the dataset-download registry: when the
// user runs `nfip-flood-losses` and IBTrACS / NFIP / etc. have been
// downloaded via /settings/data, the Tool uses real claims data instead
// of a synthetic substitute.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";

export interface NfipDecadeBin {
  state: string;
  decade: number;            // e.g. 1990, 2000, 2010, 2020
  claimCount: number;
  totalPaidUsd: number;
  meanSeverityUsd: number;
  p95SeverityUsd: number;
}

export interface NfipPythonOutput {
  rowsScanned: number;
  bins: NfipDecadeBin[];
  topStates: Array<{ state: string; totalPaidUsd: number }>;
  source: "nfip-python";
}

// Streams the CSV (pandas chunked read) so a 700 MB file doesn't
// pull the entire frame into RAM. NFIP columns of interest:
//   - state                  e.g. "FL", "LA", "TX"
//   - dateOfLoss             ISO timestamp; we bin by decade
//   - amountPaidOnBuildingClaim + amountPaidOnContentsClaim + amountPaidOnIncreasedCostOfComplianceClaim
const SCRIPT = `
import json, sys, os
try:
    payload = json.load(sys.stdin)
    csv_path = payload["csvPath"]
    if not os.path.exists(csv_path):
        print(json.dumps({"error": f"NFIP CSV not present at {csv_path}; download it via /settings/data first"}))
        sys.exit(2)
    import pandas as pd
    PAID_COLS = [
        "amountPaidOnBuildingClaim",
        "amountPaidOnContentsClaim",
        "amountPaidOnIncreasedCostOfComplianceClaim",
    ]
    USECOLS = ["state", "dateOfLoss", *PAID_COLS]
    rows_scanned = 0
    bin_agg = {}  # (state, decade) -> dict of running sums
    chunks = pd.read_csv(csv_path, usecols=USECOLS, chunksize=200_000, low_memory=False)
    severities = {}  # (state, decade) -> list[float] (kept bounded — we sample)
    SAMPLE_PER_BIN = 5000
    for chunk in chunks:
        chunk = chunk.dropna(subset=["state", "dateOfLoss"])
        for c in PAID_COLS:
            if c not in chunk.columns:
                chunk[c] = 0.0
        chunk["total_paid"] = chunk[PAID_COLS].fillna(0).sum(axis=1)
        chunk["decade"] = pd.to_datetime(chunk["dateOfLoss"], errors="coerce").dt.year // 10 * 10
        chunk = chunk.dropna(subset=["decade"])
        chunk["decade"] = chunk["decade"].astype(int)
        rows_scanned += len(chunk)
        for (state, decade), grp in chunk.groupby(["state", "decade"]):
            key = (state, int(decade))
            agg = bin_agg.setdefault(key, {"count": 0, "total": 0.0})
            agg["count"] += len(grp)
            agg["total"] += float(grp["total_paid"].sum())
            slot = severities.setdefault(key, [])
            remaining = SAMPLE_PER_BIN - len(slot)
            if remaining > 0:
                slot.extend(grp["total_paid"].head(remaining).tolist())
    import numpy as np
    bins = []
    for (state, decade), agg in bin_agg.items():
        sev_arr = np.array(severities.get((state, decade), [0.0]))
        bins.append({
            "state": state,
            "decade": decade,
            "claimCount": agg["count"],
            "totalPaidUsd": agg["total"],
            "meanSeverityUsd": float(sev_arr.mean()),
            "p95SeverityUsd": float(np.quantile(sev_arr, 0.95)),
        })
    bins.sort(key=lambda b: (b["state"], b["decade"]))
    by_state = {}
    for b in bins:
        by_state[b["state"]] = by_state.get(b["state"], 0) + b["totalPaidUsd"]
    top_states = sorted(by_state.items(), key=lambda x: -x[1])[:10]
    print(json.dumps({
        "rowsScanned": int(rows_scanned),
        "bins": bins,
        "topStates": [{"state": s, "totalPaidUsd": float(v)} for s, v in top_states],
        "source": "nfip-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runNfipPython(): Promise<NfipPythonOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  // The CSV must already be on disk via /settings/data.
  const ds = await window.scelo!.data.status("nfip");
  if (!ds.available || !ds.path) return null;
  const res = await runPython(SCRIPT, { stdin: JSON.stringify({ csvPath: ds.path }) });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as NfipPythonOutput;
  } catch {
    return null;
  }
}
