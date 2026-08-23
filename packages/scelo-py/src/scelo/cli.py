"""``scelo`` on the command line: Stata-style one-word commands over a file.

    scelo describe claims.csv
    scelo clean messy.csv --all -o clean.csv
    scelo reserve claims.csv
    scelo wmtr "rural village, severe drought"
    scelo samples
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional

import pandas as pd


def main(argv: Optional[List[str]] = None) -> int:
    import scelo as sc

    ap = argparse.ArgumentParser(prog="scelo", description="Scelo for the terminal: soft data → tools → hard data.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("profile", "describe", "suggest", "quick"):
        p = sub.add_parser(name, help=f"{name} a file")
        p.add_argument("file")
    p = sub.add_parser("clean", help="clean a file (safe ops; --all for everything)")
    p.add_argument("file")
    p.add_argument("--all", action="store_true")
    p.add_argument("-o", "--out")
    p = sub.add_parser("reserve", help="chain ladder / Mack / BF / bootstrap on a claims file")
    p.add_argument("file")
    p.add_argument("--origin")
    p.add_argument("--dev")
    p.add_argument("--value")
    p = sub.add_parser("life", help="life table (illustrative Makeham, or a file with age + qx)")
    p.add_argument("file", nargs="?")
    p.add_argument("--i", type=float, default=None, help="interest: prints commutation functions instead")
    p = sub.add_parser("wmtr", help="WMTR forecast for a scenario")
    p.add_argument("scenario")
    p.add_argument("--paths", type=int, default=200)
    p = sub.add_parser("samples", help="list the bundled samples")
    p = sub.add_parser("sample", help="write a bundled sample to a CSV")
    p.add_argument("key")
    p.add_argument("-o", "--out")
    sub.add_parser("cheatsheet", help="print the cheat-sheet")
    sub.add_parser("version", help="print the version")
    a = ap.parse_args(argv)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 40)
    if a.cmd == "version":
        print(sc.__version__)
    elif a.cmd == "cheatsheet":
        sc.cheatsheet()
    elif a.cmd == "samples":
        print(sc.samples().to_string(index=False))
    elif a.cmd == "sample":
        df = sc.sample(a.key)
        out = a.out or f"{a.key}.csv"
        sc.save(df, out)
        print(f"wrote {out} ({len(df)} rows)")
    elif a.cmd in ("profile", "describe", "suggest", "quick"):
        df = sc.load(a.file)
        print(getattr(sc, a.cmd)(df))
    elif a.cmd == "clean":
        df = sc.load(a.file)
        c = sc.clean(df, "all" if a.all else None)
        for n in c.notes:
            print("·", n)
        if a.out:
            sc.save(c, a.out)
            print(f"wrote {a.out}")
    elif a.cmd == "reserve":
        df = sc.load(a.file)
        kw = {k: v for k, v in (("origin", a.origin), ("dev", a.dev), ("value", a.value)) if v}
        print(sc.reserve(df, **kw))
    elif a.cmd == "life":
        df = sc.load(a.file) if a.file else None
        print(sc.commutation(None, df, i=a.i) if a.i is not None else sc.life_table(None, df))
    elif a.cmd == "wmtr":
        print(sc.wmtr(a.scenario, nPaths=a.paths))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
