# Swarm: the client for Scelo's decision-support cockpit (apps/swarm).
#
# Scelo IDE starts the swarm with the app on loopback port 3010; the same
# server runs standalone with `bun run dev:swarm`. This file talks to its
# HTTP API through the curl and jsonlite packages, asked for at call time
# (.sc_need) so the rest of the package stays base R:
#
#   sc_council(scenario)     convene the stratified professional council
#                            (8 professions x 16 MBTI x 2) over a scenario,
#                            with the WMTR evidence injected, and read back
#                            trust / distrust / uncertainty, risk clusters
#                            and recommended interventions;
#   sc_society(scenario)     simulate an SA-anchored population's behaviour,
#                            health and economic outcomes, with the macro
#                            roll-up and its provenance;
#   sc_augment(df, scenario) attach simulated outcome columns to your rows;
#   sc_swarm_wmtr(scenario)  run the WMTR forecast on the server (sc_wmtr()
#                            is the same engine, locally).
#
# The society endpoints stream server-sent events; the client reads the
# stream as it arrives (heartbeats keep long runs alive) and keeps the
# "result" event. There is no authentication: the server trusts its
# loopback. Point sc_connect() (or $SCELO_SWARM_URL) elsewhere for a remote
# swarm. Every failure is a condition of class "scelo_swarm_error".

#' The council's professions and size
#'
#' @format `SC_PROFESSIONS` a character vector of 8; `SC_COUNCIL_SIZE` 256.
#' @export
SC_PROFESSIONS <- c("Finance", "Investor", "Accountant", "Actuary", "Psychologist", "ConspiracyTheorist", "Lawyer", "SocialMediaInfluencer")

#' @rdname SC_PROFESSIONS
#' @export
SC_COUNCIL_SIZE <- 256L

.SC_SWARM_DEFAULT_URL <- "http://127.0.0.1:3010"
.sc_swarm_env <- new.env(parent = emptyenv())
.sc_swarm_env$base <- NULL

.sc_swarm_error <- function(msg) stop(structure(class = c("scelo_swarm_error", "error", "condition"), list(message = msg, call = NULL)))

#' Connect to a swarm
#'
#' Set (or reset) the swarm base URL; returns it. Default: `$SCELO_SWARM_URL`
#' or `http://127.0.0.1:3010` (the swarm Scelo IDE bundles).
#' @param url Base URL, or `NULL` for the default.
#' @return The base URL (invisibly for `sc_connect()`).
#' @examples
#' sc_connect("http://127.0.0.1:3010")
#' sc_swarm_url()
#' @export
sc_connect <- function(url = NULL) {
  base <- url
  if (is.null(base) || !nzchar(base)) base <- Sys.getenv("SCELO_SWARM_URL", unset = "")
  if (!nzchar(base)) base <- .SC_SWARM_DEFAULT_URL
  .sc_swarm_env$base <- sub("/+$", "", base)
  invisible(.sc_swarm_env$base)
}

#' @rdname sc_connect
#' @export
sc_swarm_url <- function() if (is.null(.sc_swarm_env$base)) sc_connect() else .sc_swarm_env$base

# An empty JSON object (jsonlite writes an unnamed empty list as []).
.sc_json_obj <- function(...) {
  x <- list(...)
  if (!length(x)) names(x) <- character()
  x
}

.sc_to_json <- function(body) jsonlite::toJSON(body, auto_unbox = TRUE, null = "null", na = "null", digits = NA)

.sc_from_json <- function(txt) jsonlite::fromJSON(txt, simplifyVector = TRUE, simplifyDataFrame = FALSE, simplifyMatrix = FALSE)

.sc_swarm_handle <- function(method, body, timeout, accept) {
  h <- curl::new_handle()
  curl::handle_setopt(h, customrequest = method, timeout = as.integer(ceiling(timeout)), connecttimeout = as.integer(min(10, ceiling(timeout))))
  curl::handle_setheaders(h, "content-type" = "application/json", accept = accept)
  if (!is.null(body)) curl::handle_setopt(h, postfields = .sc_to_json(body))
  h
}

.sc_response_text <- function(content) {
  if (!length(content)) return("")
  s <- rawToChar(content)
  Encoding(s) <- "UTF-8"
  s
}

