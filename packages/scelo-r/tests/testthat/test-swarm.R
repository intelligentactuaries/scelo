# The swarm client. Offline: the synthesis, the SSE parser, the request layer
# against a tiny mock of the swarm API (a python3 http.server started for the
# test, skipped when python3 is absent). Live (skipped when no swarm answers on
# 127.0.0.1:3010): health, providers and /api/wmtr only; no council or society
# runs are started.

swarm_up <- function() {
  if (!requireNamespace("curl", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) return(FALSE)
  sc_connect(NULL)
  tryCatch(isTRUE(sc_swarm_status()$ok), error = function(e) FALSE)
}

MOCK_SWARM_PY <- '
import json, sys, time, socket, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

calls = {"r1": 0}
SUMMARY = {"supportPct": 0.6, "opposePct": 0.3, "abstainPct": 0.1, "consensusScore": 0.5,
           "topRisks": [{"risk": "sponsor default", "count": 9}], "topCaptures": [],
           "interventionClusters": [{"param": "pFamily", "direction": "increase", "magnitude": "small", "count": 5, "exemplarRationale": "because"}],
           "dissentingAgentIds": ["a2"]}
RESULTS = [{"agent": {"id": "a1", "profession": "Actuary", "mbti": "INTJ", "gender": "F"}, "finalStance": "support", "finalConfidence": 0.8, "keyRisk": "x", "intervention": {"param": "pFamily"}},
           {"agent": {"id": "a2", "profession": "Lawyer", "mbti": "ENTP", "gender": "M"}, "finalStance": "oppose", "finalConfidence": 0.6, "keyRisk": "y"}]

def run(rid, status):
    r = {"id": rid, "status": status, "scenario": "mock scenario " * 10, "councilResults": RESULTS, "wmtr": {"dominantOutcome": "declined", "driver": "M"}}
    if status == "complete":
        r["summary"] = SUMMARY
    return r

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *a):
        pass
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def _sse(self, events):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b": heartbeat\\n\\n")
        self.wfile.flush()
        for ev in events:
            time.sleep(0.05)
            self.wfile.write(("data: " + json.dumps(ev) + "\\n\\n").encode())
            self.wfile.flush()
    def do_GET(self):
        p = self.path
        if p == "/api/health":
            return self._json({"ok": True})
        if p == "/api/providers":
            return self._json({"configured": {"mock": True}})
        if p == "/api/run/r1":
            calls["r1"] += 1
            return self._json(run("r1", "running" if calls["r1"] < 2 else "complete"))
        if p == "/api/run/r2":
            return self._json(run("r2", "complete"))
        if p == "/api/run/slow":
            return self._json(run("slow", "running"))
        if p == "/api/run/bad":
            return self._json({"id": "bad", "status": "failed", "error": "provider down"})
        if p.startswith("/api/chat-log"):
            return self._json({"entries": [{"at": 1, "role": "user", "text": "hi"}, {"at": 2, "role": "assistant", "text": "yo", "model": "m"}], "q": p})
        if p == "/shutdown":
            self._json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        return self._json({"error": "not found"}, 404)
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        p = self.path
        if p == "/api/run":
            return self._json({"runId": "r1", "echo": body})
        if p == "/api/run/r1/intervene":
            if not body.get("recouncil", True):
                return self._json({"wmtr": {"dominantOutcome": "stabilized", "intervention": body["intervention"]}})
            return self._json({"runId": "r2"})
        if p.endswith("/justify"):
            return self._json({"path": p, "fresh": body.get("fresh")})
        if p == "/api/wmtr":
            return self._json({"config": {"seed": 1}, "overrides": body.get("overrides")})
        if p == "/api/simulate":
            if body.get("scenario") == "fail":
                return self._sse([{"type": "sim_progress", "done": 1, "total": 2}, {"type": "error", "message": "boom"}])
            rows = [{"id": i, "age": 30 + i, "sim_status": "ok"} for i in range(body.get("sampleSize", 3))]
            return self._sse([{"type": "sim_progress", "done": 1, "total": 3}, {"type": "sim_progress", "done": 3, "total": 3},
                              {"type": "result", "rows": rows, "seed": body.get("seed", 7), "population": 60000000,
                               "macro": {"scaleFactor": 20000, "workdaysLostTotal": 1234567, "gdpDragZar": 9876543.21, "hospitalAdmissions": 12, "excessMortality": 1.25, "insurerClaimsZar": 100, "failedCount": 1},
                               "macroProvenance": [{"metric": "gdp", "source": "mock"}], "refs": ["ref1"]}])
        if p == "/api/simulate/augment":
            rows = [dict(r, sim_outcome="ok", sim_bucket_match="age10+sex") for r in body.get("rows", [])]
            return self._sse([{"type": "result", "rows": rows, "augmentedColumns": ["sim_outcome", "sim_bucket_match"], "sampleSize": body.get("sampleSize"),
                               "referenceWeighting": "age-balanced", "seed": 11, "failedCount": 0}])
        if p == "/api/boom":
            return self._json({"error": "nope"}, 500)
        return self._json({"error": "not found"}, 404)

srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[1], "w") as f:
    f.write(str(srv.server_address[1]))
timer = threading.Timer(90, srv.shutdown)
timer.daemon = True
timer.start()
srv.serve_forever()
'

start_mock_swarm <- function() {
  skip_if_not_installed("curl")
  skip_if_not_installed("jsonlite")
  skip_if(!nzchar(Sys.which("python3")), "python3 is not available for the mock swarm")
  script <- tempfile(fileext = ".py")
  writeLines(MOCK_SWARM_PY, script)
  portfile <- tempfile()
  system2("python3", c(shQuote(script), shQuote(portfile)), wait = FALSE, stdout = FALSE, stderr = FALSE)
  port <- NA
  for (i in 1:100) {
    if (file.exists(portfile)) {
      v <- suppressWarnings(readLines(portfile, warn = FALSE))
      if (length(v) && nzchar(v[1])) { port <- as.integer(v[1]); break }
    }
    Sys.sleep(0.05)
  }
  skip_if(is.na(port), "the mock swarm did not start")
  sc_connect(sprintf("http://127.0.0.1:%d", port))
  port
}

stop_mock_swarm <- function() {
  try(.sc_swarm_request("GET", "/shutdown", timeout = 5), silent = TRUE)
  sc_connect(NULL)
}

test_that("connect and the base URL", {
  expect_identical(sc_connect("http://example.org:3010/"), "http://example.org:3010")
  expect_identical(sc_swarm_url(), "http://example.org:3010")
  old <- Sys.getenv("SCELO_SWARM_URL", unset = NA)
  Sys.setenv(SCELO_SWARM_URL = "http://env-host:1/")
  expect_identical(sc_connect(NULL), "http://env-host:1")
  if (is.na(old)) Sys.unsetenv("SCELO_SWARM_URL") else Sys.setenv(SCELO_SWARM_URL = old)
  expect_identical(sc_connect(NULL), "http://127.0.0.1:3010")
  expect_length(SC_PROFESSIONS, 8)
  expect_identical(SC_COUNCIL_SIZE, 256L)
})

