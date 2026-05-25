# Reserving starter

The org's headline use case in one template: Mack 1993 chain-ladder on the
RAA triangle, the same pinned regression (IBNR = 52,135) that anchors the
production reserving specialist. Two engines, one triangle.

## Run order

1. `Rscript r/mack_raa.R` : runs the R ChainLadder package end-to-end :
   Mack point estimate, Mack standard error, bootstrap percentiles. Writes
   `data/mack_results.json` with the headline numbers + the full IBNR
   distribution.
2. `python python/verify.py` : re-runs the same RAA triangle through the
   pure-Python `chainladder` package and prints the divergence vs the R
   result. A bug in either engine shows up here in seconds.
3. `make report` : optional. Concatenates the two outputs into a one-page
   summary in `out/report.md` (pure markdown, paste into a PR for a
   first-cut audit).

## Why this template

Real actuarial workflows live across R and Python; a fresh contributor
should see the seam, not pretend it doesn't exist. The Mack 1993 method
specifically is the floor for unpaid-claim estimation in IFRS 17 + most
prudential regimes : worth knowing in both engines.

## Layout

```
r/mack_raa.R         : ChainLadder::MackChainLadder() + boot
python/verify.py     : chainladder.MackChainladder() cross-check
data/mack_results.json : R writes here, Python reads here
out/report.md        : produced by `make report`
```

The pinned regression for this triangle is **IBNR ≈ 52,135**; both engines
should land within a few units of that.