.sc_swarm_request <- function(method, path, body = NULL, timeout = 30) {
  .sc_need("curl", "for the swarm client")
  .sc_need("jsonlite", "for the swarm client")
  url <- paste0(sc_swarm_url(), path)
  h <- .sc_swarm_handle(method, body, timeout, "application/json")
  resp <- tryCatch(curl::curl_fetch_memory(url, handle = h), error = function(e) {
    .sc_swarm_error(sprintf("cannot reach the swarm at %s (%s). Start Scelo IDE (it bundles the swarm) or run `bun run dev:swarm`, or sc_connect(url).", sc_swarm_url(), conditionMessage(e)))
  })
  txt <- .sc_response_text(resp$content)
  if (resp$status_code >= 400) {
    msg <- tryCatch(.sc_from_json(txt)$error, error = function(e) NULL)
    if (is.null(msg)) msg <- sprintf("HTTP %d", resp$status_code)
    .sc_swarm_error(sprintf("%s %s → %d: %s", method, path, resp$status_code, msg))
  }
  if (!nzchar(txt)) return(NULL)
  .sc_from_json(txt)
}

# Parse server-sent-event lines: keep the JSON of every "data:" line.
.sc_parse_sse_lines <- function(lines) {
  out <- list()
  for (s in trimws(lines)) {
    if (!nzchar(s) || startsWith(s, ":")) next
    if (startsWith(s, "data:")) {
      ev <- tryCatch(.sc_from_json(trimws(substring(s, 6))), error = function(e) NULL)
      if (!is.null(ev)) out[[length(out) + 1L]] <- ev
    }
  }
  out
}

# POST and read the event stream as it arrives; `on_event` sees every event.
.sc_sse <- function(method, path, body, timeout, on_event = NULL) {
  .sc_need("curl", "for the swarm client")
  .sc_need("jsonlite", "for the swarm client")
  url <- paste0(sc_swarm_url(), path)
  h <- .sc_swarm_handle(method, body, timeout, "text/event-stream")
  events <- list()
  pending <- ""
  take <- function(text, final = FALSE) {
    text <- paste0(pending, text)
    parts <- strsplit(text, "\n", fixed = TRUE)[[1]]
    if (!final && !endsWith(text, "\n")) {
      pending <<- parts[length(parts)]
      parts <- parts[-length(parts)]
    } else {
      pending <<- ""
    }
    for (ev in .sc_parse_sse_lines(parts)) {
      events[[length(events) + 1L]] <<- ev
      if (!is.null(on_event)) on_event(ev)
    }
  }
  resp <- tryCatch(curl::curl_fetch_stream(url, function(chunk) take(.sc_response_text(chunk)), handle = h), error = function(e) {
    .sc_swarm_error(sprintf("cannot reach the swarm at %s (%s)", sc_swarm_url(), conditionMessage(e)))
  })
  take("", final = TRUE)
  if (resp$status_code >= 400) .sc_swarm_error(sprintf("%s %s → %d: %s", method, path, resp$status_code, substr(pending, 1, 300)))
  events
}

#' Swarm status
#'
#' Health and configured providers of the swarm at [sc_swarm_url()].
#' @return A list: `url`, `ok`, `providers`.
#' @examples
#' \dontrun{
#' sc_swarm_status()$ok
#' }
#' @export
sc_swarm_status <- function() {
  health <- .sc_swarm_request("GET", "/api/health", timeout = 5)
  providers <- .sc_swarm_request("GET", "/api/providers", timeout = 5)
  list(url = sc_swarm_url(), ok = isTRUE(health$ok), providers = providers)
}

# ── council ───────────────────────────────────────────────────────────────

.sc_or_na <- function(v) if (is.null(v) || !length(v)) NA else v

# A list of JSON records → data.frame (union of the keys, NULL → NA; values
# that are not scalars stay in a list column).
.sc_records_df <- function(records, fields = NULL) {
  if (!length(records)) {
    out <- as.data.frame(stats::setNames(replicate(length(fields), logical(), simplify = FALSE), fields), stringsAsFactors = FALSE)
    return(out)
  }
  if (is.null(fields)) fields <- unique(unlist(lapply(records, names)))
  cols <- lapply(fields, function(f) {
    vals <- lapply(records, function(r) .sc_or_na(r[[f]]))
    if (all(vapply(vals, function(v) is.atomic(v) && length(v) == 1, logical(1)))) unlist(vals) else vals
  })
  out <- stats::setNames(cols, fields)
  out <- as.data.frame(lapply(out, function(v) if (is.list(v)) I(v) else v), stringsAsFactors = FALSE, check.names = FALSE)
  names(out) <- fields
  out
}

