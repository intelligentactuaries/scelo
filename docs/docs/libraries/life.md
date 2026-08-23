# Life & mortality

The IDE's actuarial tables as functions — the same code path as the
chat's "build a life table at 4 %" — plus experience analysis, graduation,
projection models, and a base-R / pure-numpy port of lifelib's
BasicTerm_ME with Solvency II and IFRS 17 readings on top.

!!! note "The illustrative basis"
    With no basis given, everything below runs on Scelo's **illustrative
    Gompertz–Makeham** (A = 0.00022, B = 2.7e-6, c = 1.124), ages 20–110 —
    and says so in its notes, every time. It is not a published standard
    table. Swap in your own `qx` before relying on the figures; the note
    disappears when you do.

## Any basis in, one table out

Every table generator takes a **basis** first: nothing (illustrative
Makeham), a Makeham/Gompertz parameter set, a data frame with `age + qx`,
`age + lx`, or `age + deaths + exposure`, or a qx vector by age. Percent-
shaped rates (`max > 1`) are divided by 100 with a note; gaps are
interpolated linearly with a note; crude `deaths ÷ exposure` rates carry a
"graduate before using" note.

=== "Python"

    ```python
    sc.life_table()                       # age qx px lx dx Lx Tx ex — 91 rows, ages 20–110
    sc.life_table(my_qx_df)               # your basis, same columns
    sc.commutation(i=0.04)                # age lx dx v^x Dx Nx Cx Mx Rx Sx
    sc.factors(i=0.04, n=10)              # äx ax Ax äx:10 A¹x:10 10Ex Ax:10
    sc.annuity(65, i=0.04)                # ä65 as one number     (n=, due= for temporaries)
    sc.assurance(40, i=0.04, n=20)        # A¹40:20
    sc.premium(i=0.04, product="term")    # net premium per 1,000 SA, age × term grid
    sc.epv([100]*10, 65, i=0.04)          # EPV of any cashflow vector against the basis
    ```

=== "R"

    ```r
    sc_life_table()
    sc_life_table(my_qx_df)
    sc_commutation(i = 0.04)
    sc_factors(i = 0.04, n = 10)
    sc_annuity(65, i = 0.04)
    sc_assurance(40, i = 0.04, n = 20)
    sc_premium(i = 0.04, product = "term")
    sc_epv(rep(100, 10), 65, i = 0.04)
    ```

```text
    age         äx         ax        Ax     äx:10    A¹x:10      10Ex     Ax:10
0    20  23.795024  22.795024  0.084807  8.426126  0.002196  0.673722  0.675918
1    21  23.712744  22.712744  0.087971  8.425946  0.002248  0.673677  0.675925
— Annuity & assurance factors · Gompertz–Makeham (illustrative) · i = 4 % · n = 10
  basis: Gompertz–Makeham (illustrative) · i = 4 %
  · äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx …; äx:10 = (Nx − Nx+10)/Dx, …
```

The identities hold to machine precision and are asserted by the tests:
`Ax = 1 − d·äx`, `Ax:n = A¹x:n + nEx`, `N₀ = ΣD`, `M₀ = ΣC`. `premium` is
the pure equivalence-principle risk premium `P = 1000·A/ä` — no expense
loading, no profit margin, and the note says so. Column names use the
real actuarial glyphs (`äx`, `A¹x:10`); in R, back-tick them.

Small conversions ride along: `mx_to_qx` / `qx_to_mx` (uniform or
constant-force), `survival`, `life_expectancy` (curtate or complete),
`close_table`, `nominal` / `effective` / `force` / `from_force`.

## Experience

=== "Python"

    ```python
    sc.ae(experience_df)                 # actual vs expected by age band, + total row
    sc.ae_test(actual=112, expected=98)  # Poisson z-test on one cell
    sc.exposure(df, "start", "end", event="died")   # central exposure, split at birthdays
    sc.graduate(crude_qx, h=100)         # Whittaker–Henderson, on log qx by default
    sc.experience("experience.csv")      # the one-liner: A/E + graduation + life table
    ```

=== "R"

    ```r
    sc_ae(experience_df)
    sc_ae_test(actual = 112, expected = 98)
    sc_exposure(df, "start", "end", event = "died")
    sc_graduate(crude_qx, h = 100)
    sc_experience("experience.csv")
    ```

`ae` defaults the expected basis to the illustrative Makeham over the
observed ages; `by=` splits the study. `graduate` minimises
`Σw(g−u)² + h·Σ(Δ²g)²` with weights defaulting to exposure — check the
residual signs before adopting, as the notes remind you. `exposure`
computes policy-year central exposure age last birthday, deaths allocated
to the age at exit.

## Projection models

