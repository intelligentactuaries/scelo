# Quickstart

The shortest useful session: load something messy, look at it, clean it,
run a model, and end with a number that carries its own audit trail. Every
output below is a real run, not a mock-up.

## Three lines to a reserve

=== "Python"

    ```python
    import scelo as sc

    claims = sc.sample("claims")     # or sc.load("claims.csv")
    res    = sc.reserve(claims)      # chain ladder, Mack, BF, ODP bootstrap
    print(res)
    ```

=== "R"

    ```r
    library(scelo)

    claims <- sc_sample("claims")    # or sc_load("claims.csv")
    res    <- sc_reserve(claims)
    print(res)
    ```

```text
                         latest      ultimate  ...           p95           p99
method
chain-ladder          1874437.0  3.407400e+06  ...           NaN           NaN
mack                  1874437.0  3.407400e+06  ...           NaN           NaN
bornhuetter-ferguson  1874437.0  3.407400e+06  ...           NaN           NaN
bootstrap             1874437.0  3.448399e+06  ...  2.316627e+06  2.775584e+06

— Reserve summary
  basis: paid · origin_year × dev
  · Triangle: 7 origins × 7 lags. Mack SE ±1.96 → [854,731, 2,211,194]; bootstrap p95 2,316,627.
  · Chain ladder and Mack share the point estimate; BF is seeded with the chain-ladder
    ultimates; the bootstrap is ODP with gamma process error.
```

One call found the origin, development and amount columns in a long claims
file, built the cumulative triangle, ran four methods, and printed the
caveats an actuary would want stated. That is the house style: **the notes
are part of the answer.**

## The session, stage by stage

### Soft data — look before you model

=== "Python"

    ```python
    df = sc.sample("dirty")   # a 53-row ledger with every real-world mess
    sc.profile(df)            # type, missing, unique, five-number summary
    sc.tab(df, "Region")      # Stata's tab: WEST, West and west, separately for now
    sc.suggest(df)            # the cleaning plan, with evidence
    clean = sc.clean(df)      # the safe ops only
    clean = sc.clean(df, "all")   # everything: dedupe, impute, cap outliers, snake_case
    ```

=== "R"

    ```r
    df <- sc_sample("dirty")
    sc_profile(df)
    sc_tab(df, "Region")
    sc_suggest(df)
    clean <- sc_clean(df)
    clean <- sc_clean(df, "all")
    ```

```text
                           op  ...                                                why
0                fix-encoding  ...            mojibake, NBSP or zero-width characters
1         collapse-whitespace  ...                        runs of internal whitespace
2              missing-tokens  ...                            missing markers: ?, TBD
3               parse-numeric  ...                   ≥ 80 % of cells parse as numbers
...
— cleaning plan · 12 op(s) · 53 rows × 11 cols
  · 7 safe op(s) run with clean(df); 5 need clean(df, "all") or an explicit list.
```

### Tools — the actuarial engines

=== "Python"

    ```python
    sc.life_table()                    # qx px lx dx Lx Tx ex, any basis
    sc.commutation(i=0.04)             # Dx Nx Cx Mx Rx Sx
    sc.factors(i=0.04, n=10)           # äx ax Ax äx:n A¹x:n nEx Ax:n
    sc.discount_curve({1: .03, 5: .04, 10: .05})
    sc.aggregate_loss("poisson", "lognormal", lam=5, mu=8, sigma=1)
    sc.glm(claims, "paid ~ C(line) + age", "gamma").relativities()
    sc.wmtr("pension scheme with a weakening sponsor covenant")
    ```

=== "R"

    ```r
    sc_life_table()
    sc_commutation(i = 0.04)
    sc_factors(i = 0.04, n = 10)
    sc_discount_curve(c(`1` = .03, `5` = .04, `10` = .05))
    sc_aggregate_loss("poisson", "lognormal", lam = 5, mu = 8, sigma = 1)
    sc_glm(claims, "paid ~ C(line) + age", "gamma") |> sc_relativities()
    sc_wmtr("pension scheme with a weakening sponsor covenant")
    ```

Each of those returns a [Table](table.md) with its
basis and notes attached. The chapters that follow take them one domain at
a time.

### Hard data — numbers that can travel

=== "Python"

    ```python
    tri = sc.triangle(claims)
    t   = sc.hard(sc.mack(tri).table, assumptions={"tail": 1.0})
    t.provenance["sha256"][:16]        # '18cc78c4c8676f59'
    sc.report(t, sc.life_table(), to="pack.html")
    sc.audit()                         # everything this session did, in order
    ```

=== "R"

    ```r
    tri <- sc_triangle(claims)
    t   <- sc_hard(sc_mack(tri)$table, assumptions = list(tail = 1.0))
    sc_report(t, sc_life_table(), to = "pack.html")
    sc_audit()
    ```

`hard` stamps a content hash, the timestamp, the library versions and the
chain of calls that produced the table — `load → triangle → mack`, each
step hashed. `report` writes a board pack where every table prints its
basis, its notes and its hash. `audit` is the session ledger.

## Same numbers, either language

The two libraries are twins, tested against each other. The R suite checks
life tables, commutation columns, Mack, Smith–Wilson, Panjer, GLM
coefficients and more against golden values computed by the Python package
to 1e-9 — and both run the W(M, T, R) forecast on the same Mulberry32
random stream as Scelo IDE itself:

```text
Python  sc.wmtr("pension scheme with a weakening sponsor covenant")
        → survival at horizon 0.539900
R       sc_wmtr("pension scheme with a weakening sponsor covenant")
        → survival at horizon 0.539900
```

Pick the language your team already writes; the answers do not change.

## Where next

- [Soft data](soft-data.md) — load, profile, clean, combine.
- [Reserving](reserving.md) — triangles and the four methods, in detail.
- [Life & mortality](life.md) — tables, factors, premiums, projections.
- [Hard data & reports](hard-data.md) — provenance, board packs, the audit ledger.
- `sc.cheatsheet()` / `sc_cheatsheet()` — the whole map on one screen, in your terminal.
