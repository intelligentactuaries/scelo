// lifelibPrelude.ts
//
// Python preamble shared by every lifelib-rooted bridge (BasicTerm, IFRS 17
// CSM, Solvency II life SCR). Each bridge's SCRIPT string starts with this so
// they all agree on:
//
//   1. How lifelib is loaded. lifelib (0.14.0) is a *library of modelx
//      models*: `lifelib.create(<library>, <dir>)` copies a library's folder
//      out of site-packages and `modelx.read_model(<dir>/<Model>)` loads a
//      model from it. There is no `from lifelib.libraries.x import Model`.
//      `lifelib_model()` below does the copy once per lifelib version into
//      $SCELO_LIFELIB_HOME (the IDE points that at its userData dir) and
//      reads the model from there.
//   2. How a Scelo model-point Dataset becomes a lifelib model-point frame
//      (`scelo_model_points`) — same column aliases the in-browser TS port
//      accepts (lifelibBasicTerm.ts), sex normalised to 'M'/'F', numeric
//      coercion, bad rows dropped and counted rather than crashing the run.
//   3. How results are reported: JSON on stdout, always carrying
//      `lifelibVersion` / `modelxVersion` so the card can say which lifelib
//      actually ran, and `{"error": ...}` + non-zero exit on failure so the
//      renderer falls back to the in-browser port *and says why*.
//
// The expected version is injected from @scelo/core so this file never
// hard-codes a lifelib release; a mismatch is reported (stderr + JSON field),
// not fatal — the bundled runtime is pinned, but a developer running the
// web build against a system Python should still get a truthful answer.

import { LIFELIB_VERSION, MODELX_VERSION } from "@scelo/core";

