// Built-in actuarial snippets surfaced through Monaco's completion
// menu. Trigger by typing the snippet prefix (e.g. `scelo-mortality`)
// — Monaco merges these with the live LSP completions, so they're
// only intrusive when the user actively types one of the prefixes.
//
// Snippet bodies use Monaco's standard `${1:placeholder}` syntax so
// Tab cycles through fill-in points. Keep them small + idiomatic; the
// goal is "starts a sane file" not "writes the whole analysis."

export type SnippetLang = "python" | "r";

export interface Snippet {
  /** Token the user types to surface the snippet. Convention :
   *  `scelo-<area>-<thing>`. */
  prefix: string;
  /** Short description shown in the completion popup. */
  detail: string;
  /** Full body. Tab-stops use the Monaco / VS Code `${N:default}`
   *  syntax; bare `$N` is also supported. */
  body: string;
}

const PYTHON_SNIPPETS: Snippet[] = [
  {
    prefix: "scelo-mortality-lifelib",
    detail: "lifelib mortality table boilerplate (qx -> lx -> ex)",
    body: [
      "import lifelib",
      "import numpy as np",
      "",
      "# Replace with the table id you want (e.g. 'mort_table').",
      "qx = np.array([${1:0.001}, ${2:0.0011}, ${3:0.0013}])",
      "radix = ${4:100_000}",
      "lx = np.empty(qx.size + 1)",
      "lx[0] = radix",
      "for i, q in enumerate(qx):",
      "    lx[i + 1] = lx[i] * (1 - q)",
      "ex = (lx[1:].sum() / lx[:-1]) - 0.5",
      "${0:print(ex)}",
    ].join("\n"),
  },
  {
    prefix: "scelo-chainladder-triangle",
    detail: "chainladder triangle + Mack reserve estimate",
    body: [
      "import chainladder as cl",
      "",
      "# `data` should be a long-form DataFrame with columns",
      "# origin / development / values — see chainladder docs.",
      "data = ${1:cl.load_sample('genins')}",
      "triangle = cl.Triangle(data, origin='origin', development='development', columns='values')",
      "mack = cl.MackChainladder().fit(triangle.incr_to_cum())",
      "reserve = mack.ibnr_",
      "${0:print(reserve)}",
    ].join("\n"),
  },
  {
    prefix: "scelo-climada-pipeline",
    detail: "climada hazard -> exposure -> impact pipeline stub",
    body: [
      "from climada.hazard import TCTracks, TropCyclone, Centroids",
      "from climada.entity import LitPop",
      "from climada.engine import Impact",
      "",
      "tracks = TCTracks.from_ibtracs_netcdf(",
      "    provider='usa', year_range=(${1:2000}, ${2:2020}), basin='${3:NA}',",
      ")",
      "tracks.equal_timestep(0.5)",
      "cent = Centroids.from_pnt_bounds((${4:-95}, ${5:24}, ${6:-65}, ${7:45}), res=1.0)",
      "haz = TropCyclone.from_tracks(tracks, centroids=cent)",
      "exp = LitPop.from_countries('${8:USA}', res_arcsec=600)",
      "exp.assign_centroids(haz)",
      "impact = Impact()",
      "impact.calc(exp, exp.impact_funcs, haz)",
      "${0:print(impact.aai_agg)}",
    ].join("\n"),
  },
  {
    prefix: "scelo-statsmodels-glm",
    detail: "Poisson GLM frequency model (statsmodels)",
    body: [
      "import statsmodels.api as sm",
      "import pandas as pd",
      "",
      "df = ${1:pd.read_csv('claims.csv')}",
      "y = df['${2:claim_count}']",
      "X = sm.add_constant(df[[${3:'driver_age', 'vehicle_age', 'bonus_malus'}]])",
      "exposure = df['${4:exposure}']",
      "",
      "model = sm.GLM(y, X, family=sm.families.Poisson(), exposure=exposure)",
      "fit = model.fit()",
      "${0:print(fit.summary())}",
    ].join("\n"),
  },
  {
    prefix: "scelo-fairlearn-audit",
    detail: "Fairlearn demographic-parity audit (FSCA TCF Principle 4)",
    body: [
      "from fairlearn.metrics import MetricFrame, demographic_parity_difference",
      "from sklearn.metrics import mean_squared_error",
      "",
      "sensitive = ${1:df['gender']}",
      "y_true = ${2:df['observed']}",
      "y_pred = ${3:model.predict(X)}",
      "",
      "frame = MetricFrame(",
      "    metrics={'mse': mean_squared_error},",
      "    y_true=y_true,",
      "    y_pred=y_pred,",
      "    sensitive_features=sensitive,",
      ")",
      "dpd = demographic_parity_difference(y_true, y_pred, sensitive_features=sensitive)",
      "${0:print('per-group MSE:', frame.by_group, '\\nDPD:', dpd)}",
    ].join("\n"),
  },
  {
    prefix: "scelo-shap-attribution",
    detail: "SHAP feature attribution for a tree model",
    body: [
      "import shap",
      "import matplotlib.pyplot as plt",
      "",
      "explainer = shap.TreeExplainer(${1:model})",
      "shap_values = explainer(${2:X_test})",
      "",
      "shap.summary_plot(shap_values, ${2:X_test}, show=False)",
      "${0:plt.savefig('out/shap_summary.png', dpi=150, bbox_inches='tight')}",
    ].join("\n"),
  },
];