.sc_council_synth <- function(run) {
  s <- run$summary
  if (is.null(s)) s <- list()
  results <- run$councilResults
  if (is.null(results)) results <- list()
  fmt <- function(v) if (is.null(v)) NA_character_ else as.character(v)
  measure <- c("trust (support)", "distrust (oppose)", "uncertain (abstain)", "consensus score", "agents")
  value <- c(fmt(s$supportPct), fmt(s$opposePct), fmt(s$abstainPct), fmt(s$consensusScore), as.character(length(results)))
  risks <- utils::head(s$topRisks, 8)
  for (i in seq_along(risks)) {
    measure <- c(measure, sprintf("risk %d (%s)", i, fmt(risks[[i]]$count)))
    value <- c(value, fmt(risks[[i]]$risk))
  }
  caps <- utils::head(s$topCaptures, 5)
  for (i in seq_along(caps)) {
    measure <- c(measure, sprintf("captures %d (%s)", i, fmt(caps[[i]]$count)))
    value <- c(value, fmt(caps[[i]]$risk))
  }
  votes <- .sc_records_df(lapply(results, function(c) list(
    agent = c$agent$id, profession = c$agent$profession, mbti = c$agent$mbti, gender = c$agent$gender,
    stance = c$finalStance, confidence = c$finalConfidence, key_risk = c$keyRisk, intervention = c$intervention$param
  )), c("agent", "profession", "mbti", "gender", "stance", "confidence", "key_risk", "intervention"))
  inter <- .sc_records_df(lapply(s$interventionClusters, function(c) list(param = c$param, direction = c$direction, magnitude = c$magnitude, count = c$count, rationale = c$exemplarRationale)),
                          c("param", "direction", "magnitude", "count", "rationale"))
  wm <- run$wmtr
  scen <- run$scenarioSummary
  if (is.null(scen) || !nzchar(scen)) scen <- substr(if (is.null(run$scenario)) "" else run$scenario, 1, 80)
  notes <- sprintf("Run %s · status %s · %s", fmt(run$id), fmt(run$status), scen)
  if (length(wm)) notes <- c(notes, sprintf("WMTR evidence: dominant outcome %s, driver %s.", fmt(wm$dominantOutcome), fmt(wm$driver)))
  dis <- s$dissentingAgentIds
  if (length(dis)) notes <- c(notes, sprintf("%d dissenting agents (highest confidence first): %s…", length(dis), paste(utils::head(dis, 5), collapse = ", ")))
  t <- sc_table(data.frame(measure = measure, value = value, stringsAsFactors = FALSE), title = sprintf("Council synthesis · %d agents", nrow(votes)),
                basis = sprintf("swarm %s · run %s", sc_swarm_url(), fmt(run$id)), stage = "hard", notes = notes)
  trust <- if (is.null(s$supportPct)) NA_real_ else as.numeric(s$supportPct)
  structure(list(run_id = fmt(run$id), summary = t, votes = votes, interventions = inter, run = run, trust = trust), class = c("scelo_council", "list"))
}

#' @param x A `scelo_council` to print.
#' @param ... Passed to the summary table's print method.
#' @rdname sc_council
#' @export
print.scelo_council <- function(x, ...) {
  print(x$summary, ...)
  invisible(x)
}

.sc_poll_run <- function(run_id, limit = Inf, poll = 2, what = "council run") {
  t0 <- proc.time()[["elapsed"]]
  repeat {
    run <- .sc_swarm_request("GET", paste0("/api/run/", run_id), timeout = 30)
    if (identical(run$status, "complete") && length(run$summary)) return(.sc_council_synth(run))
    if (identical(run$status, "failed")) .sc_swarm_error(sprintf("%s %s failed: %s", what, run_id, if (is.null(run$error)) "" else run$error))
    if (proc.time()[["elapsed"]] - t0 > limit) {
      .sc_swarm_error(sprintf("council run %s still %s after %.0fs; fetch later with sc_council_run('%s')", run_id, if (is.null(run$status)) "?" else run$status, limit, run_id))
    }
    Sys.sleep(poll)
  }
}

