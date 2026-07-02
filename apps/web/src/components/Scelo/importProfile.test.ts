// Import-path coercion + scale-safe profiling. The synthetic columns here
// mirror the quirks of the real 2M-row motor CSV the pipeline was audited
// against: literal "NULL" cells, "6+" mixed numerics, ISO date strings,
// leading-zero / oversized ids, discrete columns with IQR 0.

import { describe, expect, test } from "bun:test";
import {
  type Dataset,
  coerceCsvCell,
  sniffDelimitedText,
  summariseDataset,
} from "./SoftDataWorkstation";

describe("coerceCsvCell", () => {
  test("missing tokens map to null at parse time", () => {
    for (const t of ["", "  ", "NULL", "null", "Na", "N/A", "nan", "None", "-"]) {
      expect(coerceCsvCell(t)).toBeNull();
    }
  });

  test("strict numerics parse", () => {
    expect(coerceCsvCell("42")).toBe(42);
    expect(coerceCsvCell("-999")).toBe(-999);
    expect(coerceCsvCell("3.14")).toBe(3.14);
    expect(coerceCsvCell(".5")).toBe(0.5);
    expect(coerceCsvCell("1e3")).toBe(1000);
    expect(coerceCsvCell(" 7 ")).toBe(7);
    expect(coerceCsvCell("0")).toBe(0);
    expect(coerceCsvCell("0.582")).toBe(0.582);
  });

  test("mixed / id-like strings stay strings", () => {
    expect(coerceCsvCell("6+")).toBe("6+");
    expect(coerceCsvCell("007")).toBe("007");
    expect(coerceCsvCell("9007199254740993")).toBe("9007199254740993"); // > 2^53
    expect(coerceCsvCell("A5706148691089")).toBe("A5706148691089");
    expect(coerceCsvCell("LIM")).toBe("LIM");
    expect(coerceCsvCell("2023-05-15")).toBe("2023-05-15");
    expect(coerceCsvCell("0x1f")).toBe("0x1f"); // Number() would parse this
    expect(coerceCsvCell("Infinity")).toBe("Infinity");
  });
});

describe("sniffDelimitedText", () => {
  test("rejects binary content", async () => {
    const bin = new Blob([new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0x01, 0x02, 0x03])]);
    expect(await sniffDelimitedText(bin)).toBeNull();
  });

  test("detects tab-delimited text", async () => {
    const tsv = new Blob(["a\tb\tc\n1\t2\t3\n4\t5\t6\n"]);
    expect(await sniffDelimitedText(tsv)).toBe("\t");
  });

  test("detects comma-delimited text", async () => {
    const csv = new Blob(["a,b,c\n1,2,3\n4,5,6\n"]);
    expect(await sniffDelimitedText(csv)).toBe(",");
  });

  test("rejects prose with no consistent delimiter", async () => {
    const prose = new Blob(["hello world\nthis is not a table\nno delimiters here\n"]);
    expect(await sniffDelimitedText(prose)).toBeNull();
  });
});

function ds(column: string, values: Array<number | string | null>): Dataset {
  return { name: "t", columns: [column], rows: values.map((v) => ({ [column]: v })) };
}

describe("summariseDataset · date detection", () => {
  test("ISO date columns re-type to date with range + per-year histogram", () => {
    const values = Array.from({ length: 60 }, (_, i) => `202${i % 3}-0${(i % 9) + 1}-15`);
    const [meta] = summariseDataset(ds("dob", values));
    expect(meta.type).toBe("date");
    expect(meta.dateMin).toBe("2020-01-15");
    expect(meta.dateMax).toBe("2022-09-15");
    expect(meta.yearHistogram?.map((y) => y.year)).toEqual([2020, 2021, 2022]);
    expect(meta.topValues).toBeUndefined();
  });

  test("categorical codes are NOT dates", () => {
    const values = Array.from({ length: 40 }, (_, i) => ["GP", "LIM", "WC", "KZN"][i % 4]);
    const [meta] = summariseDataset(ds("province", values));
    expect(meta.type).toBe("string");
    expect(meta.topValues?.length).toBeGreaterThan(0);
  });

  test("mixed-format date columns stay categorical (conservative)", () => {
    // Only half the values are strictly ISO-shaped — below the 80% bar.
    const values = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? "2024-01-15" : "15/01/2024",
    );
    const [meta] = summariseDataset(ds("mixed_dates", values));
    expect(meta.type).toBe("string");
  });

  test("date-shaped strings with impossible month/day do not count", () => {
    const values = Array.from({ length: 40 }, () => "2024-99-99");
    const [meta] = summariseDataset(ds("code", values));
    expect(meta.type).toBe("string");
  });
});

describe("summariseDataset · mixed numeric columns", () => {
  test("mixedCount reports non-numeric cells in a number-typed column", () => {
    const values: Array<number | string> = Array.from({ length: 100 }, (_, i) =>
      i % 10 === 0 ? "6+" : i % 7,
    );
    const [meta] = summariseDataset(ds("airbags", values));
    expect(meta.type).toBe("number");
    expect(meta.mixedCount).toBe(10);
    // Mixed cells are present, not missing — missing stays honest.
    expect(meta.missing).toBe(0);
  });

  test("clean numeric columns report no mixedCount", () => {
    const values = Array.from({ length: 50 }, (_, i) => i);
    const [meta] = summariseDataset(ds("hp", values));
    expect(meta.mixedCount).toBeUndefined();
  });
});

describe("summariseDataset · outliers", () => {
  test("IQR === 0 skips outlier classification entirely", () => {
    // 90% one value, 10% another — fences would collapse onto the quartiles
    // and flag every 6 as an outlier without the guard.
    const values = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 6 : 5));
    const [meta] = summariseDataset(ds("no_gears", values));
    expect(meta.outliers ?? []).toHaveLength(0);
    expect(meta.outlierCount ?? 0).toBe(0);
    // Whiskers still span the observed range.
    expect(meta.boxLo).toBe(5);
    expect(meta.boxHi).toBe(6);
  });

  test("outlier values are capped at 500 with the true count preserved", () => {
    const values: number[] = [];
    for (let i = 0; i < 5000; i++) values.push(i % 10);
    for (let i = 0; i < 700; i++) values.push(1_000_000 + i);
    const [meta] = summariseDataset(ds("sum_insurd", values));
    expect(meta.outlierCount).toBe(700);
    expect(meta.outliers).toHaveLength(500);
    // The thin is uniform over the sorted list — extremes survive.
    expect(meta.outliers?.[0]).toBe(1_000_000);
  });
});

describe("summariseDataset · stride sampling above 200k rows", () => {
  test("flags sampledStats and keeps count/missing exact", () => {
    const N = 250_000;
    const rows = new Array(N);
    for (let i = 0; i < N; i++) {
      rows[i] = { x: i % 1000 === 0 ? null : i % 97 };
    }
    const dataset: Dataset = { name: "big", columns: ["x"], rows };
    const [meta] = summariseDataset(dataset);
    expect(meta.sampledStats).toBe(true);
    expect(meta.count).toBe(N); // exact
    expect(meta.missing).toBe(250); // exact, from the full pass
    expect(meta.type).toBe("number");
    expect(meta.min).toBe(0); // exact min/max survive sampling
    expect(meta.max).toBe(96);
    expect(meta.q1).toBeDefined(); // order stats present, just sampled
  });

  test("small datasets stay exact and unflagged", () => {
    const [meta] = summariseDataset(ds("age", [1, 2, 3, 4, 5]));
    expect(meta.sampledStats).toBeUndefined();
    expect(meta.mean).toBe(3);
  });
});
