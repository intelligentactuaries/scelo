# Function reference

Every exported name, grouped the way the chapters are. Generated from
the packages themselves — `scelo.__all__` on the Python side, the
`NAMESPACE` on the R side — so this list and the installed libraries
cannot drift apart. A `—` marks a deliberate asymmetry, explained at
the end. `sc.cheatsheet()` / `sc_cheatsheet()` print the one-screen
version of this page in your terminal.

<!-- generated against scelo-py 0.1.0 __all__ and scelo-r NAMESPACE; 248 Python names -->

## Soft data — I/O

| Python | R | Kind |
|---|---|---|
| `sc.coerce()` | `sc_coerce()` | function |
| `sc.coerce_cell()` | `sc_coerce_cell()` | function |
| `sc.DEFAULT_IMPORT_ROW_CAP` | — | constant |
| `sc.load()` | `sc_load()` | function |
| `sc.MISSING_CELL_TOKENS` | — | constant |
| `sc.reservoir()` | `sc_reservoir()` | function |
| `sc.sample()` | `sc_sample()` | function |
| `sc.samples()` | `sc_samples()` | function |
| `sc.save()` | `sc_save()` | function |
| `sc.sniff()` | `sc_sniff()` | function |

## Soft data — profiling

| Python | R | Kind |
|---|---|---|
| `sc.box()` | `sc_box()` | function |
| `sc.column_type()` | `sc_column_type()` | function |
| `sc.corr()` | `sc_corr()` | function |
| `sc.describe()` | `sc_describe()` | function |
| `sc.fences()` | `sc_fences()` | function |
| `sc.histogram()` | — | function |
| `sc.inliers()` | `sc_inliers()` | function |
| `sc.iqr()` | `sc_iqr()` | function |
| `sc.jarque_bera()` | `sc_jarque_bera()` | function |
| `sc.kurt()` | `sc_kurt()` | function |
| `sc.missing()` | `sc_missing()` | function |
| `sc.outliers()` | `sc_outliers()` | function |
| `sc.profile()` | `sc_profile()` | function |
| `sc.quantile()` | `sc_quantile()` | function |
| `sc.skew()` | `sc_skew()` | function |
| `sc.summary()` | — | function |
| `sc.tab()` | `sc_tab()` | function |
| `sc.types()` | `sc_types()` | function |
| `sc.unique()` | — | function |

## Soft data — cleaning

| Python | R | Kind |
|---|---|---|
| `sc.ALL_OPS` | `SC_ALL_OPS` | class |
| `sc.booleans()` | `sc_booleans()` | function |
| `sc.cap_outliers()` | `sc_cap_outliers()` | function |
| `sc.clean()` | `sc_clean()` | function |
| `sc.coerce_numeric()` | `sc_coerce_numeric()` | function |
| `sc.collapse_ws()` | `sc_collapse_ws()` | function |
| `sc.dedupe()` | `sc_dedupe()` | function |
| `sc.drop_constant()` | `sc_drop_constant()` | function |
| `sc.drop_empty()` | `sc_drop_empty()` | function |
| `sc.FALSE_TOKENS` | `SC_FALSE_TOKENS` | class |
| `sc.fix_encoding()` | `sc_fix_encoding()` | function |
| `sc.future_years()` | `sc_future_years()` | function |
| `sc.impute()` | `sc_impute()` | function |
| `sc.infer_day_first()` | `sc_infer_day_first()` | function |
| `sc.lowercase()` | `sc_lowercase()` | function |
| `sc.MISSING_TOKENS` | `SC_MISSING_TOKENS` | class |
| `sc.missing_tokens()` | `sc_missing_tokens()` | function |
| `sc.NUMERIC_SENTINELS` | `SC_NUMERIC_SENTINELS` | class |
| `sc.parse_date()` | `sc_parse_date()` | function |
| `sc.parse_dates()` | `sc_parse_dates()` | function |
| `sc.parse_number()` | `sc_parse_number()` | function |
| `sc.parse_numbers()` | `sc_parse_numbers()` | function |
| `sc.recode()` | `sc_recode()` | function |
| `sc.SAFE_OPS` | `SC_SAFE_OPS` | class |
| `sc.sentinels()` | `sc_sentinels()` | function |
| `sc.snake_case()` | `sc_snake_case()` | function |
| `sc.snake_names()` | `sc_snake_names()` | function |
| `sc.suggest()` | `sc_suggest()` | function |
| `sc.trim()` | `sc_trim()` | function |
| `sc.TRUE_TOKENS` | `SC_TRUE_TOKENS` | class |

## Soft data — combining