#' Convene the council
#'
#' Convene the stratified professional council on a scenario; returns the
#' `scelo_council` (or the run id when `wait = FALSE`). `subset` is the
#' number of agents (stratified across the 8 professions; at most 256);
#' `society` the size of the sentiment society to poll as well (0 skips it).
#' The run takes minutes with a cloud provider and longer on a local model.
#' @param scenario Scenario text.
#' @param subset Agents to convene.
#' @param society Society size polled alongside (0 = none).
#' @param wait Poll until complete (`TRUE`) or return the run id.
#' @param timeout Seconds to wait (default: 5 to 45 minutes, scaled to the run).
#' @param poll Seconds between polls.
#' @param jurisdiction Legal jurisdiction code.
#' @param canon Optional canon text.
#' @param fresh Bypass the server cache.
#' @param wmtr Inject the WMTR evidence.
#' @param justify_all Ask every agent for a cited justification.
#' @param provider Provider name for council, society and chat.
#' @return A `scelo_council`: `run_id`, `summary` (a `scelo_table`), `votes`,
#'   `interventions`, `run` (the raw run), `trust`; or the run id.
#' @examples
#' \dontrun{
#' cr <- sc_council("pension scheme with a weakening sponsor covenant", subset = 16)
#' cr$summary
#' }
#' @export
sc_council <- function(scenario, subset = 32, society = 0, wait = TRUE, timeout = NULL, poll = 2, jurisdiction = "ZA", canon = NULL, fresh = FALSE,
                       wmtr = TRUE, justify_all = FALSE, provider = NULL) {
  subset <- max(1L, min(as.integer(subset), SC_COUNCIL_SIZE))
  body <- list(scenario = scenario, subset = subset, societySize = as.integer(society), fresh = isTRUE(fresh), legalJurisdiction = jurisdiction,
               wmtrEnabled = isTRUE(wmtr), justifyAll = isTRUE(justify_all))
  if (!is.null(canon) && nzchar(canon)) body$canon <- canon
  if (!is.null(provider) && nzchar(provider)) body$providerPrefs <- list(councilProvider = provider, societyProvider = provider, chatProvider = provider)
  resp <- .sc_swarm_request("POST", "/api/run", body)
  run_id <- as.character(resp$runId)
  .sc_record("sc_council", list(scenario = substr(scenario, 1, 80), subset = subset, society = society), NULL, NULL, 0, note = run_id)
  if (!wait) return(run_id)
  limit <- if (!is.null(timeout)) timeout else min(45 * 60, max(5 * 60, subset * 10 + (if (society > 0) 12 * 60 else 0)))
  .sc_poll_run(run_id, limit, poll)
}

#' Fetch a council run
#'
#' Fetch a (completed) council run by id.
#' @param run_id The run id returned by [sc_council()].
#' @return A `scelo_council`.
#' @examples
#' \dontrun{
#' sc_council_run("run_123")
#' }
#' @export
sc_council_run <- function(run_id) {
  run <- .sc_swarm_request("GET", paste0("/api/run/", run_id), timeout = 30)
  .sc_council_synth(run)
}

#' Apply an intervention to a council run
#'
#' Apply a WMTR intervention to a run: re-run the forecast and (by default)
#' reconvene the council on it.
#' @param run_id The run id.
#' @param param One of [SC_INTERVENTION_PARAMS].
#' @param direction `"increase"` or `"decrease"`.
#' @param magnitude `"small"` or `"large"`.
#' @param rationale Free text recorded with the intervention.
#' @param recouncil Reconvene the council on the new forecast.
#' @param subset Agents for the reconvened council.
#' @param wait Poll until the new run completes.
#' @return A `scelo_council` (or the new run id when `wait = FALSE`); the
#'   WMTR payload when `recouncil = FALSE`.
#' @examples
#' \dontrun{
#' sc_intervene("run_123", "pFamily", "increase", "large", recouncil = FALSE)
#' }
#' @export
sc_intervene <- function(run_id, param, direction = "increase", magnitude = "small", rationale = "", recouncil = TRUE, subset = NULL, wait = TRUE) {
  body <- list(intervention = list(param = param, direction = direction, magnitude = magnitude, rationale = rationale), recouncil = isTRUE(recouncil))
  if (!is.null(subset)) body$subset <- as.integer(subset)
  resp <- .sc_swarm_request("POST", sprintf("/api/run/%s/intervene", run_id), body, timeout = 120)
  if (!recouncil) return(if (is.null(resp$wmtr)) resp else resp$wmtr)
  new_id <- as.character(resp$runId)
  if (!wait) return(new_id)
  .sc_poll_run(new_id, Inf, 2, what = "run")
}

