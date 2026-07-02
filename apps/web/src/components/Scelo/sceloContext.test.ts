import { describe, expect, test } from "bun:test";
import type { Dataset } from "./SoftDataWorkstation";
import { sliceDatasetForPersist } from "./sceloContext";

// ── fixtures ─────────────────────────────────────────────────────────────

function makeDataset(rowCount: number): Dataset {
  return {
    name: "claims.csv",
    columns: ["id", "sum_insurd"],
    rows: Array.from({ length: rowCount }, (_, i) => ({ id: i, sum_insurd: i * 100 })),
  };
}

describe("sliceDatasetForPersist", () => {
  test("dataset under the cap passes through untouched (same object)", () => {
    const dataset = makeDataset(100);
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out).toBe(dataset);
    expect(out.sampled).toBeUndefined();
    expect(out.sourceTotalRows).toBeUndefined();
  });

  test("dataset over the cap is sliced AND stamped with honest provenance", () => {
    const dataset = makeDataset(12_000);
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out.rows).toHaveLength(5000);
    expect(out.rows[0]).toEqual({ id: 0, sum_insurd: 0 });
    expect(out.sampled).toBe(true);
    // Full in-memory count at save time — the banner's denominator.
    expect(out.sourceTotalRows).toBe(12_000);
    // The live dataset is never mutated.
    expect(dataset.rows).toHaveLength(12_000);
  });

  test("an import-sampled dataset keeps the source file's true total", () => {
    // 2M-row file imported under the 250k row cap, then persisted at 5k:
    // sourceTotalRows must stay 2,000,000, not shrink to 250,000.
    const dataset = {
      ...makeDataset(250_000),
      sampled: true,
      sourceTotalRows: 2_000_000,
    };
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out.rows).toHaveLength(5000);
    expect(out.sampled).toBe(true);
    expect(out.sourceTotalRows).toBe(2_000_000);
  });

  test("a zero cap (quota last resort) keeps the stamp with no rows", () => {
    const dataset = makeDataset(9000);
    const out = sliceDatasetForPersist(dataset, 0);
    expect(out.rows).toHaveLength(0);
    expect(out.sampled).toBe(true);
    expect(out.sourceTotalRows).toBe(9000);
  });

  test("provenance fields survive the JSON round-trip used by persistence", () => {
    const out = sliceDatasetForPersist(makeDataset(6000), 5000);
    const revived = JSON.parse(JSON.stringify(out)) as typeof out;
    expect(revived.sampled).toBe(true);
    expect(revived.sourceTotalRows).toBe(6000);
    expect(revived.rows).toHaveLength(5000);
  });
});