| Python | R | Kind |
|---|---|---|
| `sc.append()` | `sc_append()` | function |
| `sc.combine()` | `sc_combine()` | function |
| `sc.diff()` | `sc_diff()` | function |
| `sc.join()` | `sc_join()` | function |
| `sc.stack()` | `sc_stack()` | function |
| `sc.suggest_combine()` | `sc_suggest_combine()` | function |
| `sc.tieout()` | `sc_tieout()` | function |

## Column inference

| Python | R | Kind |
|---|---|---|
| `sc.COLUMN_ALIASES` | `SC_COLUMN_ALIASES` | class |
| `sc.find_column()` | `sc_find_column()` | function |
| `sc.infer()` | `sc_infer()` | function |

## The Table

| Python | R | Kind |
|---|---|---|
| `sc.as_table()` | `sc_table()` | function |
| `sc.notes()` | `sc_notes()` | function |
| `sc.Table` | `sc_table` | class |

## Life & mortality

| Python | R | Kind |
|---|---|---|
| `sc.ae()` | `sc_ae()` | function |
| `sc.ae_test()` | `sc_ae_test()` | function |
| `sc.annuity()` | `sc_annuity()` | function |
| `sc.assurance()` | `sc_assurance()` | function |
| `sc.basicterm()` | `sc_basicterm()` | function |
| `sc.BasicTermAssumptions` | `sc_basicterm_assumptions` | class |
| `sc.Basis` | — | type alias |
| `sc.close_table()` | `sc_close_table()` | function |
| `sc.commutation()` | `sc_commutation()` | function |
| `sc.csm()` | `sc_csm()` | function |
| `sc.epv()` | `sc_epv()` | function |
| `sc.exposure()` | `sc_exposure()` | function |
| `sc.factors()` | `sc_factors()` | function |
| `sc.gompertz()` | `sc_gompertz()` | function |
| `sc.graduate()` | `sc_graduate()` | function |
| `sc.ILLUSTRATIVE_MAKEHAM` | `SC_ILLUSTRATIVE_MAKEHAM` | class |
| `sc.kaplan_meier()` | `sc_kaplan_meier()` | function |
| `sc.lee_carter()` | `sc_lee_carter()` | function |
| `sc.life_expectancy()` | `sc_life_expectancy()` | function |
| `sc.life_table()` | `sc_life_table()` | function |
| `sc.makeham()` | `sc_makeham()` | function |
| `sc.model_points()` | `sc_model_points()` | function |
| `sc.mx_to_qx()` | `sc_mx_to_qx()` | function |
| `sc.premium()` | `sc_premium()` | function |
| `sc.qx()` | `sc_qx()` | function |
| `sc.qx_to_mx()` | `sc_qx_to_mx()` | function |
| `sc.scr_life()` | `sc_scr_life()` | function |
| `sc.SII_LIFE_SHOCKS` | `SC_SII_LIFE_SHOCKS` | class |
| `sc.survival()` | `sc_survival()` | function |

## Reserving

| Python | R | Kind |
|---|---|---|
| `sc.ata()` | `sc_ata()` | function |
| `sc.bf()` | `sc_bf()` | function |
| `sc.bootstrap()` | `sc_bootstrap()` | function |
| `sc.cape_cod()` | `sc_cape_cod()` | function |
| `sc.cdf()` | `sc_cdf()` | function |
| `sc.chain_ladder()` | `sc_chain_ladder()` | function |
| `sc.from_wide()` | `sc_from_wide()` | function |
| `sc.is_cumulative()` | `sc_is_cumulative()` | function |
| `sc.latest_diagonal()` | `sc_latest_diagonal()` | function |
| `sc.ldf()` | `sc_ldf()` | function |
| `sc.mack()` | `sc_mack()` | function |
| `sc.reserve()` | `sc_reserve()` | function |
| `sc.ReservingResult` | `scelo_reserving` (class) | class |
| `sc.tail()` | `sc_tail()` | function |
| `sc.to_cumulative()` | `sc_to_cumulative()` | function |
| `sc.to_incremental()` | `sc_to_incremental()` | function |
| `sc.triangle()` | `sc_triangle()` | function |

## Finance

| Python | R | Kind |
|---|---|---|
| `sc.accumulation()` | `sc_accumulation()` | function |
| `sc.annuity_certain()` | `sc_annuity_certain()` | function |
| `sc.bond_price()` | `sc_bond_price()` | function |
| `sc.bond_yield()` | `sc_bond_yield()` | function |
| `sc.bootstrap_par()` | `sc_bootstrap_par()` | function |
| `sc.convexity()` | `sc_convexity()` | function |
| `sc.df_to_zero()` | `sc_df_to_zero()` | function |
| `sc.discount_curve()` | `sc_discount_curve()` | function |
| `sc.discount_rate()` | `sc_discount_rate()` | function |
| `sc.duration()` | `sc_duration()` | function |
| `sc.effective()` | `sc_effective()` | function |
| `sc.force()` | `sc_force()` | function |
| `sc.forward_rates()` | `sc_forward_rates()` | function |
| `sc.from_force()` | `sc_from_force()` | function |
| `sc.hull_white()` | `sc_hull_white()` | function |
| `sc.irr()` | `sc_irr()` | function |
| `sc.nelson_siegel()` | `sc_nelson_siegel()` | function |
| `sc.nominal()` | `sc_nominal()` | function |
| `sc.npv()` | `sc_npv()` | function |
| `sc.nss()` | `sc_nss()` | function |
| `sc.pv()` | `sc_pv()` | function |
| `sc.smith_wilson()` | `sc_smith_wilson()` | function |
| `sc.v()` | `sc_v()` | function |
| `sc.zero_to_df()` | `sc_zero_to_df()` | function |

