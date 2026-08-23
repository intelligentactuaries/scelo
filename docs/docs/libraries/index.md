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

1. **A data frame goes in first, and the columns are inferred.**
   `sc.triangle(df)` finds the origin, development and amount columns by
   name (`accident_year`, `AY`, `origin` all mean origin); pass names only
   when it guesses wrong, and the error tells you exactly what to pass.
2. **Every answer is a [Table](table.md).** Still a real
   `pandas.DataFrame` / `data.frame`, but it carries its `title`, its
   `basis` and its `notes`, and prints them under the numbers.
   [`hard`](hard-data.md) adds a content hash, a timestamp, the version
   and the audit trail: the one-way pipeline rule in practice — a number
   never travels without what produced it.
3. **Everything is one `sc.` (Python) or `sc_` (R) away.** Type the
   prefix and let completion show the map, or print it:
   `sc.cheatsheet()` / `sc_cheatsheet()`.

## The manual

| Chapter | What it covers |
|---|---|
| [Install & set up](install.md) | pip / R install, the extras, the IDE's runtimes, the swarm |
| [Quickstart](quickstart.md) | a full session in sixty seconds, both languages |
| [The Table](table.md) | the result type: title, basis, notes, provenance |
| [Soft data](soft-data.md) | load, profile, describe, tab, the 18 cleaning ops, combine |
| [Life & mortality](life.md) | life tables, commutation, factors, premiums, graduation, Lee–Carter, Kaplan–Meier, BasicTerm, SCR, CSM |
| [Reserving](reserving.md) | triangles, chain ladder, Mack, BF, Cape Cod, ODP bootstrap |
| [Finance](finance.md) | interest, annuities, bonds, curves, Smith–Wilson, Nelson–Siegel, Hull–White |
| [Risk](risk.md) | VaR / TVaR, aggregate losses, fitting, credibility, SCR aggregation |
| [Pricing & fairness](pricing-fairness.md) | GLMs, relativities, lift and Gini, fairness metrics and audits |
| [Climate](climate.md) | reanalysis ensembles, return periods, parametric triggers, AAL |
| [Forecast & the swarm](forecast-swarm.md) | the W(M, T, R) engine, scenario parsing, council, society, augment |
| [Workspace diagnostics](workspace.md) | the bottleneck and active-subspace readouts from the Global Workspace paper |
| [Hard data & reports](hard-data.md) | hard, verify, board packs, snapshots, the audit ledger |
| [Charts](charts.md) | the `plot_*` family and its palette |
| [The command line](cli.md) | `scelo profile file.csv` and friends |
| [Python notes](python.md) · [R notes](r.md) | what is idiomatic on each side |
| [Function reference](reference.md) | every exported name, A → Z |

## What is in them

| Stage | Python | R |
|---|---|---|
| Soft data | `load` `profile` `describe` `tab` `suggest` `clean` `combine` | `sc_load` `sc_profile` `sc_describe` `sc_tab` `sc_suggest` `sc_clean` `sc_combine` |
| Life | `life_table` `commutation` `factors` `premium` `ae` `model_points` `graduate` `lee_carter` `kaplan_meier` `exposure` `basicterm` `scr_life` `csm` `lifelib_run` | the same with `sc_` |
| Reserving | `triangle` `ata` `chain_ladder` `mack` `bf` `cape_cod` `bootstrap` `tail` `reserve` | the same with `sc_` |
| Finance | `discount_curve` `smith_wilson` `nelson_siegel` `nss` `hull_white` `pv` `irr` `annuity_certain` `duration` | the same with `sc_` |
| Risk | `var` `tvar` `aggregate_loss` `fit` `credibility` `aggregate_scr` `risk_margin` | the same with `sc_` |
| Pricing & fairness | `glm` `relativities` `freq_sev` `loss_ratio` `lift` `gini` `fairness` `fairness_audit` | the same with `sc_` |
| Climate | `ensemble` `return_period` `parametric_trigger` `aal` `anomaly` | the same with `sc_` |
| Forecast & swarm | `wmtr` `sensitivity` `council` `society` `augment` | the same with `sc_` |
| Hard data | `hard` `report` `export` `audit` `verify` `snapshot` | the same with `sc_` |
| Charts | `plot_rates` `plot_relativities` `plot_projection` `plot_scr` `plot_csm` `plot_bars` `plot_lines` `plot_triangle` (matplotlib) | the same with `sc_plot_` (base graphics) |

## Twins, tested against each other

Three implementations are kept in lock-step: the TypeScript inside Scelo
IDE, the Python package, and the R package. The R suite reads a golden
fixture computed by the Python package — life tables, commutation columns,
Mack on the published RAA triangle, Smith–Wilson, Panjer, GLM
coefficients, the cleaning plan for the dirty sample — and matches it to
1e-9. Both packages check the W(M, T, R) engine against the same fixture
generated by the IDE's TypeScript, down to the identical Mulberry32
random stream. Pick the language your team writes; the answers do not
change.
