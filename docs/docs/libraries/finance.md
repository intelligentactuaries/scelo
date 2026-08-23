# Finance

Interest theory through yield curves: the Exam-FM toolbox as one-word
functions, then the curve builders — bootstrapped zeros, Smith–Wilson
with a UFR, Nelson–Siegel(–Svensson), and a Hull–White short-rate
simulation.

## Interest, annuities, bonds

=== "Python"

    ```python
    sc.v(0.05, 10)                       # discount factor
    sc.pv([40, 40, 40], 0.05)            # PV at a flat rate — or pass a curve
    sc.npv(0.08, [-100, 60, 60])         # first flow at t = 0
    sc.irr([-100, 60, 60])               # 0.13066…, bracketed bisection
    sc.annuity_certain(10, .05, due=True)     # ä_10; m-thly and increasing variants
    sc.accumulation(10, .05)             # s_10
    sc.duration(cf, .05, modified=True); sc.convexity(cf, .05)
    sc.bond_price(100, 0.06, 10, 0.05, m=2)   # semi-annual; nominal yield
    sc.bond_yield(104.4, 100, 0.06, 10, m=2)
    sc.nominal(0.05, 12); sc.effective(0.049, 12); sc.force(0.05)
    ```

=== "R"

    ```r
    sc_v(0.05, 10)
    sc_pv(c(40, 40, 40), 0.05)
    sc_npv(0.08, c(-100, 60, 60))
    sc_irr(c(-100, 60, 60))
    sc_annuity_certain(10, .05, due = TRUE)
    sc_accumulation(10, .05)
    sc_duration(cf, .05, modified = TRUE); sc_convexity(cf, .05)
    sc_bond_price(100, 0.06, 10, 0.05, m = 2)
    sc_bond_yield(104.4, 100, 0.06, 10, m = 2)
    sc_nominal(0.05, 12); sc_effective(0.049, 12); sc_force(0.05)
    ```

`irr` refuses politely when the NPV has the same sign at both ends of the
bracket instead of returning a fantasy root.

## Curves

A **curve** argument accepts a flat rate, a `{tenor: rate}` mapping, a
list of `(tenor, rate)` pairs, or a data frame with tenor and rate
columns (inferred by name). Rates quoted in percent (`max > 1`) are
divided by 100 automatically. Interpolation is linear between quoted
tenors and **flat beyond the last one** — the honest default, with
Smith–Wilson one call away when you want a UFR instead.

=== "Python"

    ```python
    sc.discount_curve({1: .03, 5: .04, 10: .05})
    sc.forward_rates(zeros)                  # one-period forwards
    sc.bootstrap_par([.03, .034, .037])      # zeros from par / swap rates
    sc.smith_wilson([1,2,3,5,10], [.031,.033,.035,.038,.042], ufr=.042, alpha=.1)
    sc.nelson_siegel(tenors, rates)          # λ by grid search unless given
    sc.nss(tenors, rates)                    # Svensson: four β, two λ
    sc.hull_white(r0=.04, a=.1, sigma=.01, horizon=30, seed=42)
    ```

=== "R"

    ```r
    sc_discount_curve(c(`1` = .03, `5` = .04, `10` = .05))
    sc_forward_rates(zeros)
    sc_bootstrap_par(c(.03, .034, .037))
    sc_smith_wilson(c(1,2,3,5,10), c(.031,.033,.035,.038,.042), ufr = .042, alpha = .1)
    sc_nelson_siegel(tenors, rates)
    sc_nss(tenors, rates)
    sc_hull_white(r0 = .04, a = .1, sigma = .01, horizon = 30, seed = 42)
    ```

```text
    tenor  zero rate  discount factor  1y forward
0       1   0.031000         0.969932    0.031000
...
9      10   0.042000         0.662709    0.046565
...
59     60   0.042745         0.081155    0.042033
— Smith–Wilson · UFR 4.20% · α 0.1 · to 60y
  basis: 5 zero rates · UFR 4.20% · α 0.1
  · P(t) = e^{−ωt} + Σ ζ_j W(t, u_j) with the Wilson kernel …; fits the observed
    prices exactly and converges to the UFR forward.
  · Last observed tenor 10y; convergence speed α = 0.1 (EIOPA floor 0.05).
```

- **Smith–Wilson** is the EIOPA construction: it fits the observed prices
  exactly (tested to 1e-9) and converges to the UFR forward.
  `zero_input=False` treats the inputs as annual-coupon par rates.
- **Nelson–Siegel / NSS** fit β by least squares with λ chosen by grid
  search unless you pass it; the fitted parameters ride in the table's
  attributes.
- **Hull–White** simulates `dr = (θ − a·r)dt + σ dW` monthly (seeded, so
  reproducible) and returns the mean path with a 5–95 % band and mean
  discount factors; the full path matrix is in the attributes. `theta`
  may be a vector by year.

## Function list

`v` `pv` `npv` `irr` `annuity_certain` `accumulation` `duration`
`convexity` `bond_price` `bond_yield` `zero_to_df` `df_to_zero`
`nominal` `effective` `force` `from_force` `discount_rate`
`discount_curve` `forward_rates` `bootstrap_par` `smith_wilson`
`nelson_siegel` `nss` `hull_white` — each with the `sc_` twin in R.
