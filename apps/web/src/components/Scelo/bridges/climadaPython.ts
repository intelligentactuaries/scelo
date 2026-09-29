// Optional Python delegation for the climate family.
//
// Two paths, and the result says which one ran:
//
//   • CLIMADA proper — when IBTrACS has been downloaded via /settings/data
//     and the climada package imports: LitPop exposure + TCTracks hazard +
//     Emanuel impact functions → ImpactCalc AAL and return-period losses.
//   • otherwise a SYNTHETIC compound-Poisson loss model in plain numpy
//     (Poisson(4) events a year, lognormal severities scaled to the file's
//     exposure). No CLIMADA code runs on this path, so the card must never
//     call it a CLIMADA estimate — it used to ("AAL · climada-python").
//
// The synthetic calibration is arbitrary: median event loss 2% of total
// exposure, σ = 1.2, λ = 4 puts the AAL near 16% of exposure — far above a
// typical nat-cat AAL. Losses are capped at the total exposure (per event and
// per year); before the cap its RP100 / RP250 exceeded everything insured.

import {
  bridgeFailureReason,
  getRuntimeStatus,
  isDesktopIDE,
  runPython,
} from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";
import { findExposureColumn } from "../modelRunner";

export interface ClimadaPythonOutput {
  aal: number;
  rp10: number; // 10-year return-period loss
  rp100: number; // 100-year
  rp250: number; // 250-year
  countryAlpha3?: string;
  exposureValue: number;
  /** "climada-python+ibtracs" = the real CLIMADA pipeline ran;
   *  "synthetic-numpy" = the compound-Poisson stand-in (no CLIMADA code). */
  source: "synthetic-numpy" | "climada-python+ibtracs";
  /** Why the CLIMADA path was skipped or failed (synthetic runs only). */
  fallbackReason?: string;
}

