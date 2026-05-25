"""Filter IBTrACS to a single basin and write a tidy CSV of track points.

This is the cheapest possible adapter: xarray + a single boolean mask.
The output schema (year, name, lat, lon, wind_kt, pressure_mb) is what
both loss.py and return_period_map.R expect.
"""

import sys
from pathlib import Path

import numpy as np
import xarray as xr
import pandas as pd

HERE = Path(__file__).resolve().parent.parent
NC = HERE / "data" / "IBTrACS.ALL.v04r00.nc"
OUT = HERE / "data" / "tracks_natl.csv"

BASIN = b"NA"  # North Atlantic; IBTrACS encodes basin as 2-byte strings


def main() -> int:
    if not NC.exists():
        print(f"missing {NC}: open Settings -> Data and download ibtracs.")
        return 2
    ds = xr.open_dataset(NC)
    basin_storm = ds["basin"].isel(date_time=0).values  # one basin per storm
    mask = basin_storm == BASIN
    sel = ds.isel(storm=mask)
    n = int(sel.dims["storm"])
    print(f"selected {n} storms from basin {BASIN.decode()}")
    rows: list[dict[str, object]] = []
    for s in range(n):
        name = sel["name"].isel(storm=s).values
        if isinstance(name, bytes):
            name = name.decode().strip()
        else:
            name = str(name).strip()
        time = pd.to_datetime(sel["time"].isel(storm=s).values)
        lat = sel["lat"].isel(storm=s).values
        lon = sel["lon"].isel(storm=s).values
        wind = sel["usa_wind"].isel(storm=s).values
        press = sel["usa_pres"].isel(storm=s).values
        for t in range(len(time)):
            if np.isnat(time[t]):
                continue
            rows.append(
                {
                    "year": time[t].year,
                    "name": name,
                    "lat": float(lat[t]),
                    "lon": float(lon[t]),
                    "wind_kt": float(wind[t]) if not np.isnan(wind[t]) else None,
                    "pressure_mb": float(press[t]) if not np.isnan(press[t]) else None,
                }
            )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(OUT, index=False)
    print(f"wrote {len(rows)} rows -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
