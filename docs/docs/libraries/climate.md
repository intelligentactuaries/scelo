# Climate

The climate-risk primitives the IDE's climate tooling uses: reanalysis
ensembles, empirical and Gumbel return periods, parametric trigger
design, and average annual loss.

## Reanalysis ensembles

=== "Python"

    ```python
    cl = sc.sample("climate")            # Pretoria, Jan 2024 — ERA5 / MERRA-2 / JRA-3Q
    sc.ensemble(cl, "t2m")               # per-date mean, spread, min, max
    sc.anomaly(series, by="month")       # anomaly vs a monthly climatology
    ```

=== "R"

    ```r
    cl <- sc_sample("climate")
    sc_ensemble(cl, "t2m")
    sc_anomaly(series, by = "month")
    ```

```text
          date       mean    spread   min   max
0   2024-01-01  23.400000  0.300000  23.1  23.7
1   2024-01-02  24.700000  0.360555  24.3  25.0
...
— Ensemble · t2m · 3 members
  · Median member CV 0.016: the reanalyses agree closely on this variable.
```

Member columns are found by name (`era5`, `merra2`, `jra3q`, `ncep`,
`cfsr`, `nora`), optionally filtered by a variable prefix; pass
`members=[...]` when yours are named differently. The note grades the
agreement — *agree closely* below 5 % median member CV, *disagree
materially* above 20 % — because an ensemble that disagrees is a finding,
not a nuisance.

## Return periods and triggers

=== "Python"

    ```python
    sc.return_period(annual_losses)              # empirical + Gumbel, 2y … 500y
    sc.parametric_trigger(losses, p=0.9)         # {'trigger': …, 'cap': …, 'attachment_probability': 0.1}
    sc.aal(event_losses, frequencies=freqs)      # or aal(history, years=40)
    ```

=== "R"

    ```r
    sc_return_period(annual_losses)
    sc_parametric_trigger(losses, p = 0.9)
    sc_aal(event_losses, frequencies = freqs)
    ```

```text
   return_period  empirical     gumbel
0              2  33.510821  33.693711
2             10  48.777226  50.338781
3             25  64.774252  58.716448
4             50        NaN  64.931480
— Return periods
  basis: 40 values over 40 years
  · Empirical: Weibull plotting position (T+1)/rank with log-linear interpolation,
    blank beyond the record; Gumbel: method-of-moments fit to annual maxima.
```

The empirical column goes honestly blank beyond the length of the record
— a 40-year history cannot witness a 1-in-100 — while the Gumbel fit
extrapolates, and is only computed when the losses really are annual
maxima. `parametric_trigger` sets the attachment at the chosen
exceedance probability with a cap at a multiple of it: the IDE's
parametric design, as one function.

## Function list

`ensemble` `return_period` `parametric_trigger` `aal` `anomaly` — each
with the `sc_` twin in R.
