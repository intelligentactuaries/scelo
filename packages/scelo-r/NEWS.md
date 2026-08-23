# scelo 0.1.0

First release: the Scelo IDE brain layer as an R package.

* Soft data: `sc_load`, `sc_profile`, `sc_describe`, `sc_tab`, `sc_suggest`, `sc_clean` (the IDE's 18 cleaning ops with their thresholds), `sc_combine`.
* Life: `sc_life_table`, `sc_commutation`, `sc_factors`, `sc_premium`, `sc_ae`, `sc_model_points`, `sc_graduate`, `sc_lee_carter`, `sc_kaplan_meier`, `sc_exposure`, `sc_basicterm`, `sc_epv`.
* Reserving: `sc_triangle`, `sc_chain_ladder`, `sc_mack`, `sc_bf`, `sc_cape_cod`, `sc_bootstrap`, `sc_tail`, `sc_reserve`.
* Finance: `sc_discount_curve`, `sc_smith_wilson`, `sc_nelson_siegel`, `sc_nss`, `sc_hull_white`, the Exam-FM helpers.
* Risk: `sc_var`, `sc_tvar`, `sc_aggregate_loss` (Panjer / FFT / Monte Carlo), `sc_fit`, `sc_credibility`, `sc_aggregate_scr`, `sc_risk_margin`.
* Pricing and fairness: `sc_glm`, `sc_relativities`, `sc_freq_sev`, `sc_loss_ratio`, `sc_lift`, `sc_gini`, `sc_fairness`, `sc_fairness_audit`.
* Forecast and swarm: `sc_wmtr` (bit-exact with the IDE's engine), `sc_sensitivity`, `sc_council`, `sc_society`, `sc_augment`.
* Hard data: `sc_hard`, `sc_report`, `sc_export`, `sc_audit`, `sc_verify`, snapshots.
