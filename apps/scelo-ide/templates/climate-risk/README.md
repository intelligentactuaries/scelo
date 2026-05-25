# Climate risk starter

A three-step pipeline showing how a tropical-cyclone catalogue becomes a
loss curve, then a return-period map: filter IBTrACS to a basin, run
Climada to translate hazard + exposure into impacts, then render the
return-period footprint as a choropleth in R.

## Run order

1. Download the IBTrACS dataset (Settings : Data) so
   `data/IBTrACS.ALL.v04r00.nc` exists.
2. `python python/tracks.py` : filter to the North Atlantic basin,
   write `data/tracks_natl.csv` (year, name, lat/lon track).
3. `python python/loss.py` : run a small Climada hazard -> exposure ->
   impact pipeline, write `data/return_periods.csv`.
4. `Rscript r/return_period_map.R` : ggplot choropleth of expected
   annual loss by US state.

## What this gives you

Three steps with one CSV between each is the smallest amount of glue
that still lets the actuary swap any one stage: drop in a different
basin filter, a different exposure file, or a different map provider.

## Layout

```
python/tracks.py            : IBTrACS NetCDF -> CSV
python/loss.py              : hazard + exposure -> losses
r/return_period_map.R       : losses -> ggplot choropleth
data/                       : NetCDF in, CSVs out (gitignored)
```
