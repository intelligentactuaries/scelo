"""Build a mortality table from the WHO life-tables CSV.

Inputs : data/who_life_tables.csv  (downloaded via Settings : Data)
Outputs: data/qx_male_2019.csv     (qx by age, 0..110)

The transform is intentionally explicit so a reader can see exactly which
WHO column maps to qx, and how lx/ex are derived from it. No pandas
shortcut hides the formulas.
"""

import csv
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
IN = HERE / "data" / "who_life_tables.csv"
OUT = HERE / "data" / "qx_male_2019.csv"

YEAR = 2019
SEX = "MLE"
COUNTRY = "GBR"


def read_qx(path: Path) -> dict[int, float]:
    qx: dict[int, float] = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if row.get("SpatialDim") != COUNTRY:
                continue
            if int(row.get("TimeDim", "0")) != YEAR:
                continue
            if row.get("Dim1") != SEX:
                continue
            age = int(row["Dim2"].rstrip("+"))
            qx[age] = float(row["NumericValue"])
    return qx


def build_lx(qx: dict[int, float], radix: int = 100_000) -> dict[int, float]:
    ages = sorted(qx)
    lx = {ages[0]: float(radix)}
    for i in range(len(ages) - 1):
        a = ages[i]
        lx[ages[i + 1]] = lx[a] * (1 - qx[a])
    return lx


def build_ex(lx: dict[int, float]) -> dict[int, float]:
    ages = sorted(lx)
    # Discrete ex with linear-in-period assumption: ex = sum_{k>=1} lx(x+k)/lx(x) + 0.5
    ex: dict[int, float] = {}
    total_from = {a: 0.0 for a in ages}
    running = 0.0
    for a in reversed(ages):
        running += lx[a]
        total_from[a] = running
    for a in ages:
        if lx[a] <= 0:
            ex[a] = 0.0
        else:
            ex[a] = (total_from[a] - lx[a]) / lx[a] + 0.5
    return ex


def main() -> int:
    if not IN.exists():
        print(f"missing {IN}: open Settings -> Data and download who-life-tables.")
        return 2
    qx = read_qx(IN)
    if not qx:
        print(f"no qx rows for {COUNTRY} {SEX} {YEAR}")
        return 1
    lx = build_lx(qx)
    ex = build_ex(lx)
    print(f"loaded {len(qx)} qx ages, ex(0)={ex[min(ex)]:.2f}, lx(60)/lx(0)={lx.get(60, math.nan)/lx[min(lx)]:.3f}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["age", "qx"])
        for a in sorted(qx):
            w.writerow([a, qx[a]])
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
