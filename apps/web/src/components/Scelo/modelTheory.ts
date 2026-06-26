// Per-model "theoretical foundations" snippets for the expanded detail
// modal on /scelo/hard. Each entry is a short markdown blurb covering:
//   • the model's intent + when to reach for it
//   • the assumptions it relies on (so the user sees when it would BREAK)
//   • the canonical formula in plain notation
//   • a one-line caveat
//
// These are intentionally brief. They orient the user; the dashboard's
// chatbot is the place to dig deeper into any one of them. Keep prose
// tight — every line gets rendered into a small column inside the modal.

export const MODEL_THEORY: Record<string, string> = {
  "chain-ladder": `
**Chain Ladder** projects an incomplete triangle of cumulative paid (or incurred) losses to ultimate by multiplying the latest diagonal forward with age-to-age (ATA) factors estimated from prior development.

**Assumptions**
- Successive development factors are independent of one another.
- Development factors are independent of accident year (no calendar-year shifts).
- Variance of the next-period cumulative loss scales linearly with the current cumulative (the heteroskedasticity Mack later formalises).

**Formula**
Per development period \`k\`, the weighted-mean factor is
$$
f_k = \\frac{\\sum_o C_{o,k+1}}{\\sum_o C_{o,k}}
$$
and the cumulative development factor from period \`k\` to ultimate is the product
$$
\\text{CDF}_k = \\prod_{j \\geq k} f_j.
$$

**Caveat** — silent if any of the three assumptions fail. Pair with Mack for variance, with Bornhuetter-Ferguson for sparse early years.
`.trim(),

  mack: `
**Mack Chain Ladder** keeps the chain-ladder point estimate but adds a closed-form formula for the reserve standard error. It's the workhorse "I want chain ladder, but with uncertainty" model.

**Assumptions**
Identical to chain-ladder, plus an explicit variance structure:
$$
\\operatorname{Var}(C_{o,k+1} \\mid C_{o,k}) = \\sigma_k^2 \\, C_{o,k}.
$$

**Formula**
The reserve standard error per origin and total comes from
$$
\\hat{\\sigma}_k^2 = \\frac{1}{n-k-1} \\sum_{o} C_{o,k} \\left( \\frac{C_{o,k+1}}{C_{o,k}} - f_k \\right)^2
$$
plugged into Mack's recursion. The reported CV is \`SE / IBNR\`.

**Caveat** — like chain-ladder, blind to changes in claim handling, inflation regime, or calendar-year shocks. Look at the residuals plot for any obvious diagonal effects.
`.trim(),

  "bornhuetter-ferguson": `
**Bornhuetter–Ferguson** blends the chain-ladder pattern with an *a priori* expected loss ratio (ELR). It's the right pick when the most recent origins are too thin for chain-ladder to be stable: BF uses the prior to anchor what we don't yet see.

**Formula**
Per origin \`o\` with paid-to-date \`P_o\` and CDF \`CDF_o\`,
$$
\\text{Ultimate}_o = P_o + \\text{Premium}_o \\cdot \\text{ELR} \\cdot \\left(1 - \\frac{1}{\\text{CDF}_o}\\right).
$$
The reserve is the second term — what the prior says *should* still emerge.

**Assumptions**
- The prior ELR is reasonably calibrated (often via a benchmark or a peer book).
- The development pattern is borrowed from chain-ladder and assumed transferable.

**Caveat** — sensitivity to the ELR is steep on green origins. Stress-test ±10 % ELR and report the range.
`.trim(),

  "bootstrap-ibnr": `
**Bootstrap IBNR** resamples the residuals of a chain-ladder fit, refits the triangle on each pseudo-sample, and accumulates the resulting reserve distribution. Gives a full predictive distribution, not just a CV.

**Method**
1. Fit chain-ladder to the original triangle; compute Pearson residuals $r_{o,k}$.
2. For each iteration, sample residuals with replacement; reconstruct a pseudo-triangle by inverting the residual definition.
3. Refit chain-ladder on the pseudo-triangle; record the projected IBNR.
4. Repeat \`N\` times (typically 5 000 – 10 000). Report percentiles.

**Outputs**
Per-percentile reserves — \`p5\`, \`p50\`, \`p95\` are the actuarial defaults; the median is the "central" estimate, the gap between \`p5\` and \`p95\` quantifies parameter+process risk.

**Caveat** — bootstrap inherits chain-ladder's assumptions; it doesn't fix them, it just measures how unstable the fit is around them. If the assumptions are wildly wrong, your distribution is wildly wrong too.
`.trim(),

  "lee-carter": `
**Lee–Carter** decomposes log-mortality into an age pattern $a_x$, a time index $k_t$, and the sensitivity of each age to that index $b_x$:
$$
\\log m_{x,t} = a_x + b_x k_t + \\varepsilon_{x,t}.
$$

The time index is then projected forward (usually as a random walk with drift) and back-substituted to project mortality rates.

**Assumptions**
- A single common time pattern drives mortality change across ages.
- Improvements are smooth — no structural breaks (pandemics, policy shocks) baked in.

**Caveat** — Lee-Carter under-predicts old-age improvements observed in many developed countries since ~1990. Pair with CBD for high-age work.
`.trim(),

  cbd: `
**Cairns–Blake–Dowd (CBD)** is a two-factor old-age mortality model. Instead of one time index, it uses two — one for level, one for slope of the age curve over time — fit by logistic regression of one-year mortality probabilities.

**Formula**
$$
\\operatorname{logit} q_{x,t} = \\kappa_t^{(1)} + (x - \\bar{x}) \\, \\kappa_t^{(2)}.
$$

**When to use** — pension and annuity work where the >65 cohort dominates. CBD captures the steepening of mortality curves over time more honestly than Lee-Carter.

**Caveat** — Two factors is more flexibility, but also more variance. Stress-test extrapolations of $\\kappa^{(1)}$ and $\\kappa^{(2)}$ jointly.
`.trim(),

  lifecontingencies: `
**Life contingencies** turns a mortality table into actuarial present values — annuities, life insurance, endowments. Pure mechanics on top of \${}_kp_x\$ (the probability a life age \`x\` survives \`k\` years).

**Annuity-due** with interest \`i\`:
$$
\\ddot{a}_x = \\sum_{k=0}^{\\infty} v^k \\, {}_kp_x, \\qquad v = (1+i)^{-1}.
$$

**Term insurance**: $A_{x:\\overline{n}|} = \\sum_{k=0}^{n-1} v^{k+1} \\, {}_kp_x \\, q_{x+k}.$

**Caveat** — the mortality table you plug in IS the answer. Use a basis that matches the population (annuitant vs assured, sex-distinct vs unisex, generational vs static).
`.trim(),

  "glm-frequency": `
**GLM · Frequency** models claim counts per exposure unit using a Poisson (or negative-binomial) GLM with a log link:
$$
\\log(\\mathbb{E}[N_i]) = \\log(e_i) + \\beta_0 + \\sum_j \\beta_j x_{ij}.
$$

The $\\log(e_i)$ offset turns the model into a rate model — coefficients are interpretable as relativities on a base.

**Assumptions**
- Mean equals variance (Poisson) — relax to NB if overdispersion exists.
- Linear log-mean structure — pair with splines or interactions for non-linearity.

**Caveat** — coefficient significance is necessary but not sufficient: profile lift charts (Gini, double-lift) tell you whether the model actually segments risk.
`.trim(),

  "glm-severity": `
**GLM · Severity** models the average size of a claim given that a claim happened, typically with a Gamma family + log link:
$$
\\log(\\mathbb{E}[S_i \\mid N_i > 0]) = \\beta_0 + \\sum_j \\beta_j x_{ij}.
$$

Pair with a frequency model and $\\mathbb{E}[\\text{Loss}] = \\mathbb{E}[N] \\cdot \\mathbb{E}[S]$ (Tweedie compound Poisson is the joint alternative).

**Caveat** — large losses dominate the fit. Cap or model the tail separately (Pareto / GPD).
`.trim(),

  gbm: `
**Gradient Boosting Machine (XGBoost / LightGBM)** is a non-parametric alternative to GLMs for both frequency and severity. Sequentially fits decision trees to the residuals of the previous fit, regularised.

**Strengths** — captures interactions automatically; handles missing values; tolerates skewed features.

**Caveat** — black-box by default. Use SHAP for per-prediction attribution, partial dependence for global interpretation, and out-of-time validation to avoid overfitting the training period.
`.trim(),

  "shap-explainability": `
**SHAP (SHapley Additive exPlanations)** decomposes any model's prediction into an additive sum of feature contributions, with theoretical guarantees from cooperative game theory.

**Why it matters** — for black-box models (GBM, neural nets), SHAP is how you say "this customer's premium is high because age and zip-code each added X to the base rate".

**Outputs** — local: per-row force plot. Global: feature importance + summary swarm.
`.trim(),

  climada: `
**CLIMADA** is a probabilistic natural-catastrophe modelling framework. Couples hazard event sets (historical + stochastic) with exposure (asset locations + values) and vulnerability curves to produce loss exceedance curves.

**Pipeline**

$$
\\text{reanalysis} \\;\\to\\; \\text{hazard intensity grid} \\;\\to\\; \\text{exposure overlay} \\;\\to\\; \\text{vulnerability} \\;\\to\\; \\text{event loss} \\;\\to\\; \\text{EP curve}
$$

**Reanalysis inputs (see the Climate data lineage panel below)**

The hazard intensity grid for TC / floods / heatwaves is built from gridded reanalyses:

- **ERA5** (ECMWF, 0.25°, hourly, 1940→) — primary source. Wind / MSLP / precipitation drive hazard intensity.
- **ERA5-Land** (0.1°) — when the peril is land-surface dominant (drought, soil moisture, wildfire fuel).
- **MERRA-2** (NASA, 0.5° × 0.625°, 1980→) — independent cross-check.
- **JRA-3Q** (JMA, 0.375°, 1947→) — third leg of the ensemble for uncertainty bounds.

**Outputs** — average annual loss (AAL), PML / OEP at various return periods (50y, 100y, 250y, 500y).

**Three-reanalysis ensemble for uncertainty**

Compute the AAL / PML separately under each reanalysis. The pairwise spread is a defensible proxy for **irreducible reanalysis error** when no ground-truth station record exists for the catchment. Report mean ± range, not just the ERA5 point estimate.

**Caveats**

- Vulnerability is the biggest single source of model error — calibrate against historical claims where possible.
- ERA5 pre-1979 (before HadISST satellite assimilation) is less reliable; cap event-set lookbacks accordingly.
- Convective precipitation in the tropics is under-parameterised in all three reanalyses — heavy-rain return periods will be biased low; consider radar-based downscaling for the lower tail.
`.trim(),

  "parametric-climate": `
**Parametric** policies trigger on an observed weather index (rainfall, temperature, hurricane wind speed) rather than indemnifying actual loss. Pricing reduces to: simulate the index → compute payout distribution → discount.

**Trigger calibration on reanalysis**

The index is computed against a *fixed, public, replicable* reanalysis cell. ERA5 is the de facto market standard because the licence (CC-BY-4.0), update cadence (monthly), and global coverage make it suitable for cross-border policies. The two-step recipe:

1. **Historical calibration** — pull 30–60 years of the chosen variable from ERA5 for the policy cell. Fit the trigger threshold against an empirical return period (e.g. 1-in-10-year heatwave = 0.99-quantile of consecutive-day-above-32°C count).
2. **Independent verification** — recompute the same index from MERRA-2 and JRA-3Q. If the three return-period estimates diverge by more than ~15–20 %, the cell is in a region of high reanalysis disagreement and the basis risk is materially larger than the model implies.

**Typical indices**

| Peril | Variable | Index |
|---|---|---|
| Heatwave | ERA5-Land t2m | consecutive days above threshold |
| Drought | ERA5-Land tp + soil_moisture | SPI-3 / SPI-6 |
| TC | ERA5 wind / MSLP | max-sustained-wind in cell, or storm-track-distance |
| Pluvial flood | ERA5 tp | 24h or 72h rainfall sum |

**Strength** — fast settlement, no claims handling.

**Caveats**

- **Basis risk** — the trigger may not match actual loss for some events. Quantify with historical scatter (payout vs ground-truth loss) AND with the cross-reanalysis spread on the trigger value itself.
- **Resolution mismatch** — for sub-grid features (urban heat islands, small catchments), ERA5-Land's 0.1° is the floor; MERRA-2 and JRA-3Q are too coarse for property-level triggers.
- **Reproducibility** — publish the exact cell coordinates, variable name, and reanalysis version (ERA5 or ERA5T) in the policy wording so claims auditors can recompute.
`.trim(),

  "scr-standard": `
**SCR Standard Formula** is the Solvency II prescribed calculation: capital charges per risk module (market, life, non-life, health, default, op), aggregated via a correlation matrix.

**Formula**
$$
\\text{SCR} = \\sqrt{\\sum_{i,j} \\rho_{ij} \\, \\text{Mod}_i \\, \\text{Mod}_j} + \\text{SCR}_{\\text{op}} + \\text{Adj}.
$$

**Caveat** — diversification benefit depends entirely on the prescribed $\\rho_{ij}$; not necessarily reflective of the actual portfolio. Internal models exist for this reason.
`.trim(),

  esg: `
**Economic Scenario Generator** simulates joint paths of interest rates, equity, FX, inflation, and credit spreads. Outputs feed into market-consistent embedded value (MCEV), VaR, and risk-neutral pricing.

**Typical components**
- Short rate: Hull-White or G2++
- Equity: regime-switching or stochastic vol (Heston / SABR)
- Credit: Gaussian copula on spread dynamics

**Caveat** — calibration cliff: small changes in the implied vol surface fit can flip risk numbers materially. Always report the calibration date + market basket.
`.trim(),

  "db-dc-valuation": `
**DB / DC Pension Valuation** projects future benefit payments and discounts them at an appropriate rate (AA-corporate for IFRS / IAS 19; risk-free for solvency).

**Mechanics**
- Active members: accrual + future service + salary projection.
- Deferred: revaluation in deferment + at-retirement annuity factor.
- Retirees: longevity × inflation-linked income stream.

**Caveat** — long-tail liability sensitivity to discount rate is steep; a 50bp move can be 8–15 % of liability for typical DB plans.
`.trim(),

  // ── lifelib-rooted life family ─────────────────────────────────────────
  // Each blurb names the canonical lifelib library so the reader can pivot
  // from the Scelo result to the Python source on github.com/lifelib-dev.

  "basicterm-projection": `
**BasicTerm · monthly projection** is a faithful port of [lifelib's basiclife / BasicTerm_M](https://github.com/lifelib-dev/lifelib) to TypeScript. It walks a model-point file forward month-by-month, decrementing each policy by mortality and lapse, and accumulating premium income, claim outflow, expenses, and reserves into a present value of net cash flow.

**Mechanics**
- Policies-in-force \`pols_if(t)\` decremented by mortality \`q_m\` (annual Makeham → monthly via \`1 - (1-q_x)^(1/12)\`) and a constant lapse \`λ_m = 1 - (1-λ)^(1/12)\`.
- Claims \`claims(t) = pols_death(t) · sum_assured\`.
- Cash flow \`net_cf(t) = premiums - claims - expenses\` discounted at the assumed rate.

**Formula**
$$
\\text{PV}(\\text{net CF}) = \\sum_{t=0}^{T} \\big(\\text{premiums}_t - \\text{claims}_t - \\text{expenses}_t\\big) \\cdot v^{t/12}
$$

**Caveat** — the in-browser port samples to 2000 MPs for sub-100ms response; download the full lifelib notebook (Hard Data → "Export · lifelib notebook") for runs on 100k+ MPs.
`.trim(),

  "cashvalue-savings": `
**CashValue · savings projection** maps to [lifelib's savings / CashValue_ME](https://github.com/lifelib-dev/lifelib) — universal-life / savings products where the account value rolls forward with crediting, charges, lapse, and surrender.

**Mechanics**
- Account value \`AV(t+1) = (AV(t) + P(t) - charges(t)) · (1 + i_credit(t))\` net of surrenders.
- Lapses drive a surrender-value payment, mortality drives a death benefit \`max(AV, GMDB)\`.
- Insurer margin is the spread between earned-rate and credited-rate, less expenses.

**Caveat** — the in-app proxy uses a flat crediting / margin assumption; real lifelib runs use a path-dependent earned rate. Use the notebook export for stochastic / nested.
`.trim(),

  "ifrs17-csm": `
**IFRS 17 · CSM roll-forward** maps to [lifelib's ifrs17sim](https://github.com/lifelib-dev/lifelib). The CSM is the unearned profit at recognition that's released to P&L over the coverage period in proportion to coverage units provided.

**Mechanics (BBA)**
- At issue: \`CSM_0 = PV_fulfilment_cashflows + RA - PV_premiums\` (flipped sign so positive = unearned profit).
- Roll-forward each period: accrete at the locked-in rate, adjust for new contracts, release in proportion to coverage units, then unwind.

**Formula (coverage-unit release)**
$$
\\text{release}_t = \\text{CSM}_t \\cdot \\frac{\\text{CU}_t}{\\sum_{s \\geq t} \\text{CU}_s \\cdot v^{s-t}}
$$

**Caveat** — coverage-unit choice (face amount vs. policy count vs. expected claims) materially shifts the release pattern. Document the choice.
`.trim(),

  "solvency2-life": `
**Solvency II · life SCR** maps to [lifelib's solvency2 library](https://github.com/lifelib-dev/lifelib). Standard formula life-underwriting SCR aggregates capital charges from five sub-modules (mortality, longevity, disability, lapse, expense, life-CAT) through the EIOPA correlation matrix.

**Mechanics**
- Each sub-module: shock the relevant assumption, re-value, take ΔBOF.
- Aggregate: \`SCR_life = sqrt(Σ_i Σ_j ρ_{i,j} · SCR_i · SCR_j)\`.

**Caveat** — standard formula is calibrated to a *typical* EU portfolio; the Internal Model option (Article 112) is required where the SF doesn't fit. The in-app proxy uses a single 0.25 cross-correlation in place of the full matrix.
`.trim(),

  "nested-stochastic": `
**Nested stochastic** maps to [lifelib's nestedlife](https://github.com/lifelib-dev/lifelib). An outer real-world simulation (1,000+ paths) carries the cash flows; at each outer node a smaller inner risk-neutral simulation (100+ paths) values the embedded guarantees → produces a time-value-of-options-and-guarantees (TVOG).

**Mechanics**
- Outer: ESG paths drive policyholder behavior + asset returns.
- Inner: at each outer step, value GMxB / GMAB / GMIB under risk-neutral economics.
- TVOG = mean over outer of (inner-PV of guarantee cash flows).

**Caveat** — outer × inner cost is multiplicative. Cluster-compress the MPs first (see \`cluster-modelpoints\`) and use a low-discrepancy sequence for inner.
`.trim(),

  "smithwilson-curve": `
**Smith-Wilson · curve fit** maps to [lifelib's smithwilson](https://github.com/lifelib-dev/lifelib). The EIOPA method extrapolates a risk-free zero curve from the last liquid point (LLP) to the ultimate forward rate (UFR) using a kernel-based smoothing.

**Mechanics**
- Fit zeros to liquid observations (par swaps) below LLP via Wilson kernel.
- Extrapolate to UFR with a convergence-speed parameter α (EIOPA default 0.1).

**Formula (Wilson kernel)**
$$
W(t,u) = e^{-\\text{UFR}(t+u)} \\cdot \\big( \\alpha \\min(t,u) - \\tfrac{1}{2} e^{-\\alpha \\max(t,u)} (e^{\\alpha \\min(t,u)} - e^{-\\alpha \\min(t,u)}) \\big)
$$

**Caveat** — UFR is a regulatory choice, not a market observable; the curve speed parameter α controls how quickly the extrapolation reverts to it. Document both.
`.trim(),

  "cluster-modelpoints": `
**Cluster · model-point compression** maps to [lifelib's cluster library](https://github.com/lifelib-dev/lifelib). Compresses 100k+ policies into K representative model points whose aggregate liability sensitivity matches the full file (typically within 1-3 %).

**Mechanics**
- Pick K cluster heads (k-means / k-medoids) on policy characteristics (age × sum_assured × term × sex …).
- Assign each input policy to its nearest head; the head's weight = sum of assigned policies' weights.
- Validate by comparing the BEL / SCR sensitivities of compressed vs. full.

**Caveat** — compression error is liability-shape-specific. Always validate on the metric you care about (BEL, SCR, IFRS 17 CSM) before relying on compressed runs.
`.trim(),

  "wmtr-projection": `
**WMTR · forecast** is a Monte Carlo survival projection of three composable capitals — Material (M), Time (T), and Relational (R) — under shocks. The engine is the [Nanoeconomics simulation](https://github.com/intelligentactuaries/nanoeconomics-simulation) at its core, ported to TypeScript for in-browser runs.

**Mechanics**
- Wealth: $W = M^{\\alpha_M} \\cdot T^{\\alpha_T} \\cdot R^{\\alpha_R}$ (Cobb-Douglas). Each period, shocks decrement one or more capitals; surviving structure re-grows R via family, religion, and spatial maintenance.
- Survival hazard: $h(t) = h_0 \\cdot \\exp(-\\beta_W \\ln(W / W_0))$. Stronger relative wealth lowers the hazard; collapse becomes likely when W decays past the collapse threshold.
- Shocks: a Poisson event count per year with severity drawn from a clipped normal. Targets cycle over material / time / family / religion / meaning-crisis with a topology mix (idiosyncratic / local / regional / global).

**Domain-agnostic by design.** The same math projects:
- a community's wealth (the original Nanoeconomics frame),
- a life-insurance book's surplus + retention,
- a pension scheme's funded ratio,
- a P&C reserve position under inflation,
- a health book under morbidity waves.
The Hard Data card relabels M / T / R per source family.

**Caveat** — the projection is a stylised forecast, not a calibrated cash-flow model. Use it for stress-direction discovery and intuition, not for board-pack pricing. Pair with the catalog model for the actual quantitative answer.
`.trim(),

  "wmtr-sensitivity": `
**WMTR · shock sensitivity** sweeps the shock dial across {mild, moderate, severe} on the same WMTR config and reports how the outcome distribution shifts. Same math as wmtr-projection; what's exposed is the **stress slope**, not a single trajectory.

**Mechanics**
- Three full runs per call, varying only \`shock\` between {mild, moderate, severe}.
- Each run produces a fraction-grew / fraction-stabilized / fraction-declined / fraction-collapsed quartet.
- Headline: \`collapse-Δ\` = collapse-fraction(severe) − collapse-fraction(mild). Reads as "how much does the worst-case outcome blow up when the shock dial moves end-to-end".

**Reads well alongside** the council layer: ask 192 personas which shock magnitude is honest, then trust the corresponding row.

**Caveat** — sensitivity to severity ≠ sensitivity to \`α\` or \`w\`. A future variant should sweep arbitrary parameters; for now this is the canonical first-pass stress.
`.trim(),

  "economic-curves": `
**Economic curves** maps to [lifelib's economic / economic_curves libraries](https://github.com/lifelib-dev/lifelib). Bootstraps zero, forward, and discount curves from quoted swap / bond rates with interpolation methods (linear, log-linear, cubic spline).

**Mechanics**
- Bootstrap zeros from par swaps tenor-by-tenor (no-arbitrage).
- Forward(t,T) = (DF(t) / DF(T))^(1/(T-t)) - 1.
- Discount(t) = exp(-z(t) · t).

**Caveat** — interpolation between liquid points injects model risk in the long end. For solvency reporting use Smith-Wilson to the UFR (see \`smithwilson-curve\`); for IFRS 17 discount the configurable methodology.
`.trim(),
};

export function modelTheoryFor(modelId: string): string | null {
  return MODEL_THEORY[modelId] ?? null;
}
