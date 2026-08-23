# scelo for Python

```bash
pip install scelo                  # numpy + pandas only
pip install "scelo[stats]"         # + scipy, statsmodels
pip install "scelo[life]"          # + lifelib 0.14.0 / modelx 0.32.0, the pair the IDE ships
```

The package lives at
[`packages/scelo-py`](https://github.com/intelligentactuaries/scelo/tree/main/packages/scelo-py)
and runs on the CPython the IDE bundles. Everything statistical has a numpy
implementation and uses scipy / statsmodels when present (the numpy GLM is
tested to agree with statsmodels to 1e-5).

## A Table

Every table-shaped result is a `scelo.Table`: a real `pandas.DataFrame`
with `title`, `basis`, `notes` and (after `sc.hard`) `provenance`.

```python
>>> import scelo as sc
>>> sc.factors(i=0.04, n=10).head(2)
   age         äx         ax        Ax     äx:10    A¹x:10      10Ex     Ax:10
0   20  23.795024  22.795024  0.084807  8.426126  0.002196  0.673722  0.675918
1   21  23.712744  22.712744  0.087971  8.425946  0.002248  0.673677  0.675925
— Annuity & assurance factors · Gompertz–Makeham (illustrative) · i = 4 % · n = 10
  basis: Gompertz–Makeham (illustrative) · i = 4 %
  · Mortality is Scelo's ILLUSTRATIVE Gompertz–Makeham basis (A = 0.00022, B = 2.7e-6, c = 1.124), ...
  · äx = Nx/Dx (annuity-due), ax = äx − 1, Ax = Mx/Dx ...; äx:10 = (Nx − Nx+10)/Dx, ...
```

`t.df` gives the plain frame; `df.sc.<function>()` gives every function as
a method for people who chain.

## The map

```text
SOFT    sc.load("x.csv")   sc.profile(df)   sc.describe(df)   sc.tab(df, "line")
        sc.suggest(df)     sc.clean(df)     sc.clean(df, "all")   sc.combine(a, b)
LIFE    sc.life_table()  sc.commutation(i=.04)  sc.factors(i=.04, n=10)  sc.premium()
        sc.ae(df)  sc.graduate(qx)  sc.lee_carter(df)  sc.kaplan_meier(df)  sc.basicterm(mp)
RESERVE sc.triangle(df)  sc.chain_ladder(tri)  sc.mack(tri)  sc.bf(tri)  sc.bootstrap(tri)  sc.reserve("claims.csv")
FINANCE sc.discount_curve(.04)  sc.smith_wilson(t, r)  sc.pv(cf, .05)  sc.irr(cf)  sc.annuity_certain(10, .05)
RISK    sc.var(x)  sc.tvar(x)  sc.aggregate_loss("poisson", "lognormal", lam=5, mu=8, sigma=1)  sc.fit(x)
        sc.credibility(df, "group", "lr")  sc.aggregate_scr({...})
PRICING sc.glm(df, "claims ~ C(region) + age", "poisson", offset="exposure").relativities()
        sc.freq_sev(df, "region")  sc.loss_ratio(df, "line")  sc.lift(y, pred)
FAIR    sc.fairness(df, "y", "score", "group")  sc.fairness_audit(df, "score", "prot", ["age"])
CLIMATE sc.ensemble(df, "t2m")  sc.return_period(x)  sc.parametric_trigger(x)
FORECAST sc.wmtr("pension scheme, weakening covenant")  sc.sensitivity(...)
SWARM   sc.council("...")  sc.society("...")  sc.augment(df, "...")   (needs Scelo IDE or bun run dev:swarm)
HARD    sc.hard(t)  sc.report(t1, t2, to="pack.html")  sc.export(t, "out.xlsx")  sc.audit()  sc.verify(t)
```

## Command line

```bash
scelo describe claims.csv
scelo clean messy.csv --all -o clean.csv
scelo reserve claims.csv
scelo wmtr "rural village, severe drought"
scelo samples
```

## Parity with the IDE

| Python | Mirrors |
|---|---|
| `load`, `profile`, `describe` | `packages/scelo-core` typing and descriptive profile |
| `suggest`, `clean` | the cleaning banner (`apps/web/.../cleaning.ts`), 18 ops, same thresholds |
| `combine` | `combineData.ts` (append / join-left, first right match wins) |
| `life_table` … `model_points` | `actuarialTables.ts` |
| `chain_ladder`, `mack`, `bf`, `bootstrap` | the numpy reserving bridge; Mack reproduces RAA (IBNR 52,135, SE 26,909) |
| `wmtr` | `apps/swarm/src/shared/wmtr.ts`, bit-exact random stream |
| `council`, `society`, `augment` | the swarm HTTP API |