const R_SNIPPETS: Snippet[] = [
  {
    prefix: "scelo-actuar-mixture",
    detail: "actuar — fit a Gamma/Pareto mixture severity model",
    body: [
      "suppressPackageStartupMessages(library(actuar))",
      "",
      "claims <- c(${1:120, 230, 410, 1500, 4200, 17_000})",
      "fit_gamma <- fitdistr(claims, 'gamma')",
      "fit_pareto <- fitdistr(claims, 'pareto', start = list(shape = 1, scale = 1))",
      "",
      "weights <- c(${2:0.7}, ${3:0.3})",
      "${0:mix_mean <- weights[1] * mean(rgamma(1e4, fit_gamma\\$estimate['shape'], fit_gamma\\$estimate['rate'])) +",
      "             weights[2] * mean(rpareto(1e4, fit_pareto\\$estimate['shape'], fit_pareto\\$estimate['scale']))}",
    ].join("\n"),
  },
  {
    prefix: "scelo-ggplot-survival",
    detail: "ggplot survival curve (Kaplan-Meier from survival pkg)",
    body: [
      "suppressPackageStartupMessages({",
      "  library(survival)",
      "  library(ggplot2)",
      "})",
      "",
      "df <- ${1:lung}",
      "fit <- survfit(Surv(time, status) ~ ${2:sex}, data = df)",
      "surv_df <- data.frame(",
      "  time = fit\\$time,",
      "  surv = fit\\$surv,",
      "  group = rep(names(fit\\$strata), fit\\$strata)",
      ")",
      "",
      "ggplot(surv_df, aes(x = time, y = surv, colour = group)) +",
      "  geom_step(linewidth = 0.8) +",
      "  labs(title = '${3:Kaplan-Meier survival}', x = 'time', y = 'S(t)') +",
      "  theme_minimal(base_size = 11)",
      "${0:}",
    ].join("\n"),
  },
  {
    prefix: "scelo-chainladder-mack",
    detail: "ChainLadder Mack + bootstrap percentiles (R)",
    body: [
      "suppressPackageStartupMessages(library(ChainLadder))",
      "",
      "triangle <- ${1:RAA}  # bundled fixture; replace with your triangle",
      "",
      "mack <- MackChainLadder(triangle, est.sigma = 'Mack')",
      "ibnr <- summary(mack)\\$Totals[2, 1]",
      "se   <- summary(mack)\\$Totals[3, 1]",
      "",
      "boot <- BootChainLadder(triangle, R = ${2:1000}, process.distr = 'od.pois')",
      "${0:cat(sprintf('IBNR %.0f  SE %.0f  p95 %.0f\\n',",
      "              ibnr, se, quantile(boot\\$IBNR.Totals, 0.95)))}",
    ].join("\n"),
  },
  {
    prefix: "scelo-stmomo-leecarter",
    detail: "StMoMo — fit Lee-Carter to a mortality dataset",
    body: [
      "suppressPackageStartupMessages(library(StMoMo))",
      "",
      "data <- ${1:EWMaleData}  # bundled E&W male; swap for your StMoMoData",
      "",
      "LC <- lc(link = 'logit')",
      "fit <- fit(LC, data = data, ages.fit = ${2:55:89})",
      "fore <- forecast(fit, h = ${3:30})",
      "${0:print(fore\\$kt.f\\$mean)}",
    ].join("\n"),
  },
  {
    prefix: "scelo-lifecont-puc",
    detail: "lifecontingencies — Projected Unit Credit valuation",
    body: [
      "suppressPackageStartupMessages(library(lifecontingencies))",
      "",
      "table <- ${1:soa08Act}",
      "rate  <- ${2:0.04}",
      "age   <- ${3:35L}",
      "retire_age <- ${4:65L}",
      "",
      "# Annuity-due factor at retirement; PUC accrues against this.",
      "a_ret <- axn(table, x = retire_age, i = rate, m = 1)",
      "puc <- a_ret * (rate / (1 + rate)^(retire_age - age))",
      "${0:cat(sprintf('PUC factor @ age %d : %.4f\\n', age, puc))}",
    ].join("\n"),
  },
];

export function snippetsFor(lang: SnippetLang): Snippet[] {
  return lang === "python" ? PYTHON_SNIPPETS : R_SNIPPETS;
}