=== "Python"

    ```python
    lc = sc.lee_carter(rates_df, horizon=10)     # SVD fit + RWD forecast, 95 % band
    lc.forecast; lc.ax; lc.bx; lc.kt; lc.drift
    sc.kaplan_meier(df)                          # S(t), Greenwood SE, log-log bounds
    ```

=== "R"

    ```r
    lc <- sc_lee_carter(rates_df, horizon = 10)
    lc$forecast; lc$ax; lc$bx; lc$kt; lc$drift
    sc_kaplan_meier(df)
    ```

Lee–Carter uses the standard constraints (Σbₓ = 1, Σkₜ = 0) and a
random-walk-with-drift forecast; the print header reports the drift and
how much the first SVD component explains. Kaplan–Meier codes an event
from `1 / true / yes / dead / claim / lapsed` and puts its 95 % bounds on
the log(−log S) scale.

## BasicTerm, SCR and CSM

A port of lifelib's `BasicTerm_ME` semantics that needs no Python-in-R
and no lifelib — monthly projection, then Solvency II and IFRS 17 read
off it. Feed it a model-point file (`sc.sample("lifelib-mp")` is shaped
right); `model_points(df)` builds one from a seriatim book.

=== "Python"

    ```python
    mp  = sc.sample("lifelib-mp")
    bt  = sc.basicterm(mp)               # month-by-month premiums, claims, expenses, PV
    scr = sc.scr_life(mp)                # standard-formula shocks on that projection
    ifrs = sc.csm(mp, ra=0.05)           # GMM CSM and its coverage-unit roll-forward
    ```

=== "R"

    ```r
    mp   <- sc_sample("lifelib-mp")
    bt   <- sc_basicterm(mp)
    scr  <- sc_scr_life(mp)
    ifrs <- sc_csm(mp, ra = 0.05)
    ```

```text
                        charge       marginal     share
mortality        284602.417576  127373.887500  0.185206
lapse            584291.612329  518226.535282  0.753520
expense            9965.340683    5708.561200  0.008300
cat               82820.304745   36432.377775  0.052974
SCR              687741.361757            NaN       NaN
diversification -273938.313576            NaN       NaN
— Solvency II life SCR · 100 model points · BasicTerm projection
  · SCR_life = 687,741 (undiversified 961,680); BEL … Lapse charge is the worst of
    up / down / mass: down (584,292).
```

- `basicterm` takes an assumptions set with fifteen dials (mortality
  A/B/c, lapse, expenses, discount rate, loading, plus the shock dials);
  override any subset. Its notes say plainly: *illustrative assumptions,
  not a priced basis*.
- `scr_life` recomputes the projection under each Delegated-Regulation
  shock (+15 % mortality, −20 % longevity, lapse up / down / mass, +10 %
  expenses + 1 % inflation, 0.15 % cat), floors each ΔBEL at zero, takes
  the worst lapse, and aggregates with the SII life correlation matrix
  (`SII_LIFE_CORR` / `SC_SII_LIFE_CORR`, exported). Disability and
  revision are zero for term business.
- `csm` sets `CSM₀ = max(−FCF, 0)`; a positive FCF is reported as the
  loss component (the bundled sample is deliberately under-priced, so it
  shows one). Release follows coverage units discounted at the locked-in
  rate.

## The real lifelib

When you want lifelib itself rather than the port:

=== "Python"

    ```python
    # pip install "scelo[life]"   — pins lifelib 0.14.0 / modelx 0.32.0, the IDE's pair
    sc.lifelib_models()                        # the 16 libraries and their status
    t = sc.lifelib_run("basiclife", "BasicTerm_ME", mp)
    t.attrs["pv"]                              # per-policy present values
    ```

=== "R"

    ```r
    # install.packages("reticulate"); pip install "scelo[life]" in its Python
    sc_lifelib_models()
    t <- sc_lifelib_run("basiclife", "BasicTerm_ME", mp)
    ```

`normalise_model_points(df)` maps any reasonably named file onto the
lifelib shape first (and is what `lifelib_run` uses). The library copy
lives under `~/.cache/scelo/lifelib/0.14.0` (or `$SCELO_LIFELIB_HOME`);
a different installed lifelib version warns rather than stops.

## Function list

`makeham` `gompertz` `qx` `life_table` `commutation` `factors` `annuity`
`assurance` `premium` `epv` `ae` `ae_test` `exposure` `graduate`
`lee_carter` `kaplan_meier` `model_points` `survival` `life_expectancy`
`close_table` `mx_to_qx` `qx_to_mx` `basicterm` `scr_life` `csm`
`lifelib_models` `lifelib_run` `lifelib_provenance` `lifelib_home`
`normalise_model_points` `experience` — each with the `sc_` twin in R.