## Risk

| Python | R | Kind |
|---|---|---|
| `sc.aggregate_loss()` | `sc_aggregate_loss()` | function |
| `sc.aggregate_scr()` | `sc_aggregate_scr()` | function |
| `sc.buhlmann()` | `sc_buhlmann()` | function |
| `sc.credibility()` | `sc_credibility()` | function |
| `sc.es()` | `sc_es()` | function |
| `sc.fit()` | `sc_fit()` | function |
| `sc.full_credibility()` | `sc_full_credibility()` | function |
| `sc.limited_fluctuation()` | `sc_limited_fluctuation()` | function |
| `sc.lognormal_params()` | `sc_lognormal_params()` | function |
| `sc.panjer()` | `sc_panjer()` | function |
| `sc.risk_margin()` | `sc_risk_margin()` | function |
| `sc.SII_BSCR_CORR` | `SC_SII_BSCR_CORR` | class |
| `sc.SII_LIFE_CORR` | `SC_SII_LIFE_CORR` | class |
| `sc.SII_NONLIFE_CORR` | `SC_SII_NONLIFE_CORR` | class |
| `sc.simulate_losses()` | `sc_simulate_losses()` | function |
| `sc.tvar()` | `sc_tvar()` | function |
| `sc.var()` | `sc_var()` | function |

## Pricing

| Python | R | Kind |
|---|---|---|
| `sc.burning_cost()` | `sc_burning_cost()` | function |
| `sc.design_matrix()` | `sc_design_matrix()` | function |
| `sc.freq_sev()` | `sc_freq_sev()` | function |
| `sc.gini()` | `sc_gini()` | function |
| `sc.glm()` | `sc_glm()` | function |
| `sc.GLMResult` | `scelo_glm` (class) | class |
| `sc.lift()` | `sc_lift()` | function |
| `sc.loss_ratio()` | `sc_loss_ratio()` | function |
| `sc.rate_table()` | `sc_rate_table()` | function |
| `sc.relativities()` | `sc_relativities()` | function |

## Fairness

| Python | R | Kind |
|---|---|---|
| `sc.disparate_impact()` | `sc_disparate_impact()` | function |
| `sc.fairness()` | `sc_fairness()` | function |
| `sc.fairness_audit()` | `sc_fairness_audit()` | function |
| `sc.parity()` | `sc_parity()` | function |

## Climate

| Python | R | Kind |
|---|---|---|
| `sc.aal()` | `sc_aal()` | function |
| `sc.anomaly()` | `sc_anomaly()` | function |
| `sc.ensemble()` | `sc_ensemble()` | function |
| `sc.parametric_trigger()` | `sc_parametric_trigger()` | function |
| `sc.return_period()` | `sc_return_period()` | function |

## Forecast — W(M, T, R)

| Python | R | Kind |
|---|---|---|
| `sc.apply_intervention()` | `sc_apply_intervention()` | function |
| `sc.classify()` | `sc_classify()` | function |
| `sc.DEFAULT_WMTR_PARAMS` | `SC_DEFAULT_WMTR_PARAMS` | class |
| `sc.derive_config()` | `sc_derive_config()` | function |
| `sc.dominant_driver()` | `sc_dominant_driver()` | function |
| `sc.driver_contributions()` | `sc_driver_contributions()` | function |
| `sc.INTERVENTION_PARAMS` | `SC_INTERVENTION_PARAMS` | class |
| `sc.mulberry32()` | `sc_mulberry32()` | function |
| `sc.run_wmtr()` | `sc_run_wmtr()` | function |
| `sc.sensitivity()` | `sc_sensitivity()` | function |
| `sc.SHOCK_PARAMS` | `SC_SHOCK_PARAMS` | class |
| `sc.wmtr()` | `sc_wmtr()` | function |
| `sc.WmtrParams` | `sc_wmtr_params` | class |
| `sc.WmtrResult` | `scelo_wmtr` (class) | class |

## Swarm client

