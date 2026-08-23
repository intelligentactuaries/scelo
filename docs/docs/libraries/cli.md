# The command line

Installing the Python package also installs `scelo`, a small command line
for the times a terminal is closer than a notebook: profile a file someone
just sent you, clean it, run the reserving battery, print a life table.
Twelve subcommands, each a thin wrapper over the library function of the
same name — same inference, same output, same notes.

```text
$ scelo --help
usage: scelo [-h]
             {profile,describe,suggest,quick,clean,reserve,life,wmtr,samples,sample,cheatsheet,version} ...

Scelo for the terminal: soft data → tools → hard data.
```

## Looking at a file

```bash
scelo profile  claims.csv     # type, missing, unique, five-number summary, fences, top values
scelo describe claims.csv     # the statistician's view: sd, quantiles, shape, ranked by CV
scelo suggest  claims.csv     # the cleaning plan, with evidence and safe flags
scelo quick    claims.csv     # profile + the plan in one go — the first thing to run on a new file
```

## Cleaning

```bash
scelo clean claims.csv                     # safe ops only, prints what changed
scelo clean claims.csv --all -o clean.csv  # every op, written to a new file
```

The input file is never modified: cleaned output goes to stdout as a
summary, and to disk only where `-o/--out` says.

## Models

```bash
scelo reserve claims.csv                             # chain ladder · Mack · BF · ODP bootstrap
scelo reserve claims.csv --origin uw_year --value paid   # when inference needs overriding
scelo life                                           # the illustrative life table
scelo life --i 0.04                                  # commutation functions at 4 %
scelo life mortality.csv                             # a life table from your own age + qx file
scelo wmtr "pension scheme with a weakening sponsor covenant" --paths 500
```

`reserve` prints the same four-method summary the library's
[`reserve()`](reserving.md) returns, notes included:

```text
$ scelo reserve claims.csv
                         latest      ultimate          ibnr ...
chain-ladder          1874437.0  3.407400e+06  1.532963e+06 ...
mack                  1874437.0  3.407400e+06  1.532963e+06 ...
bornhuetter-ferguson  1874437.0  3.407400e+06  1.532963e+06 ...
bootstrap             1874437.0  3.448399e+06  1.573962e+06 ...
— Reserve summary
  basis: paid · origin_year × dev
  · Triangle: 7 origins × 7 lags. Mack SE ±1.96 → [854,731, 2,211,194]; bootstrap p95 2,316,627.
```

## Samples and the map

```bash
scelo samples                 # list the six bundled datasets
scelo sample dirty -o dirty.csv   # write one out to practise on
scelo cheatsheet              # the whole library on one screen
scelo version
```

The bundled samples (the same ones `sc.sample()` /
`sc_sample()` return in code):

| Key | What it is |
|---|---|
| `claims` | 79-row incomplete P&C claims triangle, origins 2018–2024, with policy, line, province, age, sex, paid, incurred, settled |
| `dirty` | 53-row customer ledger with every real-world mess: currency strings, %-numbers, sentinel ages, mixed booleans and dates, mojibake, missing markers, duplicates |
| `climate` | 30 daily records for one grid cell (Pretoria, Jan 2024): 2-m temperature and precipitation under ERA5 / MERRA-2 / JRA-3Q |
| `wmtr-scenarios` | 12 scenario rows for the W(M, T, R) forecast: alphas, relational weights, shock, horizon |
| `lifelib-mp` | 100-row in-force term model-point file shaped like lifelib's `basic_term_sample` |
| `workspace-demo` | 2,000-policy synthetic annuity book: three low-variance real drivers through nonlinear channels, ten nuisance columns |

!!! note "R users"
    The command line ships with the Python package only. From R, the same
    one-liners are `sc_profile(sc_load("claims.csv"))` and friends — every
    subcommand has an `sc_` twin.
