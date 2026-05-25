// Optional R delegation for the life family.
//
// Pipes a mortality table (age, qx) and contract config (age_x, term,
// interest_rate, benefit) to the bundled R interpreter, which runs the
// CRAN `lifecontingencies` package to produce the canonical actuarial
// present values for:
//
//   axn  — whole-life / temporary annuity
//   Axn  — term insurance EPV
//   nEx  — pure endowment
//
// Same fail-soft pattern as the other bridges: returns null when not in
// the IDE or when the R runtime / package is missing, and the caller
// falls back to the in-browser TS port.

import { isDesktopIDE, runR, getRuntimeStatus } from "../../../lib/sceloIDE";
import type { Dataset } from "../SoftDataWorkstation";

export interface LifeContingenciesROutput {
  ax: number;       // life annuity EPV
  Ax: number;       // term insurance EPV (1 unit at death within term)
  nEx: number;      // pure endowment EPV (1 unit at end of term if alive)
  ageX: number;
  term: number;
  interest: number;
  rowsUsed: number;
  source: "lifecontingencies-r";
}

const SCRIPT = `
suppressWarnings({
  ok <- requireNamespace("lifecontingencies", quietly = TRUE) &&
        requireNamespace("jsonlite", quietly = TRUE)
})
if (!ok) {
  cat(jsonlite::toJSON(list(error = "lifecontingencies or jsonlite missing"), auto_unbox = TRUE))
  quit(save = "no", status = 1)
}
library(lifecontingencies)
library(jsonlite)
payload <- fromJSON(file("stdin"))
qx <- payload$qx
ages <- payload$ages
ageX <- as.integer(payload$ageX)
term <- as.integer(payload$term)
i    <- as.numeric(payload$interest)
# Build a life table from (age, qx). lifecontingencies expects a
# survival function via probs, with x going 0..omega.
omega <- max(ages)
qx_full <- rep(1, omega + 1)
for (k in seq_along(ages)) {
  if (ages[k] <= omega) qx_full[ages[k] + 1] <- qx[k]
}
# clip
qx_full <- pmax(0, pmin(1, qx_full))
lx <- c(100000)
for (a in 1:omega) lx <- c(lx, lx[a] * (1 - qx_full[a]))
lt <- new("lifetable", x = 0:omega, lx = lx, name = "scelo")
act <- new("actuarialtable", x = lt@x, lx = lt@lx, interest = i, name = "scelo")
ax_v  <- axn(act, x = ageX, n = term)
Ax_v  <- Axn(act, x = ageX, n = term)
nEx_v <- nEx(act, x = ageX, n = term)
cat(jsonlite::toJSON(list(
  ax = ax_v, Ax = Ax_v, nEx = nEx_v,
  ageX = ageX, term = term, interest = i,
  rowsUsed = length(ages),
  source = "lifecontingencies-r"
), auto_unbox = TRUE))
`;

interface BridgeInput {
  ages: number[];
  qx: number[];
  ageX: number;
  term: number;
  interest: number;
}

function buildInput(dataset: Dataset): BridgeInput | null {
  const cols = dataset.columns.map((c) => c.toLowerCase());
  const ageIdx = cols.indexOf("age");
  const qxIdx = cols.indexOf("qx");
  if (ageIdx < 0 || qxIdx < 0) return null;
  const ageCol = dataset.columns[ageIdx];
  const qxCol = dataset.columns[qxIdx];
  const ages: number[] = [];
  const qx: number[] = [];
  for (const r of dataset.rows) {
    const a = r[ageCol];
    const q = r[qxCol];
    if (typeof a !== "number" || typeof q !== "number") continue;
    ages.push(a);
    qx.push(q);
  }
  if (ages.length === 0) return null;
  // Pick a sensible default contract: 65-year-old, 10-year term, 4% interest.
  return { ages, qx, ageX: 65, term: 10, interest: 0.04 };
}

export async function runLifeContingenciesR(
  dataset: Dataset,
): Promise<LifeContingenciesROutput | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.r) return null;
  const input = buildInput(dataset);
  if (!input) return null;
  const res = await runR(SCRIPT, { stdin: JSON.stringify(input) });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as LifeContingenciesROutput;
  } catch {
    return null;
  }
}