export const LIFELIB_PRELUDE = `
import json, os, sys, shutil, math, time, warnings
warnings.filterwarnings("ignore")

EXPECTED_LIFELIB = ${JSON.stringify(LIFELIB_VERSION)}
EXPECTED_MODELX = ${JSON.stringify(MODELX_VERSION)}

def _fail(msg, code=1):
    print(json.dumps({"error": msg}))
    sys.exit(code)

try:
    import lifelib
    import modelx as mx
    import pandas as pd
    import numpy as np
except Exception as e:  # the bundle is broken — say so, don't fake a number
    _fail(f"lifelib stack not importable: {type(e).__name__}: {e}")

LIFELIB_VERSION = getattr(lifelib, "__version__", "?")
MODELX_VERSION = getattr(mx, "__version__", "?")
if LIFELIB_VERSION != EXPECTED_LIFELIB or MODELX_VERSION != EXPECTED_MODELX:
    sys.stderr.write(
        f"[scelo] lifelib {LIFELIB_VERSION} / modelx {MODELX_VERSION} found; "
        f"Scelo is verified against lifelib {EXPECTED_LIFELIB} / modelx {EXPECTED_MODELX}\\n"
    )

def _lifelib_home():
    home = os.environ.get("SCELO_LIFELIB_HOME")
    if not home:
        base = os.environ.get("LOCALAPPDATA") if os.name == "nt" else None
        base = base or os.path.join(os.path.expanduser("~"), ".cache")
        home = os.path.join(base, "scelo", "lifelib")
    return os.path.join(home, LIFELIB_VERSION)

def lifelib_library(lib):
    """Path of a private copy of lifelib library \`lib\` for this lifelib
    version, created on first use (lifelib.create copies the folder)."""
    root = _lifelib_home()
    dest = os.path.join(root, lib)
    if os.path.isdir(dest):
        return dest
    os.makedirs(root, exist_ok=True)
    tmp = dest + ".partial"
    shutil.rmtree(tmp, ignore_errors=True)
    lifelib.create(lib, tmp)
    os.replace(tmp, dest)
    return dest

def lifelib_model(lib, model):
    """mx.read_model of <library>/<model>, e.g. ("basiclife", "BasicTerm_ME")."""
    return mx.read_model(os.path.join(lifelib_library(lib), model))

# ── Scelo Dataset → model-point frame ─────────────────────────────────
MP_ALIASES = {
    "policy_id":    ["policy_id", "policyid", "policy", "id", "model_point_id", "mp_id", "point_id"],
    "age_at_entry": ["age_at_entry", "ageatentry", "issue_age", "issueage", "age"],
    "sex":          ["sex", "gender"],
    "sum_assured":  ["sum_assured", "sumassured", "sa", "face_amount", "face", "benefit"],
    "policy_term":  ["policy_term", "policyterm", "term", "term_years", "policy_term_years"],
    "duration_mth": ["duration_mth", "durationmth", "duration_months", "duration", "dur_mth"],
    "premium_pp":   ["premium_pp", "premiumpp", "premium", "monthly_premium", "prem"],
    "policy_count": ["policy_count", "policycount", "count", "lives", "weight"],
    "account_value":["account_value", "av", "av_pp_init", "acct_value", "fund_value"],
    "product":      ["product", "product_type", "plan"],
}

def _pick(columns, aliases):
    low = {str(c).lower(): c for c in columns}
    for a in aliases:
        if a in low:
            return low[a]
    return None

def _sex(v):
    s = str(v).strip().lower() if v is not None else ""
    if s in ("f", "female", "w", "woman", "2"):
        return "F"
    return "M"

def scelo_model_points(rows, columns=None):
    """Return (frame, meta). Frame columns: age_at_entry, sex, policy_term,
    policy_count, sum_assured, duration_mth (+ premium_pp / account_value /
    product when present); index policy_id. Rows missing the MP triplet
    (age_at_entry · sum_assured · policy_term) are dropped and counted."""
    if not rows:
        _fail("no rows in model-point file", 2)
    raw = pd.DataFrame(rows)
    cols = list(columns or raw.columns)
    got = {k: _pick(cols, v) for k, v in MP_ALIASES.items()}
    for need in ("age_at_entry", "sum_assured", "policy_term"):
        if got[need] is None:
            _fail(f"model-point file has no {need} column (looked for {MP_ALIASES[need]})", 2)
    out = pd.DataFrame(index=raw.index)
    out["age_at_entry"] = pd.to_numeric(raw[got["age_at_entry"]], errors="coerce")
    out["sum_assured"] = pd.to_numeric(raw[got["sum_assured"]], errors="coerce")
    out["policy_term"] = pd.to_numeric(raw[got["policy_term"]], errors="coerce")
    out["sex"] = raw[got["sex"]].map(_sex) if got["sex"] else "M"
    out["duration_mth"] = (
        pd.to_numeric(raw[got["duration_mth"]], errors="coerce").fillna(0) if got["duration_mth"] else 0
    )
    out["policy_count"] = (
        pd.to_numeric(raw[got["policy_count"]], errors="coerce").fillna(1) if got["policy_count"] else 1
    )
    has_premium = got["premium_pp"] is not None
    if has_premium:
        out["premium_pp"] = pd.to_numeric(raw[got["premium_pp"]], errors="coerce")
    if got["account_value"]:
        out["account_value"] = pd.to_numeric(raw[got["account_value"]], errors="coerce").fillna(0)
    if got["product"]:
        out["product"] = raw[got["product"]].astype(str).str.upper().str.strip()
    ids = raw[got["policy_id"]].astype(str) if got["policy_id"] else pd.Series(
        [f"MP{i+1}" for i in range(len(raw))], index=raw.index)
    out.index = pd.Index(ids, name="policy_id")

    before = len(out)
    out = out.dropna(subset=["age_at_entry", "sum_assured", "policy_term"])
    out = out[(out["age_at_entry"] > 0) & (out["sum_assured"] > 0) & (out["policy_term"] > 0)]
    out["age_at_entry"] = out["age_at_entry"].round().astype(int)
    out["policy_term"] = out["policy_term"].round().astype(int)
    out["duration_mth"] = out["duration_mth"].round().astype(int).clip(lower=0)
    out["policy_count"] = out["policy_count"].astype(float)
    # duplicate ids break lifelib's index alignment — make them unique
    if out.index.has_duplicates:
        out.index = pd.Index([f"{i}#{n}" if n else i for i, n in zip(out.index, out.groupby(level=0).cumcount())],
                             name="policy_id")
    meta = {"rowsIn": before, "rowsUsed": int(len(out)), "rowsDropped": int(before - len(out)),
            "hasPremium": bool(has_premium)}
    if len(out) == 0:
        _fail("no usable model points after cleaning", 2)
    return out, meta

def emit(payload):
    """Print the result JSON and leave. Hard exit on purpose: tearing down a
    modelx model with a few hundred dynamic spaces at interpreter shutdown
    costs seconds (measured ~5 s for 30 TradLife policies) and buys nothing
    for a one-shot bridge process — the JSON is already on stdout."""
    payload = dict(payload)
    payload["lifelibVersion"] = LIFELIB_VERSION
    payload["modelxVersion"] = MODELX_VERSION
    sys.stdout.write(json.dumps(payload, default=lambda o: float(o) if hasattr(o, "__float__") else str(o)))
    sys.stdout.write("\\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
`;