const SCRIPT = `
import json, sys, os, numpy as np
try:
    payload = json.load(sys.stdin)
    total_exposure = float(payload.get("totalExposure", 0))
    country = (payload.get("country") or "").upper()[:3]
    ibtracs_path = payload.get("ibtracsPath")

    fallback_reason = "IBTrACS not downloaded (/settings/data)"
    # ── Real-IBTrACS path ────────────────────────────────────────────
    # When the user has downloaded the IBTrACS .nc file via
    # /settings/data, we use it directly. CLIMADA's TCTracks.from_ibtracs_netcdf
    # accepts a local file via the "file" argument.
    if ibtracs_path and os.path.exists(ibtracs_path):
        try:
            from climada.entity import LitPop, ImpfTropCyclone, ImpactFuncSet
            from climada.hazard import TCTracks, TropCyclone, Centroids
            from climada.engine import ImpactCalc
            exp = LitPop.from_countries([country], res_arcsec=600) if country else None
            if exp is None:
                # Without a country code we can't pull LitPop; fall back to synthetic.
                raise RuntimeError("no country code; needed for LitPop exposure")
            tracks = TCTracks.from_ibtracs_netcdf(file=ibtracs_path, year_range=(1980, 2020))
            cents = Centroids.from_lat_lon(exp.gdf.latitude.values, exp.gdf.longitude.values)
            haz = TropCyclone.from_tracks(tracks, centroids=cents)
            ifset = ImpactFuncSet([ImpfTropCyclone.from_emanuel_usa()])
            impact = ImpactCalc(exp, ifset, haz).impact()
            aal = float(impact.aai_agg)
            # Return-period losses from CLIMADA's empirical impact distribution.
            try:
                rp_curve = impact.calc_freq_curve(return_per=np.array([10, 100, 250]))
                rp10, rp100, rp250 = [float(x) for x in rp_curve.impact]
            except Exception:
                rp10 = rp100 = rp250 = float("nan")
            print(json.dumps({
                "aal": aal, "rp10": rp10, "rp100": rp100, "rp250": rp250,
                "countryAlpha3": country, "exposureValue": float(exp.gdf.value.sum()),
                "source": "climada-python+ibtracs",
            }))
            sys.exit(0)
        except Exception as e:
            # Fall through to synthetic so the Tool still returns *something* —
            # and say why, so the card never passes the stand-in off as CLIMADA.
            fallback_reason = f"CLIMADA path failed: {type(e).__name__}: {e}"
            sys.stderr.write(f"IBTrACS path failed, falling back to synthetic: {e}\\n")

    # ── Synthetic compound-Poisson fallback (numpy only, NOT CLIMADA) ──
    # N ~ Poisson(4) events a year, each an independent lognormal loss; a
    # year's loss is the SUM of its events. (The old code multiplied ONE
    # severity by the count — every event in a year identical — which fattened
    # the tail until RP100 / RP250 exceeded the total exposure.) No event and
    # no year can lose more than is insured.
    rng = np.random.default_rng(seed=42)
    n_years = 20000
    cap = max(total_exposure, 1.0)
    freq = rng.poisson(lam=4, size=n_years)
    sev = rng.lognormal(mean=np.log(cap * 0.02), sigma=1.2, size=int(freq.sum()))
    sev = np.minimum(sev, cap)
    annual = np.bincount(np.repeat(np.arange(n_years), freq), weights=sev, minlength=n_years)
    annual = np.minimum(annual, cap)
    aal = float(annual.mean())
    rp10 = float(np.quantile(annual, 1 - 1/10))
    rp100 = float(np.quantile(annual, 1 - 1/100))
    rp250 = float(np.quantile(annual, 1 - 1/250))

    print(json.dumps({
        "aal": aal, "rp10": rp10, "rp100": rp100, "rp250": rp250,
        "countryAlpha3": country or None, "exposureValue": total_exposure,
        "source": "synthetic-numpy", "fallbackReason": fallback_reason,
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runClimadaPython(dataset: Dataset): Promise<ClimadaPythonOutput | null> {
  // Error contract mirrors glmPython: null ONLY when the bridge does not
  // apply (browser build, or no usable exposure — the in-browser runner
  // then says which); a missing runtime or a failed script throws with the
  // reason so the caller can surface it on the result card.
  if (!isDesktopIDE()) return null;
  // Total exposure from the dataset's exposure-like column. Fuzzy match
  // (sum_insur* / tiv / exposure / paid) because real headers truncate —
  // the motor benchmark file spells it "sum_insurd". No column or a zero
  // sum means no run at all: quietly substituting a default exposure would
  // return confident losses anchored to nothing in the data.
  const expCol = findExposureColumn(dataset);
  if (!expCol) return null;
  let total = 0;
  for (const r of dataset.rows) {
    const v = r[expCol];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  if (total <= 0) return null;
  const status = await getRuntimeStatus();
  if (!status.python) throw new Error("bundled Python runtime not detected");
  const cols = dataset.columns.map((c) => c.toLowerCase());
  // Country alpha-3 guess from a country / iso column.
  let country: string | undefined;
  const countryIdx = ["country", "iso3", "iso_a3"].map((k) => cols.indexOf(k)).find((i) => i >= 0);
  if (countryIdx !== undefined && countryIdx >= 0) {
    const col = dataset.columns[countryIdx];
    const first = dataset.rows.find((r) => typeof r[col] === "string");
    if (first) country = String(first[col]);
  }
  // Check whether the user has downloaded IBTrACS via /settings/data.
  // When present, the Python script switches to the canonical CLIMADA
  // pipeline (LitPop + TCTracks + ImpactCalc) instead of the synthetic
  // distribution.
  let ibtracsPath: string | null = null;
  try {
    const s = await window.scelo!.data.status("ibtracs");
    if (s.available && s.path) ibtracsPath = s.path;
  } catch {
    // data IPC unavailable — stay on synthetic.
  }
  const stdin = JSON.stringify({
    totalExposure: total,
    country,
    ibtracsPath,
  });
  const res = await runPython(SCRIPT, { stdin });
  if (!res.ok) {
    throw new Error(bridgeFailureReason(res));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    throw new Error("climada bridge returned non-JSON output");
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return parsed as ClimadaPythonOutput;
}
