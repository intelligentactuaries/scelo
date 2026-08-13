import { describe, expect, test } from "bun:test";
import { type ColumnMeta, type Dataset, summariseDataset } from "@scelo/core";
import { auditRequest, formatAutoCleanReport } from "./autoCleanReport";
import { type CleaningOp, autoCleanDataset } from "./cleaning";

function ds(rows: Dataset["rows"], columns: string[]): Dataset {
  return { name: "t", columns, rows };
}

// The prompt that exposed this, verbatim.
const REQUEST =
  "Can you clean the entire dataset accordingly by imputing missing values, handling outliers, making formatting consistent where relevant, and by performing any other relent cleaning technique in this situation.";

const IMPUTE_OP: CleaningOp = {
  key: "impute-missing",
  columns: [{ name: "sentiment", strategy: "mode", value: "positive", cells: 9, indicator: null }],
  cells: 9,
  safe: false,
};

const CAP_OP: CleaningOp = {
  key: "cap-outliers",
  columns: [{ name: "income", loFence: 0, hiFence: 100, count: 4 }],
  cells: 4,
  safe: false,
};

describe("auditRequest", () => {
  test("picks up every ask in the sentence, not just the routing phrase", () => {
    const { lines } = auditRequest(REQUEST, [IMPUTE_OP, CAP_OP], []);
    const text = lines.join("\n");
    expect(text).toContain("Impute missing values");
    expect(text).toContain("Handle outliers");
    expect(text).toContain("Make formatting consistent");
  });

  test("a request with no cleaning specifics produces no audit at all", () => {
    // The chip's own prompt: nothing to hold the report to beyond the passes.
    const { lines, outstanding } = auditRequest(
      "Go through the entire dataset and clean it until it's fully clean.",
      [IMPUTE_OP],
      [],
    );
    expect(lines).toEqual([]);
    expect(outstanding).toBe(false);
  });

  test("reports counts for work that was done", () => {
    const { lines, outstanding } = auditRequest("impute missing values", [IMPUTE_OP], []);
    expect(outstanding).toBe(false);
    expect(lines.join("\n")).toContain("9 cells filled");
  });

  test("names the column AND the engine's own reason for anything left undone", () => {
    // A column of unique identifiers: still has holes after the run, and
    // `imputeDecision` is the thing that decided not to touch it.
    const metas: ColumnMeta[] = [
      { name: "member_id", type: "string", count: 100, missing: 12, unique: 88 },
    ];
    const { lines, outstanding } = auditRequest("impute the missing values", [], metas);
    expect(outstanding).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("not done");
    expect(text).toContain("`member_id`");
    expect(text).toContain("12 still empty");
    expect(text).toContain("identifier or free text");
  });

  test("partly-done work says so rather than claiming the whole ask", () => {
    const metas: ColumnMeta[] = [
      { name: "member_id", type: "string", count: 100, missing: 12, unique: 88 },
    ];
    const { lines, outstanding } = auditRequest("impute missing values", [IMPUTE_OP], metas);
    expect(outstanding).toBe(true);
    expect(lines.join("\n")).toContain("partly done");
  });

  test("an ask nothing in the data needed is not reported as done", () => {
    const { lines } = auditRequest("remove duplicate rows", [], []);
    expect(lines.join("\n")).toContain("nothing in the dataset needed it");
  });
});

describe("formatAutoCleanReport", () => {
  // A miniature of the frame from the bug report: an id column that can't be
  // filled, a category with holes that can, and a fat-tailed money column.
  function frame(): Dataset {
    return ds(
      Array.from({ length: 60 }, (_, i) => ({
        member_id: i % 9 === 0 ? null : `P${String(i).padStart(4, "0")}`,
        sentiment: i % 7 === 0 ? null : i % 3 === 0 ? "negative" : "positive",
        monthly_income_zar: i === 59 ? 4_000_000 : 1000 + i * 10,
      })),
      ["member_id", "sentiment", "monthly_income_zar"],
    );
  }

  test("does the work, then declines to claim the part it couldn't do", () => {
    const result = autoCleanDataset(frame(), summariseDataset);
    const report = formatAutoCleanReport(result, REQUEST, summariseDataset(result.dataset));

    // The two asks the engine can now answer.
    expect(report).toContain("cells filled");
    expect(report).toContain("clamped to the Tukey fences");
    // The one it can't: `member_id` is all-distinct, so it keeps its holes and
    // the report says so instead of signing off as clean.
    expect(report).toContain("`member_id`");
    expect(report).toContain("Still outstanding");
    expect(report).not.toContain("found nothing further — the dataset is clean");
    expect(report).toContain("That is not the same as your whole request being met");
  });

  test("with nothing outstanding it still signs off plainly", () => {
    const clean = ds(
      Array.from({ length: 40 }, (_, i) => ({
        region: i % 2 === 0 ? "north" : "south",
        n: i,
      })),
      ["region", "n"],
    );
    const result = autoCleanDataset(clean, summariseDataset);
    const report = formatAutoCleanReport(result, REQUEST, summariseDataset(result.dataset));
    expect(report).not.toContain("not done");
  });

  test("no request → the original pass-by-pass report, unchanged", () => {
    const result = autoCleanDataset(frame(), summariseDataset);
    const report = formatAutoCleanReport(result, undefined, summariseDataset(result.dataset));
    expect(report).toContain("Went through the entire dataset and cleaned it");
    expect(report).not.toContain("Against your request");
  });
});
