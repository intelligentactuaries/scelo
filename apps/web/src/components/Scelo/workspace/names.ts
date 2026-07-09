// Naming a workspace direction from its driver loadings.
//
// In a transformer the J-lens reads a direction out as tokens; nameability is
// free. Here it is a modelling choice: we name a direction from its top signed
// loadings on the named drivers, giving each workspace coordinate the short,
// monotone description the paper asks for ("this raises long-horizon mortality
// and the deferred annuity"). The name only earns trust once it survives the
// swap test.

import type { DriverLoading } from "./types";

/** A short human name for a direction from its dominant signed loadings.
 *  No em-dashes (house rule): terms are joined with commas. */
export function nameDirection(loadings: DriverLoading[], maxTerms = 3): string {
  const sorted = [...loadings].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const top = sorted[0];
  if (!top || Math.abs(top.weight) < 1e-9) return "mixed";
  const floor = 0.35 * Math.abs(top.weight);
  const terms = sorted
    .filter((l) => Math.abs(l.weight) >= floor)
    .slice(0, maxTerms)
    .map((l) => `${prettyCol(l.col)} ${l.weight >= 0 ? "up" : "down"}`);
  return terms.join(", ");
}

/** Tidy a raw column name for display: snake/kebab to spaced words. */
export function prettyCol(col: string): string {
  return col.replace(/[_-]+/g, " ").trim();
}