#' An agent's justification
#'
#' An agent's (or `group:<Profession>`'s) cited justification of its vote.
#' @param run_id The run id.
#' @param agent Agent id, or `"group:Actuary"` for a profession.
#' @param fresh Bypass the cache.
#' @param jurisdiction Legal jurisdiction code.
#' @return The justification payload (a list).
#' @examples
#' \dontrun{
#' sc_justify("run_123", "group:Actuary")
#' }
#' @export
sc_justify <- function(run_id, agent, fresh = FALSE, jurisdiction = "ZA") {
  body <- list(fresh = isTRUE(fresh), legalJurisdiction = jurisdiction)
  if (startsWith(agent, "group:")) {
    return(.sc_swarm_request("POST", sprintf("/api/run/%s/group/%s/justify", run_id, substring(agent, 7)), body, timeout = 300))
  }
  .sc_swarm_request("POST", sprintf("/api/run/%s/agents/%s/justify", run_id, agent), body, timeout = 300)
}

#' The swarm's chat log
#'
#' The swarm's audit transcript (every LLM exchange), newest last.
#' @param since Only entries after this timestamp (ms).
#' @param limit Maximum entries.
#' @return A data frame.
#' @examples
#' \dontrun{
#' sc_chat_log(limit = 20)
#' }
#' @export
sc_chat_log <- function(since = NULL, limit = 500) {
  q <- sprintf("?limit=%d", as.integer(limit))
  if (!is.null(since)) q <- paste0(q, sprintf("&since=%.0f", as.numeric(since)))
  resp <- .sc_swarm_request("GET", paste0("/api/chat-log", q), timeout = 30)
  .sc_records_df(resp$entries)
}

# ── WMTR on the server ────────────────────────────────────────────────────

#' WMTR on the swarm server
#'
#' Run the WMTR forecast on the swarm server (its scenario heuristic);
#' returns the payload with `config`, `result` and the evidence block.
#' [sc_run_wmtr()] on the returned `config` reproduces `result` locally.
#' @param scenario Scenario text.
#' @param ... Parameter overrides (engine names).
#' @return A list: `config`, `result` (`meanW`, `p10W`, ..., `outcomeFractions`,
#'   `dominant`, `w0`), `evidence`, `dominantOutcome`, `driver`.
#' @examples
#' \dontrun{
#' remote <- sc_swarm_wmtr("rural village facing a severe drought")
#' local <- sc_run_wmtr(do.call(sc_wmtr_params, remote$config))
#' }
#' @export
sc_swarm_wmtr <- function(scenario, ...) {
  overrides <- list(...)
  .sc_swarm_request("POST", "/api/wmtr", list(scenario = scenario, overrides = if (length(overrides)) overrides else .sc_json_obj()), timeout = 120)
}

# ── society simulation ────────────────────────────────────────────────────

.sc_big <- function(x, digits = 0) {
  x <- suppressWarnings(as.numeric(x))
  if (!length(x) || is.na(x)) x <- 0
  formatC(x, format = "f", digits = digits, big.mark = ",")
}