test_that("the council synthesis and the SSE parser work offline", {
  skip_if_not_installed("jsonlite")
  run <- list(id = "r1", status = "complete", scenario = "a long scenario", summary = list(
    supportPct = 0.6, opposePct = 0.3, abstainPct = 0.1, consensusScore = 0.5,
    topRisks = list(list(risk = "sponsor default", count = 9), list(risk = "inflation", count = 4)), topCaptures = list(list(risk = "regulatory capture", count = 2)),
    interventionClusters = list(list(param = "pFamily", direction = "increase", magnitude = "small", count = 5, exemplarRationale = "because")), dissentingAgentIds = c("a1", "a2")),
    councilResults = list(
      list(agent = list(id = "a1", profession = "Actuary", mbti = "INTJ", gender = "F"), finalStance = "support", finalConfidence = 0.8, keyRisk = "x", intervention = list(param = "pFamily")),
      list(agent = list(id = "a2", profession = "Lawyer", mbti = "ENTP", gender = "M"), finalStance = "oppose", finalConfidence = 0.6, keyRisk = "y")),
    wmtr = list(dominantOutcome = "declined", driver = "M"))
  cr <- .sc_council_synth(run)
  expect_s3_class(cr, "scelo_council")
  expect_identical(cr$run_id, "r1")
  expect_equal(cr$trust, 0.6)
  expect_s3_class(cr$summary, "scelo_table")
  expect_identical(cr$summary$measure, c("trust (support)", "distrust (oppose)", "uncertain (abstain)", "consensus score", "agents", "risk 1 (9)", "risk 2 (4)", "captures 1 (2)"))
  expect_identical(cr$summary$value, c("0.6", "0.3", "0.1", "0.5", "2", "sponsor default", "inflation", "regulatory capture"))
  expect_identical(sc_title(cr$summary), "Council synthesis · 2 agents")
  expect_identical(sc_notes(cr$summary), c("Run r1 · status complete · a long scenario", "WMTR evidence: dominant outcome declined, driver M.", "2 dissenting agents (highest confidence first): a1, a2…"))
  expect_identical(names(cr$votes), c("agent", "profession", "mbti", "gender", "stance", "confidence", "key_risk", "intervention"))
  expect_identical(cr$votes$intervention, c("pFamily", NA))
  expect_identical(cr$votes$confidence, c(0.8, 0.6))
  expect_identical(cr$interventions$param, "pFamily")
  expect_identical(cr$interventions$count, 5)
  expect_output(print(cr), "Council synthesis · 2 agents")
  # an empty run still synthesises
  e <- .sc_council_synth(list(id = "x", status = "running"))
  expect_identical(nrow(e$votes), 0L)
  expect_true(is.na(e$trust))
  expect_identical(e$summary$value[5], "0")
  ev <- .sc_parse_sse_lines(c(": heartbeat", "", "data: {\"type\":\"sim_progress\",\"done\":1,\"total\":2}", "data: {\"type\":\"result\",\"rows\":[{\"a\":1,\"b\":\"x\"},{\"a\":2}]}", "data: not json"))
  expect_length(ev, 2)
  expect_identical(ev[[2]]$type, "result")
  expect_identical(.sc_records_df(ev[[2]]$rows)$b, c("x", NA))
  expect_identical(as.character(.sc_to_json(list(scenario = "s", overrides = .sc_json_obj()))), "{\"scenario\":\"s\",\"overrides\":{}}")
  expect_error(sc_augment(data.frame(x = seq_len(100001)), "s"), "augment is capped at 100,000 rows")
})

