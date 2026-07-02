"""Fetch + parse the official SOA sample-question banks into a local JSONL.

Usage::

    python bench/fetch_soa.py fm        # download + parse Exam FM
    python bench/fetch_soa.py p         # Exam P

Writes ``data/<exam>.jsonl`` (git-ignored) with one record per line::

    {"exam","number","stem","choices":{"A":...,"B":...},"answer":"C"}

No SOA content is committed to the repo — only this fetcher/parser. The PDFs
and parsed questions live under ``data/`` on the user's machine.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request

from exams import EXAMS

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")


def _ensure_pypdf():
    try:
        import pypdf  # noqa: F401
    except ImportError:
        print("pypdf not found — installing into the bundled runtime…")
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pypdf"], check=True)


def download(url: str, dest: str) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) > 10_000:
        print(f"  cached {os.path.basename(dest)}")
        return
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Scelo SOA bench)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
            f.write(r.read())
    except Exception as e:  # noqa: BLE001 — fall back to curl (handles some TLS quirks)
        print(f"  urllib failed ({e}); trying curl…")
        subprocess.run(["curl", "-sL", "-A", "Mozilla/5.0", "-o", dest, url], check=True)


def extract_text(pdf_path: str) -> str:
    import pypdf

    reader = pypdf.PdfReader(pdf_path)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def parse_answer_key(text: str, patterns: list[str]) -> dict[int, str]:
    key: dict[int, str] = {}
    for pat in patterns:
        for m in re.finditer(pat, text):
            key.setdefault(int(m.group(1)), m.group(2))
    return key


def parse_questions(text: str, exam: str, key: dict[int, str]) -> list[dict]:
    """Split on 'N.' question markers (validated monotonic chain), then peel the
    (A)-(E) choices off the tail of each block."""
    lines = text.split("\n")
    marks = [
        (i, int(m.group(1)))
        for i, ln in enumerate(lines)
        if (m := re.match(r"^\s*(\d+)\.\s*$", ln))
    ]
    # Keep only the strictly-sequential chain starting at question 1 — this
    # rejects stray "12." mid-sentence matches.
    chain: list[tuple[int, int]] = []
    for idx, num in marks:
        if not chain:
            if num == 1:
                chain.append((idx, num))
        elif num == chain[-1][1] + 1:
            chain.append((idx, num))

    out: list[dict] = []
    for j, (idx, num) in enumerate(chain):
        end = chain[j + 1][0] if j + 1 < len(chain) else len(lines)
        body = lines[idx + 1 : end]
        choices: dict[str, str] = {}
        stem_lines: list[str] = []
        cur: str | None = None
        for ln in body:
            cm = re.match(r"^\s*\(([A-E])\)\s*(.*)", ln)
            if cm:
                cur = cm.group(1)
                choices[cur] = cm.group(2).strip()
            elif cur is not None:
                if not re.match(r"^\s*\d+\s*$", ln):  # skip bare page numbers
                    choices[cur] = (choices[cur] + " " + ln.strip()).strip()
            elif not re.match(r"^\s*\d+\s*$", ln):
                stem_lines.append(ln.rstrip())
        stem = "\n".join(stem_lines).strip()
        if stem.upper().startswith("DELETED"):
            continue
        out.append(
            {
                "exam": exam,
                "number": num,
                "stem": stem,
                "choices": choices,
                "answer": key.get(num),
            }
        )
    return out


def main(exam: str) -> None:
    if exam not in EXAMS:
        sys.exit(f"unknown exam '{exam}'. Known: {', '.join(EXAMS)}")
    spec = EXAMS[exam]
    _ensure_pypdf()
    os.makedirs(DATA, exist_ok=True)
    q_pdf = os.path.join(DATA, f"{exam}-questions.pdf")
    s_pdf = os.path.join(DATA, f"{exam}-solutions.pdf")
    print(f"[{exam}] {spec['title']}")
    download(spec["questions_url"], q_pdf)
    download(spec["solutions_url"], s_pdf)

    key = parse_answer_key(extract_text(s_pdf), spec["answer_key_patterns"])
    questions = parse_questions(extract_text(q_pdf), exam, key)

    clean = [q for q in questions if len(q["choices"]) == 5 and q["answer"]]
    out_path = os.path.join(DATA, f"{exam}.jsonl")
    with open(out_path, "w", encoding="utf-8") as f:
        for q in questions:
            f.write(json.dumps(q, ensure_ascii=False) + "\n")

    print(
        f"  parsed {len(questions)} questions, {len(key)} answer keys, "
        f"{len(clean)} fully-clean (5 choices + key)"
    )
    print(f"  wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python bench/fetch_soa.py <exam>   e.g. fm | p | fam | srm")
    main(sys.argv[1].lower())
