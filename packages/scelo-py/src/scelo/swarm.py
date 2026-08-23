"""Swarm: the client for Scelo's decision-support cockpit (apps/swarm).

Scelo IDE starts the swarm with the app on loopback port 3010; the same
server runs standalone with ``bun run dev:swarm``. This module talks to its
HTTP API with nothing but the standard library:

* ``council(scenario)``      convene the stratified professional council
                             (8 professions × 16 MBTI × 2) over a scenario,
                             with the WMTR evidence injected, and read back
                             trust / distrust / uncertainty, risk clusters and
                             recommended interventions;
* ``society(scenario)``      simulate an SA-anchored population's behaviour,
                             health and economic outcomes, with the macro
                             roll-up and its provenance;
* ``augment(df, scenario)``  attach simulated outcome columns to your own rows;
* ``swarm_wmtr(scenario)``   run the WMTR forecast on the server (the local
                             :func:`scelo.wmtr` is the same engine).

There is no authentication: the server trusts its loopback. Point
``connect()`` (or ``SCELO_SWARM_URL``) elsewhere to use a remote swarm.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence, Union

import pandas as pd

from ._audit import record
from ._table import Table

__all__ = [
    "connect", "swarm_url", "swarm_status", "council", "council_run", "society", "augment", "swarm_wmtr", "intervene", "justify",
    "chat_log", "CouncilResult", "SwarmError", "PROFESSIONS", "COUNCIL_SIZE",
]

PROFESSIONS = ["Finance", "Investor", "Accountant", "Actuary", "Psychologist", "ConspiracyTheorist", "Lawyer", "SocialMediaInfluencer"]
COUNCIL_SIZE = 256
_DEFAULT_URL = "http://127.0.0.1:3010"
_BASE: Optional[str] = None


class SwarmError(RuntimeError):
    """The swarm could not be reached or returned an error."""


def connect(url: Optional[str] = None) -> str:
    """Set (or reset) the swarm base URL; returns it. Default: $SCELO_SWARM_URL or http://127.0.0.1:3010."""
    global _BASE
    _BASE = (url or os.environ.get("SCELO_SWARM_URL") or _DEFAULT_URL).rstrip("/")
    return _BASE


def swarm_url() -> str:
    return _BASE or connect()


def _request(method: str, path: str, body: Any = None, timeout: float = 30.0) -> Any:
    url = swarm_url() + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("error", str(e))
        except Exception:
            msg = str(e)
        raise SwarmError(f"{method} {path} → {e.code}: {msg}") from None
    except (urllib.error.URLError, OSError) as e:
        raise SwarmError(f"cannot reach the swarm at {swarm_url()} ({e}). Start Scelo IDE (it bundles the swarm) or run `bun run dev:swarm`, or connect(url).") from None
    return json.loads(raw.decode()) if raw else None


def _sse(method: str, path: str, body: Any, timeout: float) -> Iterator[Dict[str, Any]]:
    url = swarm_url() + path
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method=method, headers={"content-type": "application/json", "accept": "text/event-stream"})
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        raise SwarmError(f"{method} {path} → {e.code}: {e.read().decode(errors='replace')[:300]}") from None
    except (urllib.error.URLError, OSError) as e:
        raise SwarmError(f"cannot reach the swarm at {swarm_url()} ({e})") from None
    with resp:
        for line in resp:
            s = line.decode("utf-8", errors="replace").strip()
            if not s or s.startswith(":"):
                continue
            if s.startswith("data:"):
                payload = s[5:].strip()
                try:
                    yield json.loads(payload)
                except json.JSONDecodeError:
                    continue


def swarm_status() -> Dict[str, Any]:
    """Health + configured providers of the swarm at :func:`swarm_url`."""
    health = _request("GET", "/api/health", timeout=5)
    providers = _request("GET", "/api/providers", timeout=5)
    return {"url": swarm_url(), "ok": bool(health and health.get("ok")), "providers": providers}


# ── council ───────────────────────────────────────────────────────────────

