// Logic behind the click-to-edit slider readouts. The swarm client carries a
// byte-identical copy of these helpers but has no test runner, so this is the
// single place the behaviour is pinned — keep the two in step.

import { describe, expect, test } from "bun:test";
import { magnitudeEdit, parseLoose, pctEdit, snapToRange } from "./EditableNumber";

describe("parseLoose", () => {
  test("plain numbers", () => {
    expect(parseLoose("42")).toBe(42);
    expect(parseLoose("3.5")).toBe(3.5);
    expect(parseLoose("-7")).toBe(-7);
  });

  test("tolerates thousands separators and spaces", () => {
    expect(parseLoose("45,000,000")).toBe(45_000_000);
    expect(parseLoose("45 000 000")).toBe(45_000_000);
    expect(parseLoose("1_000")).toBe(1000);
  });

  test("tolerates a currency prefix", () => {
    expect(parseLoose("R45000")).toBe(45000);
    expect(parseLoose("$1,200")).toBe(1200);
  });

  test("rejects junk rather than returning 0", () => {
    // The important half: Number("") is 0, which would silently slam a
    // slider to its minimum on an empty commit.
    expect(parseLoose("")).toBeNaN();
    expect(parseLoose("   ")).toBeNaN();
    expect(parseLoose("abc")).toBeNaN();
    expect(parseLoose("-")).toBeNaN();
  });
});

describe("snapToRange", () => {
  test("clamps to both ends", () => {
    expect(snapToRange(5000, 50, 1000, 50)).toBe(1000);
    expect(snapToRange(10, 50, 1000, 50)).toBe(50);
    expect(snapToRange(-0.5, 0, 1, 0.05)).toBe(0);
    expect(snapToRange(2, 0, 1, 0.05)).toBe(1);
  });

  test("does NOT snap to the step — that is the point of typing", () => {
    // 5%-step slider, typed 63% → stays 63%, not rounded to 65%.
    expect(snapToRange(0.63, 0, 1, 0.05)).toBe(0.63);
    // 20-step slider, typed 237 → stays 237.
    expect(snapToRange(237, 20, 1000, 20)).toBe(237);
    // 1M-step slider, typed 45.5M → stays 45.5M.
    expect(snapToRange(45_500_000, 1e6, 2e8, 1e6)).toBe(45_500_000);
  });

  test("integer steps round to integers", () => {
    expect(snapToRange(38.7, 18, 70, 1)).toBe(39);
    expect(snapToRange(38.2, 18, 70, 1)).toBe(38);
  });

  test("sub-unit steps strip float dust", () => {
    expect(snapToRange(0.07 * 3, 0, 1, 0.05)).toBe(0.21);
    expect(snapToRange(0.1 + 0.2, 0, 1, 0.05)).toBe(0.3);
  });
});

describe("pctEdit", () => {
  test("shows whole percents for editing, not 0..1", () => {
    expect(pctEdit.toEdit(0.66)).toBe("66");
    expect(pctEdit.toEdit(0)).toBe("0");
    expect(pctEdit.toEdit(1)).toBe("100");
  });

  test("reads whole percents back into 0..1", () => {
    expect(pctEdit.fromEdit("66")).toBeCloseTo(0.66, 10);
    expect(pctEdit.fromEdit("5")).toBeCloseTo(0.05, 10);
    expect(pctEdit.fromEdit("100")).toBe(1);
  });

  test("round-trips exactly through snapToRange", () => {
    for (const pct of [0, 1, 7, 33, 63, 99, 100]) {
      const internal = snapToRange(pctEdit.fromEdit(String(pct)), 0, 1, 0.05);
      expect(pctEdit.toEdit(internal)).toBe(String(pct));
    }
  });

  test("junk is NaN, so the caller keeps the old value", () => {
    expect(pctEdit.fromEdit("abc")).toBeNaN();
    expect(pctEdit.fromEdit("")).toBeNaN();
  });
});

describe("magnitudeEdit", () => {
  test("opens on the exact integer, not the abbreviation", () => {
    // The abbreviation hides whether 45.00M is 45,000,000 or 45,004,321.
    expect(magnitudeEdit.toEdit(45_004_321)).toBe("45004321");
  });

  test("accepts k / m / b shorthand, either case", () => {
    expect(magnitudeEdit.fromEdit("45m")).toBe(45_000_000);
    expect(magnitudeEdit.fromEdit("45M")).toBe(45_000_000);
    expect(magnitudeEdit.fromEdit("1.5m")).toBe(1_500_000);
    expect(magnitudeEdit.fromEdit("200k")).toBe(200_000);
    expect(magnitudeEdit.fromEdit("0.5b")).toBe(500_000_000);
  });

  test("accepts full numbers with separators", () => {
    expect(magnitudeEdit.fromEdit("45,000,000")).toBe(45_000_000);
    expect(magnitudeEdit.fromEdit("45 000 000")).toBe(45_000_000);
    expect(magnitudeEdit.fromEdit("45000000")).toBe(45_000_000);
  });

  test("rejects junk and stray suffixes", () => {
    expect(magnitudeEdit.fromEdit("abc")).toBeNaN();
    expect(magnitudeEdit.fromEdit("")).toBeNaN();
    expect(magnitudeEdit.fromEdit("45x")).toBeNaN();
    expect(magnitudeEdit.fromEdit("45mm")).toBeNaN();
  });

  test("clamps into the population range after parsing", () => {
    const range = [1e6, 2e8, 1e6] as const;
    expect(snapToRange(magnitudeEdit.fromEdit("0.5b"), ...range)).toBe(2e8);
    expect(snapToRange(magnitudeEdit.fromEdit("200k"), ...range)).toBe(1e6);
    expect(snapToRange(magnitudeEdit.fromEdit("45m"), ...range)).toBe(45_000_000);
  });
});
