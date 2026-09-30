// The board pack's executive summary must read as plain English for the
// signing actuary: the figure first, agreement, uncertainty in words, then
// what the figures rest on — never software names or statistical shorthand.

import { describe, expect, test } from "bun:test";
import { type Dataset, buildWorkspaceDemo } from "@scelo/core";
import { executiveSummary, plainAmount, plainPct } from "./boardPackSummary";
import type { RunResult } from "./modelRunner";
import { runModel } from "./modelRunner";

// Words a signing actuary should never have to read in the summary.
const JARGON =
  /bundled|cpython|numpy|python|statsmodels|in-browser|engine|runtime|\bCV\b|\bp5\b|\bp95\b|R²|\bAUC\b|chain-ladder|bornhuetter-ferguson|bootstrap-ibnr|`/i;

/** The reported case (screenshot 2026-09-30 00:03): the IDE's four reserving
 *  runs on the claims sample, as the Python reserving engine returns them. */
function ideReservingRuns(): RunResult[] {
  const byOrigin = Array.from({ length: 7 }, (_, i) => ({
    origin: 2018 + i,
    latest: 1,
    ultimate: 1,
    ibnr: 1,
  }));
  const base = (modelId: string, label: string, value: number, detail: Record<string, unknown>) =>
    ({
      modelId,
      family: "reserving",
      status: "done",
      startedAt: 0,
      headline: { label, value, precision: 0 },
      secondary: [{ label: "runtime", value: "bundled CPython (numpy reserving engine)" }],
      blurb: `Bundled-CPython numpy reserving engine (${modelId}) across 7 origins produced IBNR = ${value}.`,
      detail: { source: "scelo-reserving-numpy", byOrigin, ibnr: value, ...detail },
      source: "python-bridge",
    }) as RunResult;
  return [
    base("chain-ladder", "IBNR", 1_500_955, {}),
    base("mack", "IBNR", 1_500_955, { se: 0.226 * 1_500_955, cv: 0.226 }),
    base("bornhuetter-ferguson", "BF reserve", 1_476_721, { apriori: 486_771 }),
    base("bootstrap-ibnr", "IBNR mean", 1_554_027, { p5: 1_083_307, p95: 2_103_617 }),
  ];
}

const claims: Dataset = {
  name: "claims_sample (synthetic)",
  columns: Array.from({ length: 11 }, (_, i) => `c${i}`),
  rows: Array.from({ length: 79 }, () => ({})),
};

describe("executiveSummary · reserving", () => {
  const text = executiveSummary({ dataset: claims, runs: ideReservingRuns() });

  test("leads with the figure, then agreement, then uncertainty in words", () => {
    expect(text).toContain("four reserving analyses of claims_sample (synthetic) — 79 records");
    expect(text).toContain("accident years 2018–2024");
    expect(text).toContain("outstanding claims (IBNR) at about 1.50 million");
    expect(text).toContain("chain ladder and Mack give 1.50 million");
    expect(text).toContain("Bornhuetter–Ferguson gives 1.48 million");
    expect(text).toContain("They agree closely (within 5.2%)");
    expect(text).toContain("Mack's standard error is about 23% of the reserve");
    expect(text).toContain("90% of simulated outcomes between 1.08 million and 2.10 million");
  });

  test("says what the figures rest on", () => {
    expect(text).toContain("Before relying on these figures, note that");
    expect(text).toContain("book-average ultimate rather than a plan or pricing loss ratio");
    expect(text).toContain("seven accident years of history");
    expect(text).toContain("synthetic, so the figures are illustrative only");
    // A full (IDE) bootstrap is not flagged as an approximation.
    expect(text).not.toContain("simplified approximation");
  });

  test("no software names, model ids or statistical shorthand", () => {
    expect(text).not.toMatch(JARGON);
  });

  test("the in-app bootstrap stand-in IS flagged", () => {
    const runs = ideReservingRuns();
    runs[3] = {
      ...runs[3],
      secondary: [{ label: "iters", value: "5,000 (mock)" }],
      source: "browser",
    };
    expect(executiveSummary({ dataset: claims, runs })).toContain(
      "the bootstrap range is a simplified approximation",
    );
  });
});

describe("executiveSummary · other boards", () => {
  test("the workspace demo: plain sentences, and what could not be applied", () => {
    const demo = buildWorkspaceDemo();
    const runs = [
      "workspace-bottleneck",
      "lee-carter",
      "lifecontingencies",
      "descriptive",
      "gbm",
    ].map((id) => runModel(id, demo));
    // SHAP explains the GBM wired into it (the canvas's default wiring).
    runs.push(runModel("shap", demo, new Map([["gbm", runs[4]]])));
    const text = executiveSummary({ dataset: demo, runs });
    expect(text).toContain(
      "explains 98% of the variation in survival_to_80 on data it had not seen",
    );
    expect(text).toContain("driven mainly by smoking_index");
    expect(text).toContain(
      "Lee–Carter and Life Contingencies could not be applied to this data (they need a mortality table",
    );
    expect(text).not.toMatch(JARGON);
  });

  test("empty and all-not-applicable boards say so plainly", () => {
    const demo = buildWorkspaceDemo();
    expect(executiveSummary({ dataset: demo, runs: [] })).toContain("No models are attached");
    const na = [runModel("lee-carter", demo), runModel("cbd", demo)];
    expect(executiveSummary({ dataset: demo, runs: na })).toContain(
      "its data does not contain what they need",
    );
  });
});

describe("plain numbers", () => {
  test("amounts and percentages read the way a memo writes them", () => {
    expect(plainAmount(1_500_955)).toBe("1.50 million");
    expect(plainAmount(2_300_000_000)).toBe("2.30 billion");
    expect(plainAmount(486_771)).toBe("487,000");
    expect(plainAmount(7.9436)).toBe("7.94");
    expect(plainAmount(-1_200_000)).toBe("minus 1.20 million");
    expect(plainPct(0.226)).toBe("23%");
    expect(plainPct(0.0518)).toBe("5.2%");
    expect(plainPct(0.0199, true)).toBe("1.99%");
  });
});
