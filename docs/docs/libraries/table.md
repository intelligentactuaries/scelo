# The Table

Every table-shaped answer either library gives is a **Table**: a real data
frame — `pandas.DataFrame` in Python, `data.frame` in R — that also
carries what an actuary needs to trust it. Nothing about it stops being a
data frame: slice it, merge it, plot it, feed it to any other package.
The extras ride along.

| Carried | What it is |
|---|---|
| `title` | one line naming the table |
| `basis` | one line of provenance — `Gompertz–Makeham (illustrative) · i = 4 %` |
| `notes` | the caveats, printed under the numbers every time |
| `provenance` | a content hash, timestamp, versions and call trail, once you [`hard`](hard-data.md) it |

## Printing

Print a Table and the notes print under it. This is the house rule made
mechanical: **a number never travels without what produced it.**

=== "Python"

    ```python
    >>> import scelo as sc
    >>> sc.life_table().head(3)
    ```

=== "R"

    ```r
    > sc_life_table()[1:3, ]
    ```

```text
   age        qx        px         lx         dx            Lx            Tx         ex
0   20  0.000250  0.999750  100000.00  24.963902  99987.518049  6.591309e+06  65.913088
1   21  0.000253  0.999747   99975.04  25.325403  99962.373399  6.491321e+06  64.929422
2   22  0.000257  0.999743   99949.71  25.732197  99936.844601  6.391359e+06  63.945747
— Life table · Gompertz–Makeham (illustrative)
  basis: Gompertz–Makeham (illustrative)
  · Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6,
    c = 1.124), not a published standard table: swap in your own qx column or parameters
    before relying on the figures.
  · Radix l(20) = 100,000; table closed at age 110 (qx set to 1). Lx uses the
    uniform-deaths approximation lx − ½dx.
```

In R, long tables truncate at 60 rows when printed;
`options(scelo.print_rows = 200)` raises that.

## Getting at the pieces

=== "Python"

    ```python
    t = sc.factors(i=0.04, n=10)
    t.title          # 'Annuity & assurance factors · …'
    t.basis          # 'Gompertz–Makeham (illustrative) · i = 4 %'
    t.notes          # list of caveat strings
    t.df             # the plain pandas.DataFrame, extras stripped
    ```

=== "R"

    ```r
    t <- sc_factors(i = 0.04, n = 10)
    sc_title(t)      # "Annuity & assurance factors · …"
    sc_basis(t)      # "Gompertz–Makeham (illustrative) · i = 4 %"
    sc_notes(t)      # character vector of caveats
    sc_df(t)         # the plain data.frame, extras stripped
    sc_note(t, "reviewed 2026-08-23")   # append your own caveat
    ```

Subsetting keeps the extras: `t[t$age < 65, ]` in R (and slicing in
Python) still knows its title, basis and notes. Stripping to the plain
frame is always explicit — `t.df` / `sc_df(t)` — never accidental.

## Rendering

`t.to_markdown_report()` (Python) / `sc_markdown(t)` (R) turn one Table
into a Markdown block — title, basis line, pipe table, notes as bullets,
and the provenance stamp once it is hard. [`report`](hard-data.md#board-packs)
does the same for a whole pack.

## Results that carry more than one table

Model runs return a small result object whose printable summary **is** a
Table, with the richer pieces attached:

=== "Python"

    ```python
    m = sc.mack(sc.triangle(claims))
    m.table       # the per-origin Table (latest, cdf, ultimate, ibnr, se, cv)
    m.ibnr        # 1532963.3…
    m.se          # 346036.4…
    m.factors     # the link ratios
    m.detail      # method internals (per-origin MSE, sigmas…)
    ```

=== "R"

    ```r
    m <- sc_mack(sc_triangle(claims))
    m$table       # the per-origin Table
    m$ibnr; m$se; m$factors; m$detail
    summary(m)    # one-row summary frame
    ```

The same pattern holds for `glm` (coefficients Table plus fitted values,
covariance, deviance), `lee_carter` (forecast Table plus ax, bx, kt,
drift) and `wmtr` (year-by-year Table plus paths, outcome fractions,
drivers).

## Column names are part of the interface

The factor tables use the real actuarial glyphs — `äx`, `A¹x:10`, `10Ex` —
because that is what the quantities are called. In R, back-tick them:
``t$`äx` ``. In Python they are ordinary string labels: `t["äx"]`.