#' Simulate a society
#'
#' Simulate a population's response to a scenario: one row per agent (25
#' columns) plus the macro roll-up as attributes. `size` 20 to 2000 agents;
#' send the echoed `seed` back to reproduce a run exactly. Failed agents are
#' flagged in `sim_status` and excluded from the macro figures
#' (`attr(, "macro")`, with `attr(, "macro_provenance")`).
#' @param scenario Scenario text.
#' @param size Agents to simulate.
#' @param seed Seed (echoed by the server).
#' @param drugs Optional drug names.
#' @param population Population the sample scales to.
#' @param concurrency Server-side concurrency.
#' @param fresh Bypass the cache.
#' @param timeout Seconds to allow for the stream.
#' @param progress Print progress as agents complete.
#' @return A `scelo_table` of agents with attributes `macro`, `macro_provenance`, `seed`, `refs`.
#' @examples
#' \dontrun{
#' soc <- sc_society("fuel price shock in Gauteng", size = 50)
#' attr(soc, "macro")
#' }
#' @export
sc_society <- function(scenario, size = 200, seed = NULL, drugs = NULL, population = NULL, concurrency = NULL, fresh = FALSE, timeout = 3600, progress = FALSE) {
  body <- list(scenario = scenario, sampleSize = as.integer(size), fresh = isTRUE(fresh), stream = TRUE)
  if (!is.null(seed)) body$seed <- as.integer(seed)
  if (length(drugs)) body$drugs <- as.list(as.character(drugs))
  if (!is.null(population)) body$population <- as.integer(population)
  if (!is.null(concurrency)) body$concurrency <- as.integer(concurrency)
  result <- NULL
  on_event <- function(ev) {
    kind <- ev$type
    if (identical(kind, "sim_progress") && progress) cat(sprintf("\r  society · %s/%s", ev$done, ev$total))
    else if (identical(kind, "result")) result <<- ev
    else if (identical(kind, "error")) .sc_swarm_error(if (is.null(ev$message)) "simulation failed" else ev$message)
  }
  .sc_sse("POST", "/api/simulate", body, timeout, on_event)
  if (progress) cat("\n")
  if (is.null(result)) .sc_swarm_error("the simulation stream ended without a result")
  rows <- .sc_records_df(result$rows)
  macro <- result$macro
  if (is.null(macro)) macro <- list()
  failed <- if (is.null(macro$failedCount)) 0L else as.integer(macro$failedCount)
  t <- sc_table(rows, title = sprintf("Society simulation · %d agents · seed %s", nrow(rows), .sc_or_na(result$seed)),
                basis = sprintf("swarm %s · population %s", sc_swarm_url(), .sc_big(result$population)), stage = "hard", notes = c(
    sprintf("Macro (scaled × %s): workdays lost %s, GDP drag ZAR %s, admissions %s, excess mortality %s, insurer claims ZAR %s.",
            .sc_big(macro$scaleFactor), .sc_big(macro$workdaysLostTotal), .sc_big(macro$gdpDragZar), .sc_big(macro$hospitalAdmissions), .sc_big(macro$excessMortality, 1), .sc_big(macro$insurerClaimsZar)),
    if (failed) sprintf("%d agent(s) failed and are excluded from every macro figure (see sim_status).", failed) else "All agents answered.",
    sprintf("Reproduce with seed=%s.", .sc_or_na(result$seed))
  ))
  attr(t, "macro") <- macro
  attr(t, "macro_provenance") <- result$macroProvenance
  attr(t, "seed") <- result$seed
  attr(t, "refs") <- result$refs
  .sc_record("sc_society", list(scenario = substr(scenario, 1, 80), size = size, seed = .sc_or_na(result$seed)), NULL, rows, 0)
  t
}

#' Augment rows with simulated outcomes
#'
#' Attach simulated outcome columns (`sim_*`) to your own rows by age / sex /
#' comorbidity bucket from a reference cohort.
#' @param df A data frame (at most 100,000 rows).
#' @param scenario Scenario text.
#' @param sample_size Reference cohort size.
#' @param seed Seed.
#' @param drugs Optional drug names.
#' @param fresh Bypass the cache.
#' @param timeout Seconds to allow for the stream.
#' @return A `scelo_table` of the augmented rows with attributes `seed`, `failed`.
#' @examples
#' \dontrun{
#' sc_augment(sc_sample("claims"), "fuel price shock", sample_size = 100)
#' }
#' @export
sc_augment <- function(df, scenario, sample_size = 400, seed = NULL, drugs = NULL, fresh = FALSE, timeout = 3600) {
  if (nrow(df) > 100000) stop("augment is capped at 100,000 rows (the IDE's limit)", call. = FALSE)
  body <- list(scenario = scenario, rows = as.data.frame(df), sampleSize = as.integer(sample_size), fresh = isTRUE(fresh), stream = TRUE)
  if (!is.null(seed)) body$seed <- as.integer(seed)
  if (length(drugs)) body$drugs <- as.list(as.character(drugs))
  result <- NULL
  on_event <- function(ev) {
    if (identical(ev$type, "result")) result <<- ev
    else if (identical(ev$type, "error")) .sc_swarm_error(if (is.null(ev$message)) "augment failed" else ev$message)
  }
  .sc_sse("POST", "/api/simulate/augment", body, timeout, on_event)
  if (is.null(result)) .sc_swarm_error("the augment stream ended without a result")
  out <- .sc_records_df(result$rows)
  t <- sc_table(out, title = sprintf("Augmented · %d rows · %d new columns", nrow(out), length(result$augmentedColumns)),
                basis = sprintf("reference cohort %s agents (%s) · seed %s", .sc_or_na(result$sampleSize), .sc_or_na(result$referenceWeighting), .sc_or_na(result$seed)), stage = "hard", notes =
    "Outcomes are per-bucket medians / modes from an age-balanced reference cohort, matched on age10 + sex + comorbidity and degrading to coarser buckets (sim_bucket_match says which).")
  attr(t, "seed") <- result$seed
  attr(t, "failed") <- result$failedCount
  t
}
