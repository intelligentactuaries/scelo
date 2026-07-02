# SOA exams — solve & self-check with Scelo

Work the Society of Actuaries multiple-choice exams inside Scelo: answer them
with the **Claude Code** chat provider (no API key — reuses your Claude login),
and tie every answer out to the official examiner solution. Where the chat
slips, a **tested actuarial toolkit** does the arithmetic deterministically.

> The genuinely multiple-choice SOA exams (P, FM, FAM, SRM) are *not* released
> as past papers — the SOA publishes public **sample question + solution**
> banks instead. This template fetches those on demand. **No SOA content is
> stored in the repo** (it's copyright); the PDFs and parsed questions live in
> the git-ignored `data/` folder on your machine.

## Layout

```
python/actuarial/       the solver toolkit (pure stdlib, unit-tested)
  fm.py                 Financial Mathematics — annuities, bonds, loans, IRR, duration
tests/test_fm.py        ties out to official Exam FM answers (Q1→0.0396, Q6→97, …)
bench/exams.py          registry of exams + their public sample-bank URLs
bench/fetch_soa.py      download + parse a bank → data/<exam>.jsonl
bench/run_bench.py      run questions through the Claude Code provider & score
data/                   (git-ignored) downloaded PDFs, parsed questions, reports
```

## Quick start

```bash
# 1. Check the toolkit ties out to the examiner's answers
python tests/test_fm.py                 # or: python -m pytest tests/

# 2. Fetch + parse an exam's official sample bank
python bench/fetch_soa.py fm            # Exam FM (Financial Mathematics)

# 3. Have the Scelo Claude Code chat sit the exam, and score it
python bench/run_bench.py fm --n 25                 # first 25, your default model
python bench/run_bench.py fm --sample 40 --seed 1   # random 40
python bench/run_bench.py fm --numbers 45,99,383 --mode toolkit
```

`run_bench.py` calls `claude -p` with the **same flags Scelo's Claude Code
provider uses**, so the pass rate is exactly what you'd get from the IDE chat.

- `--mode baseline` (default): pure chat reply — the faithful measure.
- `--mode toolkit`: the chat may execute the bundled `actuarial` toolkit to
  compute. This is the "fix" surface — verified arithmetic instead of mental
  math. (Runs the toolkit locally; uses the Bash tool.)

## Coverage

| Exam | Toolkit | Bank | Notes |
|------|---------|------|-------|
| FM — Financial Mathematics | ✅ `fm.py` | 461 sample Qs | implemented |
| P — Probability | ⏳ | 300+ sample Qs | next stage |
| FAM / SRM | ⏳ | — | planned |

The workflow is staged on purpose: fetch a bank, measure the baseline pass
rate, and harden the toolkit against the specific misses until the examiner's
answers reproduce.
