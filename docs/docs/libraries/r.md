# R notes

```r
install.packages("scelo", repos = c("https://intelligentactuaries.com/r", getOption("repos")))
library(scelo)
```

R ≥ 4.1, and the package imports nothing beyond `stats`, `utils` and
`tools` — it installs on a bare R, including the one Scelo IDE bundles.
(CRAN requires an open-source licence; this package is distributed from
the repository.) `jsonlite` + `curl` unlock the swarm client, `statmod`
Tweedie GLMs, `reticulate` the lifelib bridge.

## Idioms

**Everything is `sc_`.** Type the prefix and let completion show the
map — the R analogue of `sc.` in Python. Pipes read naturally:

```r
df |> sc_clean() |> sc_triangle() |> sc_mack()
```

**A `scelo_table` is a data.frame.** Subsetting keeps the title, basis
and notes; `sc_df(x)` strips them; `sc_notes(x)`, `sc_basis(x)`,
`sc_title(x)` read them; `sc_note(x, "reviewed")` appends. Printing
truncates at 60 rows — `options(scelo.print_rows = 200)` to raise it.

**Results are lists with S3 print methods.** `sc_mack(tri)` prints its
headline then the table; the pieces are `$table`, `$ibnr`, `$se`,
`$detail`. `summary(m)` gives the one-row frame; `predict(m, new)`
works on a `scelo_glm`.

**Back-tick the actuarial glyphs.** `sc_factors()` names its columns the
way the quantities are written — ``t$`äx` ``, ``t$`A¹x:10` ``.

**Seeds behave three ways**, worth knowing in a long session:
`sc_bootstrap()` and `sc_hull_white()` seed themselves and **restore**
your session RNG; `sc_aggregate_loss(method = "mc")`,
`sc_simulate_losses()` and `sc_reservoir()` call `set.seed()` and leave
it; the WMTR engine uses its own Mulberry32 stream and never touches
R's RNG at all.

**Base R only, deliberately.** Sorting uses radix order where
determinism matters (locale-independent, so results match Python
byte-for-byte); dates parse to UTC; text I/O is UTF-8 throughout.

## Testing

```r
install.packages("testthat")
# from packages/scelo-r:
testthat::test_dir("tests/testthat")
```

The suite reads `tests/testthat/fixtures/py_golden.json` — values
computed by the Python package — and checks life tables, commutation
functions, factors, premiums, the RAA Mack table, discount curves,
Smith–Wilson, Panjer, credibility, GLM coefficients, the cleaning plan
for the dirty sample and more to 1e-9; the WMTR engine is checked
against the same TypeScript fixture the Python package uses, and
`dev/build.sh` runs the full `R CMD check` pipeline.
