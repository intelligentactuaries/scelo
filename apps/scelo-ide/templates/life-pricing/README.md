# Life pricing starter

A two-step deterministic pricing walk: build a mortality table in Python, then
run a level-premium cash-flow projection in R against the same qx vector.

## Run order

1. Download the WHO life tables dataset (Settings : Data) so `data/who_life_tables.csv`
   exists next to this README.
2. `python python/mortality.py` : reads the CSV, derives lx and ex, writes
   `data/qx_male_2019.csv` (qx by age, 0..110).
3. `Rscript r/level_premium.R` : reads the qx file, computes APV(annuity_due_n)
   and APV(insurance_n), prints the breakeven level premium.

## What this gives you

A minimal, end-to-end pricing template you can fork: the Python step owns the
biometric assumptions, the R step owns the actuarial math, and the CSV between
them is the contract. Swap the qx source for your own table; swap the R script
for a stochastic projection; the rest still works.

## Layout

```
python/mortality.py   : qx -> lx -> ex
r/level_premium.R     : qx -> APV -> level premium
data/                 : WHO CSV in, qx CSV out (gitignored)
```