@dataclass
class CouncilResult:
    """A completed council run: the synthesis table, the interventions, the per-agent votes and the raw run."""

    run_id: str
    summary: Table
    votes: pd.DataFrame
    interventions: pd.DataFrame
    run: Dict[str, Any] = field(default_factory=dict)

    @property
    def trust(self) -> float:
        return float(self.run.get("summary", {}).get("supportPct", float("nan")))

    def __repr__(self) -> str:  # pragma: no cover
        return repr(self.summary)


def _synth(run: Dict[str, Any]) -> CouncilResult:
    s = run.get("summary") or {}
    rows = [
        {"measure": "trust (support)", "value": s.get("supportPct")},
        {"measure": "distrust (oppose)", "value": s.get("opposePct")},
        {"measure": "uncertain (abstain)", "value": s.get("abstainPct")},
        {"measure": "consensus score", "value": s.get("consensusScore")},
        {"measure": "agents", "value": len(run.get("councilResults", []))},
    ]
    for i, r in enumerate(s.get("topRisks", [])[:8]):
        rows.append({"measure": f"risk {i + 1} ({r.get('count')})", "value": r.get("risk")})
    for i, r in enumerate(s.get("topCaptures", [])[:5]):
        rows.append({"measure": f"captures {i + 1} ({r.get('count')})", "value": r.get("risk")})
    votes = pd.DataFrame([{
        "agent": c["agent"]["id"], "profession": c["agent"]["profession"], "mbti": c["agent"]["mbti"], "gender": c["agent"]["gender"],
        "stance": c.get("finalStance"), "confidence": c.get("finalConfidence"), "key_risk": c.get("keyRisk"),
        "intervention": (c.get("intervention") or {}).get("param"),
    } for c in run.get("councilResults", [])])
    inter = pd.DataFrame([{"param": c["param"], "direction": c["direction"], "magnitude": c["magnitude"], "count": c["count"], "rationale": c.get("exemplarRationale")}
                          for c in s.get("interventionClusters", [])])
    wm = run.get("wmtr") or {}
    notes = [f"Run {run.get('id')} · status {run.get('status')} · {run.get('scenarioSummary') or run.get('scenario', '')[:80]}"]
    if wm:
        notes.append(f"WMTR evidence: dominant outcome {wm.get('dominantOutcome')}, driver {wm.get('driver')}.")
    if s.get("dissentingAgentIds"):
        notes.append(f"{len(s['dissentingAgentIds'])} dissenting agents (highest confidence first): {', '.join(s['dissentingAgentIds'][:5])}…")
    t = Table(pd.DataFrame(rows), title=f"Council synthesis · {len(votes)} agents", basis=f"swarm {swarm_url()} · run {run.get('id')}", stage="hard", notes=notes)
    return CouncilResult(str(run.get("id")), t, votes, inter, run)


def council(scenario: str, *, subset: int = 32, society: int = 0, wait: bool = True, timeout: Optional[float] = None, poll: float = 2.0,
            jurisdiction: str = "ZA", canon: Optional[str] = None, fresh: bool = False, wmtr: bool = True, justify_all: bool = False,
            provider: Optional[str] = None) -> Union[CouncilResult, str]:
    """Convene the council on a scenario; returns the :class:`CouncilResult` (or the run id when ``wait=False``).

    ``subset`` = number of agents (stratified across the 8 professions; ≤ 256);
    ``society`` = size of the sentiment society to poll as well (0 skips it).
    The run takes minutes with a cloud provider and longer on a local model.
    """
    subset = max(1, min(int(subset), COUNCIL_SIZE))
    body: Dict[str, Any] = {"scenario": scenario, "subset": subset, "societySize": int(society), "fresh": fresh, "legalJurisdiction": jurisdiction,
                            "wmtrEnabled": wmtr, "justifyAll": justify_all}
    if canon:
        body["canon"] = canon
    if provider:
        body["providerPrefs"] = {"councilProvider": provider, "societyProvider": provider, "chatProvider": provider}
    resp = _request("POST", "/api/run", body)
    run_id = resp["runId"]
    record("council", {"scenario": scenario[:80], "subset": subset, "society": society}, None, None, 0.0, note=run_id)
    if not wait:
        return run_id
    limit = timeout or min(45 * 60, max(5 * 60, subset * 10 + (12 * 60 if society else 0)))
    t0 = time.time()
    while True:
        run = _request("GET", f"/api/run/{run_id}", timeout=30)
        if run.get("status") == "complete" and run.get("summary"):
            return _synth(run)
        if run.get("status") == "failed":
            raise SwarmError(f"council run {run_id} failed: {run.get('error')}")
        if time.time() - t0 > limit:
            raise SwarmError(f"council run {run_id} still {run.get('status')} after {limit:.0f}s; fetch later with council_run('{run_id}')")
        time.sleep(poll)