test_that("the request layer, polling and the event stream against a mock swarm", {
  start_mock_swarm()
  on.exit(stop_mock_swarm(), add = TRUE)
  st <- sc_swarm_status()
  expect_true(st$ok)
  expect_true(isTRUE(st$providers$configured$mock))
  expect_error(.sc_swarm_request("POST", "/api/boom", list()), class = "scelo_swarm_error")
  expect_error(.sc_swarm_request("POST", "/api/boom", list()), "POST /api/boom → 500: nope")
  expect_error(.sc_swarm_request("GET", "/api/nothing"), "GET /api/nothing → 404: not found")
  # council: POST then poll (first poll running, second complete)
  sc_clear_audit()
  cr <- sc_council("mock scenario", subset = 4, poll = 0.05)
  expect_s3_class(cr, "scelo_council")
  expect_identical(cr$run_id, "r1")
  expect_equal(cr$trust, 0.6)
  expect_identical(cr$votes$agent, c("a1", "a2"))
  expect_identical(sc_audit()$fn, "sc_council")
  expect_identical(sc_audit()$note, "r1")
  expect_identical(sc_council("mock scenario", wait = FALSE), "r1")
  expect_identical(sc_council_run("r2")$run_id, "r2")
  expect_error(sc_council_run("bad"), NA)
  expect_error(.sc_poll_run("bad", poll = 0.01), "council run bad failed: provider down")
  expect_error(.sc_poll_run("slow", limit = 0, poll = 0.01), "council run slow still running after 0s; fetch later with sc_council_run\\('slow'\\)")
  # interventions and justifications
  wm <- sc_intervene("r1", "pFamily", "increase", "large", recouncil = FALSE)
  expect_identical(wm$dominantOutcome, "stabilized")
  expect_identical(wm$intervention$magnitude, "large")
  expect_identical(sc_intervene("r1", "pFamily", wait = FALSE), "r2")
  expect_identical(sc_intervene("r1", "pFamily")$run_id, "r2")
  expect_identical(sc_justify("r1", "a1")$path, "/api/run/r1/agents/a1/justify")
  expect_identical(sc_justify("r1", "group:Actuary", fresh = TRUE)$path, "/api/run/r1/group/Actuary/justify")
  expect_true(sc_justify("r1", "group:Actuary", fresh = TRUE)$fresh)
  # chat log → data frame (union of keys)
  log <- sc_chat_log(limit = 5, since = 1)
  expect_identical(names(log), c("at", "role", "text", "model"))
  expect_identical(log$model, c(NA, "m"))
  expect_identical(sc_swarm_wmtr("s", nPaths = 3)$overrides$nPaths, 3L)
  expect_null(sc_swarm_wmtr("s")$overrides$nPaths)
  # society over the event stream
  sc_clear_audit()
  soc <- sc_society("mock", size = 3, seed = 5, drugs = "x", population = 60000000, concurrency = 2)
  expect_s3_class(soc, "scelo_table")
  expect_identical(nrow(soc), 3L)
  expect_equal(soc$age, c(30, 31, 32))
  expect_identical(sc_title(soc), "Society simulation · 3 agents · seed 5")
  expect_identical(sc_basis(soc), sprintf("swarm %s · population 60,000,000", sc_swarm_url()))
  expect_identical(sc_notes(soc)[1], "Macro (scaled × 20,000): workdays lost 1,234,567, GDP drag ZAR 9,876,543, admissions 12, excess mortality 1.2, insurer claims ZAR 100.")
  expect_identical(sc_notes(soc)[2], "1 agent(s) failed and are excluded from every macro figure (see sim_status).")
  expect_identical(sc_notes(soc)[3], "Reproduce with seed=5.")
  expect_identical(attr(soc, "macro")$failedCount, 1L)
  expect_identical(attr(soc, "macro_provenance")[[1]]$source, "mock")
  expect_identical(attr(soc, "refs"), "ref1")
  expect_identical(sc_audit()$fn, "sc_society")
  expect_output(soc2 <- sc_society("mock", size = 2, progress = TRUE), "society · 3/3")
  expect_identical(nrow(soc2), 2L)
  expect_error(sc_society("fail"), class = "scelo_swarm_error")
  expect_error(sc_society("fail"), "boom")
  # augment
  aug <- sc_augment(data.frame(age = c(40, 50), sex = c("F", "M")), "mock", sample_size = 100)
  expect_identical(nrow(aug), 2L)
  expect_identical(aug$sim_outcome, c("ok", "ok"))
  expect_identical(aug$sex, c("F", "M"))
  expect_identical(sc_title(aug), "Augmented · 2 rows · 2 new columns")
  expect_identical(sc_basis(aug), "reference cohort 100 agents (age-balanced) · seed 11")
  expect_identical(attr(aug, "seed"), 11L)
})

test_that("an unreachable swarm raises a scelo_swarm_error", {
  skip_if_not_installed("curl")
  skip_if_not_installed("jsonlite")
  sc_connect("http://127.0.0.1:1")
  on.exit(sc_connect(NULL), add = TRUE)
  expect_error(sc_swarm_status(), class = "scelo_swarm_error")
  expect_error(sc_swarm_status(), "cannot reach the swarm at http://127.0.0.1:1")
})

test_that("live: the server's WMTR matches the local engine", {
  skip_if_not(swarm_up(), "swarm not running on 127.0.0.1:3010")
  remote <- sc_swarm_wmtr("rural village facing a severe drought")
  local <- sc_run_wmtr(do.call(sc_wmtr_params, remote$config))
  expect_close(local$table$mean_W, remote$result$meanW, tol = 1e-9)
  expect_close(local$table$survival, remote$result$meanSurv, tol = 1e-9)
  kinds <- c("grew", "stabilized", "declined", "collapsed")
  expect_identical(unname(unlist(local$outcome_fractions[kinds])), unname(as.numeric(unlist(remote$result$outcomeFractions[kinds]))))
  expect_identical(local$dominant, remote$result$dominant)
  expect_identical(sc_derive_config("rural village facing a severe drought")$seed, as.numeric(remote$config$seed))
  st <- sc_swarm_status()
  expect_true(st$ok)
  expect_true(is.list(st$providers))
})
