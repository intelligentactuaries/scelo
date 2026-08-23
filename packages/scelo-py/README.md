# scelo for Python

**Soft data → tools → hard data, in as few lines as it takes to be right.**

`scelo` is the Scelo IDE's brain layer as a Python library: the same data
typing, the same cleaning rules, the same life tables, reserving engine and
forecast model that the desktop workbench runs, for actuaries who would
rather write three lines of code than click through a workstation.

```python
import scelo as sc

df  = sc.load("claims.csv")        # typed the way Scelo IDE types it
df  = sc.clean(df)                 # the IDE's safe cleaning ops, audited
res = sc.reserve(df)               # chain ladder, Mack, BF, ODP bootstrap
sc.report(res, to="pack.html")     # a board pack: numbers that carry their basis
```

That is a reserving exercise: triangle built from a long claims file with
the origin, development and amount columns inferred, four methods, a
standard error, a bootstrap distribution, and a report whose every table
prints its basis, its caveats and a content hash.

## Install

```bash
pip install scelo                  # numpy + pandas only
pip install "scelo[stats]"         # + scipy, statsmodels (GLMs via statsmodels, scipy fits)
pip install "scelo[life]"          # + lifelib 0.14.0 / modelx 0.32.0, the pair Scelo IDE ships
pip install "scelo[all]"
```

The core depends on numpy and pandas alone and runs on the CPython that
Scelo IDE bundles. Everything statistical has a numpy implementation and
uses scipy / statsmodels when they are there (the numpy GLM is tested to
agree with statsmodels to 1e-5).

## The idea

Stata gets one thing right: `describe`, `tab`, `regress` are whole analyses
in a word. pandas gets another: the frame is the lingua franca. scelo is
both. Every function takes a DataFrame first, infers the columns it needs
from their names (`accident_year`, `AY`, `origin` all mean origin), and
returns a **Table**: a real `pandas.DataFrame` that also carries

- `title`: what it is,
- `basis`: one line of provenance (`Gompertz–Makeham (illustrative) · i = 4 %`),
- `notes`: the things an actuary should know before trusting it,
- `provenance`: a content hash, timestamp and audit trail once you `sc.hard()` it.

Print a Table and the notes print under it. Slice it, merge it, plot it:
it is still pandas. `t.df` gives the plain frame back.

```python
>>> sc.life_table().head(3)
   age        qx        px         lx         dx            Lx            Tx         ex
0   20  0.000250  0.999750  100000.00  24.963902  99987.518049  6.591309e+06  65.913088
1   21  0.000253  0.999747   99975.04  25.325403  99962.373399  6.491321e+06  64.929422
2   22  0.000257  0.999743   99949.71  25.732197  99936.844601  6.391359e+06  63.945747
— Life table · Gompertz–Makeham (illustrative)
  basis: Gompertz–Makeham (illustrative)
  · Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124),
    not a published standard table: swap in your own qx column or parameters before relying on the figures.
  · Radix l(20) = 100,000; table closed at age 110 (qx set to 1). Lx uses the uniform-deaths approximation lx − ½dx.
```

## Sixty-second tour

```python
import scelo as sc

# ── soft data ────────────────────────────────────────────────────────────
df = sc.sample("dirty")            # the IDE's messy-intake demo (or sc.load("file.csv"))
sc.profile(df)                     # type, missing, unique, five-number summary, fences, top values
sc.describe(df)                    # Bessel sd, type-7 quantiles, G1/G2 shape, Jarque–Bera, ranked by CV
sc.tab(df, "Region")               # Stata's tab
sc.suggest(df)                     # the cleaning plan with evidence: 12 ops, 7 safe
clean = sc.clean(df)               # the 9 safe ops (trim, mojibake, missing markers, numbers, dates, booleans, sentinels …)
clean = sc.clean(df, "all")        # + dedupe, drop empty/constant, impute, cap outliers, snake_case: until clean
sc.combine(a, b)                   # append or join-left, decided from the schemas and keys, with the evidence

# ── life ─────────────────────────────────────────────────────────────────
sc.life_table(qx_df)               # age, qx, px, lx, dx, Lx, Tx, ex from any basis (qx / lx / deaths+exposure / Makeham)
sc.commutation(i=0.04)             # Dx Nx Cx Mx Rx Sx
sc.factors(i=0.04, n=10)           # äx ax Ax äx:n A¹x:n nEx Ax:n
sc.premium(i=0.04, product="term") # net premium per 1,000 SA, age × term grid
sc.ae(experience_df)               # actual vs expected by age band against a basis
sc.graduate(crude_qx, h=100)       # Whittaker–Henderson
sc.lee_carter(rates_df)            # SVD fit + random-walk-with-drift forecast, 95 % interval
sc.kaplan_meier(df)                # S(t), Greenwood SE, log-log bounds
sc.basicterm(model_points)         # lifelib BasicTerm_ME monthly projection, pure numpy
sc.scr_life(model_points)          # Solvency II life SCR: standard-formula shocks on that projection
sc.csm(model_points, ra=0.05)      # IFRS 17 general-model CSM and its coverage-unit roll-forward
sc.lifelib_run("basiclife", "BasicTerm_ME", model_points)   # the real lifelib model (pip install "scelo[life]")

# ── reserving ────────────────────────────────────────────────────────────
tri = sc.triangle(claims)          # origin × development, cumulative, from a long file
sc.chain_ladder(tri); sc.mack(tri); sc.bf(tri); sc.cape_cod(tri, premium); sc.bootstrap(tri, n=1000)
sc.reserve(claims)                 # all of the above in one table

# ── finance & risk ──────────────────────────────────────────────────────
sc.discount_curve({1: .03, 5: .04, 10: .05}); sc.smith_wilson(tenors, rates, ufr=.042)
sc.pv(cf, .05); sc.irr(cf); sc.annuity_certain(10, .05, due=True); sc.duration(cf, .05)
sc.aggregate_loss("poisson", "lognormal", lam=5, mu=8, sigma=1)   # Panjer / FFT / Monte Carlo
sc.fit(losses); sc.var(x, .995); sc.tvar(x, .995)
sc.credibility(df, "group", "loss_ratio"); sc.aggregate_scr({"mortality": 100, "lapse": 200})

# ── pricing & fairness ──────────────────────────────────────────────────
m = sc.glm(df, "claims ~ C(region) + age", "poisson", offset="exposure")   # base="first" for R / statsmodels reference levels
m.relativities(); m.predict(new); sc.lift(y, m.fitted)
sc.fairness(df, "y", "score", "group"); sc.fairness_audit(df, "score", "protected", ["age"])

# ── forecast & swarm ────────────────────────────────────────────────────
sc.wmtr("pension scheme with a weakening sponsor covenant")   # W(M,T,R) Monte Carlo, same numbers as the IDE
sc.council("…scenario…", subset=32)                            # convene the professional council (needs the swarm)
sc.society("…scenario…", size=200)                             # simulate a population's response

# ── hard data ───────────────────────────────────────────────────────────
t = sc.hard(sc.mack(tri).table, assumptions={"tail": 1.0})
sc.report(t, sc.life_table(), to="pack.html")                  # board pack with notes, hashes, audit trail
sc.audit()                                                     # everything the tools layer did this session
```