| Python | R | Kind |
|---|---|---|
| `sc.augment()` | `sc_augment()` | function |
| `sc.chat_log()` | `sc_chat_log()` | function |
| `sc.connect()` | `sc_connect()` | function |
| `sc.council()` | `sc_council()` | function |
| `sc.council_run()` | `sc_council_run()` | function |
| `sc.COUNCIL_SIZE` | `SC_COUNCIL_SIZE` | class |
| `sc.CouncilResult` | `scelo_council` (class) | class |
| `sc.intervene()` | `sc_intervene()` | function |
| `sc.justify()` | `sc_justify()` | function |
| `sc.PROFESSIONS` | `SC_PROFESSIONS` | class |
| `sc.society()` | `sc_society()` | function |
| `sc.swarm_status()` | `sc_swarm_status()` | function |
| `sc.swarm_url()` | `sc_swarm_url()` | function |
| `sc.swarm_wmtr()` | `sc_swarm_wmtr()` | function |
| `sc.SwarmError` | `scelo_swarm_error` (class) | class |

## Workspace diagnostics

| Python | R | Kind |
|---|---|---|
| `sc.active_subspace()` | `sc_active_subspace()` | function |
| `sc.bottleneck()` | `sc_bottleneck()` | function |
| `sc.participation_ratio()` | `sc_participation_ratio()` | function |

## lifelib bridge

| Python | R | Kind |
|---|---|---|
| `sc.lifelib_home()` | `sc_lifelib_home()` | function |
| `sc.lifelib_models()` | `sc_lifelib_models()` | function |
| `sc.lifelib_provenance()` | `sc_lifelib_provenance()` | function |
| `sc.lifelib_run()` | `sc_lifelib_run()` | function |
| `sc.LIFELIB_VERSION` | `SC_LIFELIB_VERSION` | class |
| `sc.MODELX_VERSION` | `SC_MODELX_VERSION` | class |
| `sc.normalise_model_points()` | `sc_normalise_model_points()` | function |

## Hard data

| Python | R | Kind |
|---|---|---|
| `sc.export()` | `sc_export()` | function |
| `sc.hard()` | `sc_hard()` | function |
| `sc.provenance()` | `sc_provenance()` | function |
| `sc.report()` | `sc_report()` | function |
| `sc.restore()` | `sc_restore()` | function |
| `sc.snapshot()` | `sc_snapshot()` | function |
| `sc.snapshots()` | `sc_snapshots()` | function |
| `sc.verify()` | `sc_verify()` | function |

## Audit

| Python | R | Kind |
|---|---|---|
| `sc.audit()` | `sc_audit()` | function |
| `sc.clear_audit()` | `sc_clear_audit()` | function |
| `sc.content_hash()` | `sc_content_hash()` | function |
| `sc.enable_audit()` | `sc_enable_audit()` | function |

## One-liners

| Python | R | Kind |
|---|---|---|
| `sc.CHEATSHEET` | `SC_CHEATSHEET` | class |
| `sc.cheatsheet()` | `sc_cheatsheet()` | function |
| `sc.experience()` | `sc_experience()` | function |
| `sc.price()` | `sc_price()` | function |
| `sc.quick()` | `sc_quick()` | function |

## Charts

| Python | R | Kind |
|---|---|---|
| `sc.PALETTE` | `sc_palette` | class |
| `sc.palette()` | `sc_palette()` | function |
| `sc.plot_bars()` | `sc_plot_bars()` | function |
| `sc.plot_csm()` | `sc_plot_csm()` | function |
| `sc.plot_lines()` | `sc_plot_lines()` | function |
| `sc.plot_projection()` | `sc_plot_projection()` | function |
| `sc.plot_rates()` | `sc_plot_rates()` | function |
| `sc.plot_relativities()` | `sc_plot_relativities()` | function |
| `sc.plot_scr()` | `sc_plot_scr()` | function |
| `sc.plot_table()` | — | function |
| `sc.plot_triangle()` | `sc_plot_triangle()` | function |
| `sc.save_figure()` | — | function |
| `sc.SEQUENTIAL` | `sc_palette` | class |
| `sc.SERIES` | `sc_palette` | class |

## R-only exports

Names with no single Python twin — mostly S3 constructors/accessors that Python
does with object attributes, plus a few R conveniences:

`sc_basis`, `sc_df`, `sc_markdown`, `sc_note`, `sc_predict`, `sc_title`


Python-only names are equally deliberate: `histogram`, `unique` and
`summary` shadow base-R vocabulary (use `sc_profile` / `sc_describe`),
`save_figure` and `plot_table` exist because matplotlib figures are
objects while R draws on the current device, and `Basis` is a typing
alias. The io constants (`MISSING_CELL_TOKENS`,
`DEFAULT_IMPORT_ROW_CAP`) document the import rule rather than
configure it.