def council_run(run_id: str) -> CouncilResult:
    """Fetch a (completed) council run by id."""
    run = _request("GET", f"/api/run/{run_id}", timeout=30)
    return _synth(run)


def intervene(run_id: str, param: str, direction: str = "increase", magnitude: str = "small", rationale: str = "", *, recouncil: bool = True,
              subset: Optional[int] = None, wait: bool = True) -> Union[CouncilResult, Dict[str, Any], str]:
    """Apply a WMTR intervention to a run: re-run the forecast and (by default) reconvene the council on it."""
    body: Dict[str, Any] = {"intervention": {"param": param, "direction": direction, "magnitude": magnitude, "rationale": rationale}, "recouncil": recouncil}
    if subset:
        body["subset"] = subset
    resp = _request("POST", f"/api/run/{run_id}/intervene", body, timeout=120)
    if not recouncil:
        return resp.get("wmtr", resp)
    new_id = resp["runId"]
    if not wait:
        return new_id
    while True:
        run = _request("GET", f"/api/run/{new_id}", timeout=30)
        if run.get("status") == "complete" and run.get("summary"):
            return _synth(run)
        if run.get("status") == "failed":
            raise SwarmError(f"run {new_id} failed: {run.get('error')}")
        time.sleep(2.0)


def justify(run_id: str, agent: str, *, fresh: bool = False, jurisdiction: str = "ZA") -> Dict[str, Any]:
    """An agent's (or ``group:<Profession>``'s) cited justification of its vote."""
    if agent.startswith("group:"):
        return _request("POST", f"/api/run/{run_id}/group/{agent[6:]}/justify", {"fresh": fresh, "legalJurisdiction": jurisdiction}, timeout=300)
    return _request("POST", f"/api/run/{run_id}/agents/{agent}/justify", {"fresh": fresh, "legalJurisdiction": jurisdiction}, timeout=300)


def chat_log(since: Optional[int] = None, limit: int = 500) -> pd.DataFrame:
    """The swarm's audit transcript (every LLM exchange), newest-last."""
    q = f"?limit={int(limit)}" + (f"&since={int(since)}" if since else "")
    resp = _request("GET", f"/api/chat-log{q}", timeout=30)
    return pd.DataFrame(resp.get("entries", []))


# ── WMTR on the server ────────────────────────────────────────────────────

def swarm_wmtr(scenario: str, **overrides: Any) -> Dict[str, Any]:
    """Run the WMTR forecast on the swarm server (its scenario heuristic); returns the payload with config, result and the evidence block."""
    return _request("POST", "/api/wmtr", {"scenario": scenario, "overrides": overrides}, timeout=120)


# ── society simulation ────────────────────────────────────────────────────