`sc.cheatsheet()` prints the one-screen version. `df.sc.clean()`,
`df.sc.triangle().sc.mack()` give you the same functions as methods.

## What comes from where

| Area | Source of truth inside Scelo | Notes |
|---|---|---|
| Import typing, profiling, descriptive stats | `packages/scelo-core` | type-7 quantiles, Bessel sd, G1/G2, Jarque–Bera, CV ranking: identical |
| Cleaning (18 ops, thresholds, pass loop) | `apps/web/.../cleaning.ts` | same token sets, regexes and thresholds; `suggest()` is the banner |
| Combine (append / join-left, key detection) | `apps/web/.../combineData.ts` | first right match wins, `_2` renames |
| Life tables, commutation, factors, premiums, A/E, model points | `packages/scelo-core/actuarialTables.ts` | the chat's "build a life table at 4 %" |
| Chain ladder, Mack, BF, ODP bootstrap | `apps/web/.../bridges/chainladderPython.ts` | Mack reproduces the published RAA figures (IBNR 52,135; SE 26,909) |
| BasicTerm projection | `apps/web/.../lifelibBasicTerm.ts` | Scelo's illustrative assumptions; `lifelib_run` for the real thing |
| WMTR forecast | `apps/swarm/src/shared/wmtr.ts` | bit-exact RNG; tables agree to 1e-14 |
| Workspace bottleneck / active subspace | `apps/web/.../bridges/bottleneckPython.ts` | |
| Swarm client | `apps/swarm/src/server/index.ts` | council, society, augment, interventions, justifications |

## Lines of code

The same reserving study, three ways:

| | lines |
|---|---|
| pandas + numpy from scratch (triangle, factors, Mack MSE, ODP bootstrap) | ≈ 120 |
| `chainladder` | ≈ 12 |
| **scelo** `sc.reserve("claims.csv")` | **1** |

and the caveats, the basis line and the hash come with it.

## The swarm

Scelo IDE bundles the swarm (a Bun server on `127.0.0.1:3010`): a stratified
council of 8 professions × 16 MBTI types × 2 genders that deliberates over
a scenario with the WMTR evidence injected, and a society simulator.
`sc.council`, `sc.society`, `sc.augment`, `sc.intervene` and `sc.justify`
talk to it with the standard library only; `sc.connect(url)` points
elsewhere. The WMTR engine itself is ported, so `sc.wmtr` needs no server.

## Testing

```bash
pip install "scelo[dev]" && pytest
```

The suite checks the IDE's own golden values (actuarial-table identities,
the hand-computed descriptive statistics, the reserving fixture), the
published RAA results, a TypeScript-generated WMTR fixture, numpy-vs-
statsmodels GLM parity for five families, and every cleaning rule.

## License

Scelo IDE Source-Available License v1.1 (`LicenseRef-Scelo-IDE-1.1`), the
same license as the IDE: free to use, including commercially; a 3 %
royalty on a Licensed Product's gross revenue above ZAR 1,000,000
lifetime. See `LICENSE`.

Intelligent Actuaries (Pty) Ltd · scelo@intelligentactuaries.com
