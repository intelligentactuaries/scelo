import { describe, expect, test } from "bun:test";
import type { ColumnMeta } from "./SoftDataWorkstation";
import { buildColumnStageContext, placeholderHintFor } from "./columnChatHints";

function metaOf(
  partial: Partial<ColumnMeta> & { name: string; type: ColumnMeta["type"] },
): ColumnMeta {
  return { count: 0, missing: 0, unique: 0, ...partial };
}

describe("cap-at-fences example guard", () => {
  test("distinct fences → cap example present with real fence values", () => {
    const ctx = buildColumnStageContext(
      metaOf({ name: "age", type: "number", count: 100, unique: 60, loFence: 10, hiFence: 90 }),
    );
    expect(ctx).toContain('"formula": "min(max(age, 10), 90)"');
  });

  test("degenerate IQR (loFence === hiFence) → no flattening example, warning instead", () => {
    const ctx = buildColumnStageContext(
      metaOf({ name: "flag", type: "number", count: 100, unique: 2, loFence: 1, hiFence: 1 }),
    );
    // The old example would emit min(max(flag, 1), 1) — a constant column.
    expect(ctx).not.toContain("min(max(flag");
    expect(ctx).toContain("DEGENERATE IQR");
  });

  test("missing fences (non-numeric column) → no cap example at all", () => {
    const ctx = buildColumnStageContext(
      metaOf({ name: "label", type: "string", count: 100, unique: 5 }),
    );
    expect(ctx).not.toContain("cap outliers at the fences");
  });
});

describe("recode chat path", () => {
  const marital = metaOf({
    name: "marital_st",
    type: "string",
    count: 100,
    unique: 3,
    topValues: [
      { value: "Separated", count: 40 },
      { value: "Married", count: 40 },
      { value: "Seperated", count: 20 },
    ],
  });

  test("string columns get the fenced recode block, grounded in a real pair", () => {
    const ctx = buildColumnStageContext(marital);
    expect(ctx).toContain("```recode");
    expect(ctx).toContain('{"column": "marital_st", "from": "Seperated", "to": "Separated"}');
  });

  test("numeric columns don't get the recode vocabulary", () => {
    const ctx = buildColumnStageContext(
      metaOf({ name: "age", type: "number", count: 100, unique: 60 }),
    );
    expect(ctx).not.toContain("```recode");
  });

  test("placeholder hint surfaces the near-duplicate pair", () => {
    expect(placeholderHintFor(marital)).toContain('"Seperated" → "Separated"');
  });
});
