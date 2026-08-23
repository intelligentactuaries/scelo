# Scelo without the IDE

The brain layer ships as two libraries, `scelo` for Python and `scelo` for
R, for actuaries who would rather write three lines of code than click
through a workstation. They are the workstation's own logic, not a
re-implementation: the same import typing, the same cleaning rules and
thresholds, the same life tables and commutation functions, the same
reserving engine, the same W(M, T, R) forecast down to the random stream,
and a client for the bundled swarm.

=== "Python"

    ```python
    import scelo as sc

    df  = sc.load("claims.csv")        # typed the way the IDE types it
    df  = sc.clean(df)                 # the cleaning banner's safe ops, audited
    res = sc.reserve(df)               # chain ladder, Mack, BF, ODP bootstrap
    sc.report(res, to="pack.html")     # a board pack: tables that carry their basis and hash
    ```

=== "R"

    ```r
    library(scelo)

    df  <- sc_load("claims.csv")
    df  <- sc_clean(df)
    res <- sc_reserve(df)
    sc_report(res, to = "pack.html")
    ```

## The three rules both libraries follow

1. **A data frame goes in first, and the columns are inferred.** `sc.triangle(df)`
   finds the origin, development and amount columns by name
   (`accident_year`, `AY`, `origin` all mean origin); pass names only when it
   guesses wrong.
2. **Every table-shaped result carries its basis and its notes.** Print it and
   the caveats print under the numbers: the one-way pipeline rule in
   practice, a number never travels without what produced it. `sc.hard()`
   / `sc_hard()` add a content hash, a timestamp, the version and the audit
   trail.
3. **Everything is one `sc.` (Python) or `sc_` (R) away.** Type the prefix and
   let completion show the map, or print it: `sc.cheatsheet()` /
   `sc_cheatsheet()`.

## What is in them

| Stage | Python | R |
|---|---|---|
| Soft data | `load` `profile` `describe` `tab` `suggest` `clean` `combine` | `sc_load` `sc_profile` `sc_describe` `sc_tab` `sc_suggest` `sc_clean` `sc_combine` |
| Life | `life_table` `commutation` `factors` `premium` `ae` `model_points` `graduate` `lee_carter` `kaplan_meier` `exposure` `basicterm` `scr_life` `csm` `lifelib_run` | the same with `sc_` |
| Reserving | `triangle` `chain_ladder` `mack` `bf` `cape_cod` `bootstrap` `tail` `reserve` | the same with `sc_` |
| Finance | `discount_curve` `smith_wilson` `nelson_siegel` `hull_white` `pv` `irr` `annuity_certain` `duration` | the same with `sc_` |
| Risk | `var` `tvar` `aggregate_loss` `fit` `credibility` `aggregate_scr` | the same with `sc_` |
| Pricing & fairness | `glm` `relativities` `freq_sev` `loss_ratio` `lift` `fairness` `fairness_audit` | the same with `sc_` |
| Forecast & swarm | `wmtr` `sensitivity` `council` `society` `augment` | the same with `sc_` |
| Hard data | `hard` `report` `export` `audit` `verify` | the same with `sc_` |

Both packages are tested against the same golden numbers: the IDE's own
test fixtures, the published Mack / RAA results, and a fixture generated
from the TypeScript WMTR engine.
