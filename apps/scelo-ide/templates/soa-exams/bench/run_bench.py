"""Run parsed SOA questions through the Scelo *Claude Code* provider and score.

This drives ``claude -p`` with the **same flags Scelo's Claude Code provider
uses** (see apps/scelo-ide/src/main.ts ``chatClaudeCode``), so the pass rate
here is what a Scelo user gets from the IDE chat — nothing bespoke.

Modes
-----
* ``baseline``  pure chat reply (lean system prompt, no tools) — the faithful
                measure of the IDE's Claude Code provider.
* ``toolkit``   the chat may execute the bundled, unit-tested ``actuarial``
                toolkit (Bash tool, toolkit on PYTHONPATH). This is the "fix":
                route the computation through verified code.

Usage::

    python bench/run_bench.py fm --n 25                 # first 25, your default model
    python bench/run_bench.py fm --sample 30 --seed 1   # random 30
    python bench/run_bench.py fm --n 25 --model sonnet --workers 4
    python bench/run_bench.py fm --numbers 45,99,383 --mode toolkit
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
PYDIR = os.path.join(HERE, "..", "python")

BASE_SYSTEM = (
    "You are sitting a Society of Actuaries multiple-choice actuarial exam. "
    "Solve the problem exactly and pick the single best option. "
    "You MUST end your reply with a final line in exactly this format:\n"
    "ANSWER: <letter>\n"
    "where <letter> is one of A, B, C, D, E."
)
TOOLKIT_SYSTEM = (
    BASE_SYSTEM
    + "\n\nA tested Python toolkit is importable as `from actuarial import fm` "
    "(annuities, bonds, loan amortization, IRR/NPV, duration). Prefer running it "
    "to do the arithmetic rather than computing in your head; it is unit-tested "
    "against the official answer key."
)

ANSWER_RE = re.compile(r"ANSWER:\s*\(?([A-E])\)?", re.IGNORECASE)
FALLBACK_RE = re.compile(r"\(([A-E])\)")


def format_prompt(q: dict) -> str:
    lines = [q["stem"], ""]
    for letter in "ABCDE":
        if letter in q["choices"]:
            lines.append(f"({letter}) {q['choices'][letter]}")
    return "\n".join(lines)


def call_claude(prompt: str, system: str, model: str | None, mode: str,
                timeout: int = 150, retries: int = 2) -> tuple[str, str]:
    """Invoke the local claude CLI exactly as the Scelo provider does.

    Crash-proof: a hung call (rate-limit queueing) or CLI error is retried a
    couple of times, then returned as an ``__ERROR__`` string rather than
    raised — one bad call must never kill a long batch.

    Returns (result_text, model_used)."""
    args = ["claude", "-p", "--output-format", "json", "--strict-mcp-config"]
    args += ["--system-prompt", system]
    if model:
        args += ["--model", model]
    env = dict(os.environ)
    if mode == "toolkit":
        # Let the chat run the bundled toolkit to compute.
        args += ["--allowedTools", "Bash", "--dangerously-skip-permissions"]
        env["PYTHONPATH"] = PYDIR + os.pathsep + env.get("PYTHONPATH", "")
    # Force UTF-8 on the pipes — the questions/replies carry math Unicode
    # (δ, −, …) that Windows' default cp1252 codec can't encode/decode.
    last = ""
    for attempt in range(retries + 1):
        try:
            proc = subprocess.run(
                args, input=prompt, capture_output=True, text=True,
                encoding="utf-8", errors="replace", env=env, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            last = f"__ERROR__ timeout after {timeout}s (attempt {attempt + 1})"
            continue
        except Exception as e:  # noqa: BLE001
            last = f"__ERROR__ {type(e).__name__}: {e}"
            continue
        if proc.returncode != 0:
            last = f"__ERROR__ exit {proc.returncode}: {(proc.stderr or proc.stdout)[:200]}"
            continue
        try:
            data = json.loads(proc.stdout)
            return (data.get("result") or "").strip(), ",".join((data.get("modelUsage") or {}).keys())
        except json.JSONDecodeError:
            return proc.stdout.strip(), ""
    return last, ""


def extract_answer(text: str) -> str | None:
    m = list(ANSWER_RE.finditer(text))
    if m:
        return m[-1].group(1).upper()
    m = list(FALLBACK_RE.finditer(text))
    if m:
        return m[-1].group(1).upper()
    return None


def grade_one(q: dict, model: str | None, mode: str) -> dict:
    system = TOOLKIT_SYSTEM if mode == "toolkit" else BASE_SYSTEM
    reply, model_used = call_claude(format_prompt(q), system, model, mode)
    got = extract_answer(reply)
    return {
        "number": q["number"],
        "expected": q["answer"],
        "got": got,
        "correct": got == q["answer"],
        "model": model_used,
        "reply_tail": reply[-160:],
    }


def load(exam: str) -> list[dict]:
    path = os.path.join(DATA, f"{exam}.jsonl")
    if not os.path.exists(path):
        raise SystemExit(f"{path} not found — run: python bench/fetch_soa.py {exam}")
    qs = [json.loads(line) for line in open(path, encoding="utf-8")]
    return [q for q in qs if len(q["choices"]) == 5 and q["answer"]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("exam")
    ap.add_argument("--n", type=int, default=25, help="take the first N clean questions")
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--sample", type=int, help="random sample of this many instead of first-N")
    ap.add_argument("--numbers", help="comma-separated explicit question numbers")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--model", default=None, help="claude model alias; blank = your default")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--mode", choices=["baseline", "toolkit"], default="baseline")
    args = ap.parse_args()

    qs = load(args.exam)
    by_num = {q["number"]: q for q in qs}
    if args.numbers:
        want = [int(x) for x in args.numbers.split(",")]
        batch = [by_num[n] for n in want if n in by_num]
    elif args.sample:
        random.seed(args.seed)
        batch = random.sample(qs, min(args.sample, len(qs)))
    else:
        batch = qs[args.start : args.start + args.n]

    # Resumable checkpoint — one JSON line per graded question. A killed run
    # (this box stops long background jobs) loses nothing; rerun to continue.
    os.makedirs(DATA, exist_ok=True)
    tag = (args.model or "default").replace("/", "-")
    ckpt = os.path.join(DATA, f"checkpoint-{args.exam}-{tag}-{args.mode}.jsonl")
    done: dict[int, dict] = {}
    if os.path.exists(ckpt):
        for line in open(ckpt, encoding="utf-8"):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Only treat a *successful* grade as cached; errored calls (rate-limit
            # timeouts) are left out so a rerun retries them.
            if not str(r.get("reply_tail", "")).startswith("__ERROR__"):
                done[r["number"]] = r
    todo = [q for q in batch if q["number"] not in done]

    print(
        f"[{args.exam}] {len(qs)} clean questions available; batch {len(batch)}, "
        f"{len(done)} cached, running {len(todo)} "
        f"(mode={args.mode}, model={args.model or 'your default'}, workers={args.workers})"
    )

    results: list[dict] = list(done.values())
    ckpt_f = open(ckpt, "a", encoding="utf-8")
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(grade_one, q, args.model, args.mode): q for q in todo}
        for fut in as_completed(futs):
            q = futs[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001 — never let one question kill the batch
                r = {"number": q["number"], "expected": q["answer"], "got": None,
                     "correct": False, "model": "", "reply_tail": f"__ERROR__ {e}"}
            results.append(r)
            ckpt_f.write(json.dumps(r, ensure_ascii=False) + "\n")
            ckpt_f.flush()
            err = "reply_tail" in r and str(r["reply_tail"]).startswith("__ERROR__")
            mark = "✓" if r["correct"] else ("!" if err else "✗")
            print(f"  {mark} Q{r['number']:>3}  expected {r['expected']}  got {r['got']}")
    ckpt_f.close()

    results.sort(key=lambda r: r["number"])

    def is_error(r: dict) -> bool:
        return str(r.get("reply_tail", "")).startswith("__ERROR__")

    errored = [r for r in results if is_error(r)]
    graded = [r for r in results if not is_error(r)]
    correct = sum(r["correct"] for r in graded)
    total = len(graded)
    fails = [r for r in graded if not r["correct"]]
    pct = 100 * correct / total if total else 0
    print(f"\n{args.exam.upper()} {args.mode}: {correct}/{total} correct ({pct:.1f}%)"
          f"{f'  [{len(errored)} call errors excluded — rerun to retry]' if errored else ''}")
    if fails:
        print("wrong:", ", ".join(f"Q{r['number']}(exp {r['expected']}, got {r['got']})" for r in fails))

    out = os.path.join(DATA, f"report-{args.exam}-{tag}-{args.mode}.json")
    json.dump(
        {"exam": args.exam, "mode": args.mode, "model": args.model, "correct": correct,
         "total": total, "pct": pct, "errored": len(errored),
         "wrong": [r["number"] for r in fails], "results": results},
        open(out, "w", encoding="utf-8"), indent=2, ensure_ascii=False,
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
