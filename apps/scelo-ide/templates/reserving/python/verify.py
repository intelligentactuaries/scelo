"""Re-run the RAA Mack chain-ladder through the pure-Python chainladder
package and report the divergence against the R result.

The pinned regression for RAA is IBNR ≈ 52,135. Each engine has small
numerical idiosyncrasies (link-ratio handling, tail factors, σ
estimation) so we expect a few units of disagreement. A larger gap is
worth investigating.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
R_OUT = HERE / "data" / "mack_results.json"

PINNED_IBNR = 52_135.0
PINNED_TOLERANCE = 0.01  # 1%

try:
    import chainladder as cl
except ImportError:
    print("chainladder not installed. In the terminal:")
    print("  pip install chainladder")
    sys.exit(2)


def main() -> int:
    if not R_OUT.exists():
        print(f"missing {R_OUT}: run `Rscript r/mack_raa.R` first.")
        return 2
    r_result = json.loads(R_OUT.read_text())

    raa = cl.load_sample("raa")
    mack = cl.MackChainladder().fit(raa)
    py_ibnr = float(mack.ibnr_.sum())
    py_se = float(mack.total_mack_std_err_.iloc[0])

    print("R-ChainLadder vs chainladder.py")
    print("-" * 40)
    print(f"R   IBNR : {r_result['mack_ibnr']:12.2f}")
    print(f"Py  IBNR : {py_ibnr:12.2f}")
    print(f"R   SE   : {r_result['mack_se']:12.2f}")
    print(f"Py  SE   : {py_se:12.2f}")
    print()

    diff_abs = abs(r_result["mack_ibnr"] - py_ibnr)
    diff_pct = diff_abs / r_result["mack_ibnr"] * 100
    print(f"|R - Py|  = {diff_abs:.2f}  ({diff_pct:.3f}%)")

    pinned_diff = abs(r_result["mack_ibnr"] - PINNED_IBNR) / PINNED_IBNR
    pinned_ok = pinned_diff < PINNED_TOLERANCE
    flag = "ok" if pinned_ok else "FAIL"
    print(f"Pinned regression IBNR={PINNED_IBNR:.0f} : {flag} ({pinned_diff*100:.3f}% drift)")
    return 0 if pinned_ok else 1


if __name__ == "__main__":
    sys.exit(main())