def society(scenario: str, *, size: int = 200, seed: Optional[int] = None, drugs: Optional[Sequence[str]] = None, population: Optional[int] = None,
            concurrency: Optional[int] = None, fresh: bool = False, timeout: float = 3600.0, progress: bool = False) -> Table:
    """Simulate a population's response to a scenario: one row per agent (25 columns) plus the macro roll-up in ``attrs``.

    ``size`` 20 … 2000 agents; send the echoed ``seed`` back to reproduce a
    run exactly. Failed agents are flagged in ``sim_status`` and excluded
    from the macro figures (``attrs["macro"]``, with ``attrs["provenance"]``).
    """
    body: Dict[str, Any] = {"scenario": scenario, "sampleSize": int(size), "fresh": fresh, "stream": True}
    if seed is not None:
        body["seed"] = int(seed)
    if drugs:
        body["drugs"] = list(drugs)
    if population:
        body["population"] = int(population)
    if concurrency:
        body["concurrency"] = int(concurrency)
    result = None
    for ev in _sse("POST", "/api/simulate", body, timeout):
        kind = ev.get("type")
        if kind == "sim_progress" and progress:
            print(f"\r  society · {ev.get('done')}/{ev.get('total')}", end="", flush=True)
        elif kind == "result":
            result = ev
        elif kind == "error":
            raise SwarmError(ev.get("message", "simulation failed"))
    if progress:
        print()
    if result is None:
        raise SwarmError("the simulation stream ended without a result")
    rows = pd.DataFrame(result.get("rows", []))
    macro = result.get("macro", {})
    failed = int(macro.get("failedCount", 0))
    t = Table(rows, title=f"Society simulation · {len(rows)} agents · seed {result.get('seed')}", basis=f"swarm {swarm_url()} · population {result.get('population'):,}", stage="hard", notes=[
        f"Macro (scaled × {macro.get('scaleFactor', 0):,.0f}): workdays lost {macro.get('workdaysLostTotal', 0):,.0f}, GDP drag ZAR {macro.get('gdpDragZar', 0):,.0f}, admissions {macro.get('hospitalAdmissions', 0):,.0f}, excess mortality {macro.get('excessMortality', 0):,.1f}, insurer claims ZAR {macro.get('insurerClaimsZar', 0):,.0f}.",
        f"{failed} agent(s) failed and are excluded from every macro figure (see sim_status)." if failed else "All agents answered.",
        f"Reproduce with seed={result.get('seed')}.",
    ])
    t.attrs.update(macro=macro, provenance=result.get("macroProvenance", []), seed=result.get("seed"), refs=result.get("refs"))
    record("society", {"scenario": scenario[:80], "size": size, "seed": result.get("seed")}, None, rows, 0.0)
    return t


def augment(df: pd.DataFrame, scenario: str, *, sample_size: int = 400, seed: Optional[int] = None, drugs: Optional[Sequence[str]] = None,
            fresh: bool = False, timeout: float = 3600.0) -> Table:
    """Attach simulated outcome columns (sim_*) to your own rows by age / sex / comorbidity bucket from a reference cohort."""
    if len(df) > 100_000:
        raise ValueError("augment is capped at 100,000 rows (the IDE's limit)")
    body: Dict[str, Any] = {"scenario": scenario, "rows": json.loads(df.to_json(orient="records")), "sampleSize": int(sample_size), "fresh": fresh, "stream": True}
    if seed is not None:
        body["seed"] = int(seed)
    if drugs:
        body["drugs"] = list(drugs)
    result = None
    for ev in _sse("POST", "/api/simulate/augment", body, timeout):
        if ev.get("type") == "result":
            result = ev
        elif ev.get("type") == "error":
            raise SwarmError(ev.get("message", "augment failed"))
    if result is None:
        raise SwarmError("the augment stream ended without a result")
    out = pd.DataFrame(result.get("rows", []))
    t = Table(out, title=f"Augmented · {len(out)} rows · {len(result.get('augmentedColumns', []))} new columns", basis=f"reference cohort {result.get('sampleSize')} agents ({result.get('referenceWeighting')}) · seed {result.get('seed')}", stage="hard", notes=[
        "Outcomes are per-bucket medians / modes from an age-balanced reference cohort, matched on age10 + sex + comorbidity and degrading to coarser buckets (sim_bucket_match says which).",
    ])
    t.attrs.update(seed=result.get("seed"), failed=result.get("failedCount"))
    return t
