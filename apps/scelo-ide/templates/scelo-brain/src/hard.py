"""Hard layer : the only writer to durable artefacts.

Reads a tool-result envelope from stdin (or a literal sample if stdin
is a TTY) and appends one row to artefacts/claims.csv. Refuses to
write if the input shape doesn't look like a tool result.

The brain's invariant: nothing reaches this file except by passing
through the tools layer. Keep it that way.
"""

import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
OUT = HERE / "artefacts" / "claims.csv"


def is_tool_envelope(obj: object) -> bool:
    if not isinstance(obj, dict):
        return False
    if obj.get("ok") is not True:
        return False
    v = obj.get("value")
    if not isinstance(v, dict):
        return False
    return "tool" in v and "result" in v


def main() -> int:
    if sys.stdin.isatty():
        # Sample envelope mirroring tools.ts default output, so this
        # file is runnable end-to-end without piping.
        envelope = {
            "ok": True,
            "value": {
                "tool": "compute_reserve",
                "result": {"reserve": 1725.0, "bornAt": "2026-05-20T00:00:00Z"},
            },
        }
    else:
        envelope = json.load(sys.stdin)
    if not is_tool_envelope(envelope):
        print("input does not look like a tool envelope; refusing to write.")
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    new_file = not OUT.exists()
    with OUT.open("a", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(["tool", "reserve", "bornAt"])
        v = envelope["value"]
        r = v["result"]
        w.writerow([v["tool"], r["reserve"], r["bornAt"]])
    print(f"appended one row to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
