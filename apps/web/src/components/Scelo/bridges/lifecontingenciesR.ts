// Optional R delegation for the life family.
//
// Prices a life aged x over n years with the CRAN `lifecontingencies`
// package on the bundled R interpreter:
//
//   axn  — temporary life annuity-due
//   Axn  — term insurance EPV
//   nEx  — pure endowment
//
// The mortality it prices on is resolved in TypeScript (resolveLifeBasis in
// modelRunner: a wired Lee–Carter's projected cohort, or the dataset's own
// life table) and sent as the one-year death probabilities q_x … q_{x+n−1}, so
// the R and in-browser paths price the SAME basis.
//
// Error contract (same as the GLM / climada / reserving bridges): null ONLY
// when the bridge does not apply (outside the desktop IDE, or nothing to
// price); a missing runtime or a failed script THROWS with the reason, which
// the result card shows.

import { bridgeFailureReason, getRuntimeStatus, isDesktopIDE, runR } from "../../../lib/sceloIDE";

export interface LifeContingenciesROutput {
  ax: number; // temporary life annuity-due EPV
  Ax: number; // term insurance EPV (1 unit at the end of the year of death)
  nEx: number; // pure endowment EPV (1 unit at the end of the term if alive)
  ageX: number;
  term: number;
  interest: number;
  rowsUsed: number;
  source: "lifecontingencies-r";
}

export interface LifeContingenciesRInput {
  /** One-year death probabilities at ages ageX, ageX+1, … (length = term). */
  q: number[];
  ageX: number;
  interest: number;
}

// The life table runs from age 0 to x+n: no deaths before x (those ages cancel
// out of every EPV at x), then the supplied q. It must run to x+n, not x+n−1 —
// the package treats a table's last age as terminal (q = 1). The previous
// script filled every age it was not given with q = 1, so any table that did
// not start at age 0 killed the whole cohort at birth and priced NaN; it also
// called nEx(), which lifecontingencies does not have (the function is Exn).
const SCRIPT = `
ok <- suppressWarnings(
  requireNamespace("lifecontingencies", quietly = TRUE) &&
  requireNamespace("jsonlite", quietly = TRUE)
)
if (!ok) {
  cat('{"error": "R packages lifecontingencies / jsonlite are not installed in the bundled R"}')
  quit(save = "no", status = 1)
}
suppressPackageStartupMessages(library(lifecontingencies))
payload <- jsonlite::fromJSON(file("stdin"))
q    <- pmax(0, pmin(1, as.numeric(payload$q)))
ageX <- as.integer(payload$ageX)
i    <- as.numeric(payload$interest)
n    <- length(q)
lx   <- rep(100000, ageX + 1)
for (k in seq_len(n)) lx <- c(lx, lx[length(lx)] * (1 - q[k]))
act  <- new("actuarialtable", x = 0:(ageX + n), lx = lx, interest = i, name = "scelo")
cat(jsonlite::toJSON(list(
  ax = axn(act, x = ageX, n = n),
  Ax = Axn(act, x = ageX, n = n),
  nEx = Exn(act, x = ageX, n = n), # the package's pure endowment; there is no nEx()
  ageX = ageX, term = n, interest = i,
  rowsUsed = n,
  source = "lifecontingencies-r"
), auto_unbox = TRUE, digits = NA))
`;

export async function runLifeContingenciesR(
  input: LifeContingenciesRInput,
): Promise<LifeContingenciesROutput | null> {
  if (!isDesktopIDE()) return null;
  if (input.q.length === 0) return null;
  const status = await getRuntimeStatus();
  if (!status.r) throw new Error("bundled R runtime not detected");
  const res = await runR(SCRIPT, { stdin: JSON.stringify(input) });
  if (!res.ok) throw new Error(bridgeFailureReason(res));
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    throw new Error("lifecontingencies bridge returned non-JSON output");
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    throw new Error(String((parsed as { error: unknown }).error));
  }
  return parsed as LifeContingenciesROutput;
}
