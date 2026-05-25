"""Tiny Climada hazard -> exposure -> impact pipeline.

Uses Climada's bundled US LitPop exposure (no extra downloads) and the
storms loaded from data/tracks_natl.csv. Writes per-state return-period
losses to data/return_periods.csv for the R map step.

If Climada isn't installed, the script prints the install hint and
exits with code 2 rather than tracebacking, so the README run order
stays self-explanatory.
"""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
TRACKS = HERE / "data" / "tracks_natl.csv"
OUT = HERE / "data" / "return_periods.csv"

try:
    from climada.hazard import TCTracks, TropCyclone, Centroids
    from climada.entity import LitPop
    from climada.engine import Impact
except ImportError as e:
    print("Climada not installed. In the terminal:")
    print("  pip install climada")
    print(f"(import error: {e})")
    sys.exit(2)


def main() -> int:
    if not TRACKS.exists():
        print(f"missing {TRACKS}: run python/tracks.py first.")
        return 2
    print("loading tracks from", TRACKS)
    tc_tracks = TCTracks.from_ibtracs_netcdf(provider="usa", year_range=(2000, 2020), basin="NA")
    tc_tracks.equal_timestep(0.5)

    # 1 deg centroid grid over the US East Coast.
    cent = Centroids.from_pnt_bounds((-95, 24, -65, 45), res=1.0)
    tc_haz = TropCyclone.from_tracks(tc_tracks, centroids=cent)

    exp = LitPop.from_countries("USA", res_arcsec=600)
    exp.assign_centroids(tc_haz)
    impact = Impact()
    impact.calc(exp, exp.impact_funcs, tc_haz)
    rp = impact.local_exceedance_imp(return_periods=(10, 100, 250))
    rp.to_csv(OUT, index=False)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
