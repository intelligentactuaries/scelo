// Optional Python delegation that consumes the downloaded WHO Global
// Health Observatory life-table CSV (registered as the `who-life-tables`
// dataset in apps/scelo-ide/src/main.ts). Returns the qx series for a
// chosen country + sex, plus life-expectancy at birth and at 65.
//
// The TS in-browser fallback returns canned aggregates because there's
// no way to ship the WHO data in the renderer bundle. This is the
// canonical reference path — country-specific qx priors for any of WHO's
// 194 member states.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";

export interface WhoMortalityOutput {
  country: string;            // ISO 3-letter
  sex: "M" | "F" | "B";       // Both = the unisex line
  vintage: number;            // year of the table
  e0: number;                 // life expectancy at birth (years)
  e65: number;                // life expectancy at 65
  qxByAge: Array<{ age: number; qx: number }>;
  rowsScanned: number;
  source: "who-mortality-python";
}

// The WHO GHO endpoint for LIFE_0000000031 returns long-format CSV with
// columns IndicatorCode, SpatialDim (ISO3 country), TimeDim (year),
// Dim1 (sex code: MLE / FMLE / BTSX), Dim2 (age band code), NumericValue
// (qx per 1000). We filter to the chosen country + sex + latest vintage,
// parse the age-band codes into integer lower bounds, and synthesise
// the headline e0 + e65 via a discrete lx-from-qx walk so the caller
// doesn't need to download a second indicator just for the summary.
const SCRIPT = `
import json, sys, os
try:
    payload = json.load(sys.stdin)
    csv_path = payload["csvPath"]
    country  = payload.get("country", "ZAF").upper()
    sex      = payload.get("sex", "B").upper()  # M | F | B (both)
    if not os.path.exists(csv_path):
        print(json.dumps({"error": f"WHO life-tables CSV not present at {csv_path}"}))
        sys.exit(2)

    import pandas as pd
    df = pd.read_csv(csv_path, low_memory=False)

    # Defensive — fail loud if WHO's columns ever drift.
    needed = {"IndicatorCode", "SpatialDim", "TimeDim", "Dim1", "Dim2", "NumericValue"}
    missing = needed - set(df.columns)
    if missing:
        print(json.dumps({"error": f"missing columns: {sorted(missing)}"}))
        sys.exit(3)
    rows_scanned = int(len(df))

    # Indicator filter: the dataset URL targets LIFE_0000000031 (qx),
    # but some bulk WHO dumps stack multiple indicators in one file —
    # belt-and-braces filter.
    df = df[df["IndicatorCode"] == "LIFE_0000000031"]
    df = df[df["SpatialDim"] == country]
    if df.empty:
        print(json.dumps({"error": f"country {country!r} has no qx data"}))
        sys.exit(4)

    latest_year = int(df["TimeDim"].max())
    df_latest = df[df["TimeDim"] == latest_year]

    sex_map = {"M": "MLE", "F": "FMLE", "B": "BTSX"}
    sex_code = sex_map.get(sex, "BTSX")
    df_sex = df_latest[df_latest["Dim1"] == sex_code]
    if df_sex.empty:
        df_sex = df_latest[df_latest["Dim1"] == "BTSX"]

    # Age codes look like "AGELT1", "AGE1-4", "AGE5-9", …, "AGE85PLUS".
    def lower_age(code):
        s = str(code).replace("AGE", "")
        if s.startswith("LT"): return 0
        if s.endswith("PLUS"):
            try: return int(s[:-4])
            except: return -1
        if "-" in s: return int(s.split("-")[0])
        try: return int(s)
        except: return -1
    def band_width(code, lower):
        s = str(code).replace("AGE", "")
        if s.startswith("LT"): return 1               # AGELT1 → 1 year
        if s.endswith("PLUS"): return 100 - lower     # open ended; finite for survival walk
        if "-" in s:
            hi = int(s.split("-")[1])
            return hi - lower + 1
        return 1

    df_sex = df_sex.copy()
    df_sex["age_lower"] = df_sex["Dim2"].map(lower_age)
    df_sex = df_sex[df_sex["age_lower"] >= 0].sort_values("age_lower")

    # WHO qx is per 1000 — normalise to a probability in [0, 1].
    qx_by_age = []
    for r in df_sex.itertuples():
        qx = float(r.NumericValue) / 1000.0
        qx = max(0.0, min(qx, 1.0))
        width = band_width(r.Dim2, int(r.age_lower))
        qx_by_age.append({"age": int(r.age_lower), "qx": qx, "width": width})

    # Discrete e0 + e65 from the band-by-band survival walk:
    #   lx[i+1] = lx[i] * (1 - qx[i]),  Lx[i] = (lx[i] + lx[i+1]) / 2 * width
    # Sum of Lx[i:] / lx[i] gives e at the start of band i.
    if qx_by_age:
        lx = [100000.0]
        widths = [b["width"] for b in qx_by_age]
        for b in qx_by_age:
            lx.append(lx[-1] * (1.0 - b["qx"]))
        big_lx = []
        for i in range(len(qx_by_age)):
            big_lx.append((lx[i] + lx[i + 1]) / 2.0 * widths[i])
        e0 = sum(big_lx) / lx[0]
        # e65 = sum of Lx from the first band whose lower >= 65 / lx[that index]
        idx65 = next((i for i, b in enumerate(qx_by_age) if b["age"] >= 65), None)
        e65 = (sum(big_lx[idx65:]) / lx[idx65]) if idx65 is not None and lx[idx65] > 0 else 0.0
    else:
        e0 = 0.0
        e65 = 0.0

    print(json.dumps({
        "country": country,
        "sex": sex,
        "vintage": latest_year,
        "e0": e0,
        "e65": e65,
        "qxByAge": [{"age": b["age"], "qx": b["qx"]} for b in qx_by_age],
        "rowsScanned": rows_scanned,
        "source": "who-mortality-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runWhoMortalityPython(
  country: string = "ZAF",
  sex: "M" | "F" | "B" = "B",
): Promise<WhoMortalityOutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const ds = await window.scelo!.data.status("who-life-tables");
  if (!ds.available || !ds.path) return null;
  const res = await runPython(SCRIPT, {
    stdin: JSON.stringify({ csvPath: ds.path, country, sex }),
  });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as WhoMortalityOutput;
  } catch {
    return null;
  }
}
