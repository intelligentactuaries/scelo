import { describe, expect, test } from "bun:test";
import type { ColumnMeta, Dataset } from "./SoftDataWorkstation";
import {
  convertColumnToNumber,
  convertColumnToString,
  dropColumnFromDataset,
  fillMissingInColumn,
  parseColumnOpIntent,
  removeOutlierRows,
  resolveColumnsMentioned,
  roundColumnValues,
  transformColumnCase,
} from "./columnOps";

const ds = (rows: Dataset["rows"], columns?: string[]): Dataset => ({
  name: "t.csv",
  columns: columns ?? Object.keys(rows[0] ?? {}),
  rows,
});

describe("parseColumnOpIntent", () => {
  test("the exact reported phrase executes a string conversion", () => {
    expect(parseColumnOpIntent("convert this column to string from mixed")).toEqual({
      kind: "to-string",
    });
  });

  test("string-conversion variants", () => {
    expect(parseColumnOpIntent("make this text")).toEqual({ kind: "to-string" });
    expect(parseColumnOpIntent("cast to string")).toEqual({ kind: "to-string" });
    expect(parseColumnOpIntent("stringify the values in this column")).toEqual({
      kind: "to-string",
    });
  });

  test("numeric conversion, incl. integer flavour", () => {
    expect(parseColumnOpIntent("convert this column to numeric")).toEqual({
      kind: "to-number",
      integer: false,
    });
    expect(parseColumnOpIntent("turn these into integers")).toEqual({
      kind: "to-number",
      integer: true,
    });
    expect(parseColumnOpIntent("coerce the text cells to numbers")).toEqual({
      kind: "to-number",
      integer: false,
    });
  });

  test("destination after 'to' wins when both types are named", () => {
    expect(parseColumnOpIntent("convert this text column to numbers")).toEqual({
      kind: "to-number",
      integer: false,
    });
    expect(parseColumnOpIntent("convert the numeric column to string")).toEqual({
      kind: "to-string",
    });
  });

  test("case transforms", () => {
    expect(parseColumnOpIntent("make everything lowercase")).toEqual({
      kind: "case",
      mode: "lower",
    });
    expect(parseColumnOpIntent("uppercase this column")).toEqual({ kind: "case", mode: "upper" });
    expect(parseColumnOpIntent("capitalize the labels")).toEqual({ kind: "case", mode: "title" });
    // "make the text lowercase" is a case ask even though it names "text".
    expect(parseColumnOpIntent("make the text lowercase")).toEqual({
      kind: "case",
      mode: "lower",
    });
  });

  test("rounding with and without explicit decimals", () => {
    expect(parseColumnOpIntent("round this column")).toEqual({ kind: "round", decimals: 0 });
    expect(parseColumnOpIntent("round to 2 decimal places")).toEqual({
      kind: "round",
      decimals: 2,
    });
    expect(parseColumnOpIntent("round premiums to 3dp")).toEqual({ kind: "round", decimals: 3 });
  });

  test("fill missing variants", () => {
    expect(parseColumnOpIntent("fill missing values with the median")).toEqual({
      kind: "fill-missing",
      filler: "median",
    });
    expect(parseColumnOpIntent("impute the blanks with 0")).toEqual({
      kind: "fill-missing",
      filler: "zero",
    });
    expect(parseColumnOpIntent("replace nulls with unknown")).toEqual({
      kind: "fill-missing",
      filler: { value: "unknown" },
    });
    expect(parseColumnOpIntent("fill the missing cells")).toEqual({
      kind: "fill-missing",
      filler: "auto",
    });
  });

  test("outlier removal and column drop are kept apart", () => {
    expect(parseColumnOpIntent("remove the outliers")).toEqual({ kind: "remove-outliers" });
    expect(parseColumnOpIntent("drop this column")).toEqual({ kind: "drop-column" });
    expect(parseColumnOpIntent("delete the column")).toEqual({ kind: "drop-column" });
    // row/value-level nouns must never resolve to a column drop
    expect(parseColumnOpIntent("remove the duplicate rows in this column")).toBeNull();
    expect(parseColumnOpIntent("delete the missing values")).toBeNull();
  });

  test("trim", () => {
    expect(parseColumnOpIntent("trim the whitespace")).toEqual({ kind: "trim" });
    expect(parseColumnOpIntent("strip spaces in this column")).toEqual({ kind: "trim" });
  });

  test("questions fall through to the AI", () => {
    expect(parseColumnOpIntent("what would happen if I convert this to string?")).toBeNull();
    expect(parseColumnOpIntent("should I round this column")).toBeNull();
    expect(parseColumnOpIntent("how do I convert this to numeric")).toBeNull();
    expect(parseColumnOpIntent("can you explain outliers")).toBeNull();
  });

  test("date-flavoured requests are left to the date handlers", () => {
    expect(parseColumnOpIntent("convert the dates to string")).toBeNull();
    expect(parseColumnOpIntent("make this date column iso")).toBeNull();
  });

  test("unrelated chatter falls through", () => {
    expect(parseColumnOpIntent("this column looks odd to me")).toBeNull();
    expect(parseColumnOpIntent("thanks, looks great")).toBeNull();
  });
});

describe("resolveColumnsMentioned", () => {
  const columns = ["age", "sum_assured", "premium", "region code"];
  test("whole-word, case-insensitive match", () => {
    expect(resolveColumnsMentioned("convert Premium to string", columns)).toEqual(["premium"]);
    expect(resolveColumnsMentioned("round age to 0", columns)).toEqual(["age"]);
  });
  test("substring inside a longer word does not match", () => {
    expect(resolveColumnsMentioned("what an outrageous message", columns)).toEqual([]);
  });
  test("multi-word and underscore names match", () => {
    expect(resolveColumnsMentioned("uppercase the region code column", columns)).toEqual([
      "region code",
    ]);
    expect(resolveColumnsMentioned("round sum_assured", columns)).toEqual(["sum_assured"]);
  });
});

describe("convertColumnToString", () => {
  test("numbers become strings; sampled metadata survives", () => {
    const d: Dataset = { ...ds([{ a: 1 }, { a: "x" }, { a: null }]), sampled: true };
    const { dataset: next, converted } = convertColumnToString(d, "a");
    expect(converted).toBe(1);
    expect(next.rows.map((r) => r.a)).toEqual(["1", "x", null]);
    expect(next.sampled).toBe(true);
  });
  test("no-op returns the same dataset object", () => {
    const d = ds([{ a: "x" }]);
    expect(convertColumnToString(d, "a").dataset).toBe(d);
  });
});

describe("convertColumnToNumber", () => {
  test("coerces flexible numerics and nulls the rest", () => {
    const d = ds([{ a: "1,200.50" }, { a: "6+" }, { a: "n/a" }, { a: 3 }, { a: null }]);
    const { dataset: next, converted, nulled } = convertColumnToNumber(d, "a");
    expect(converted).toBe(2);
    expect(nulled).toBe(1);
    expect(next.rows.map((r) => r.a)).toEqual([1200.5, 6, null, 3, null]);
  });
  test("integer mode rounds existing floats too", () => {
    const d = ds([{ a: 2.7 }, { a: "3.2" }]);
    const { dataset: next } = convertColumnToNumber(d, "a", true);
    expect(next.rows.map((r) => r.a)).toEqual([3, 3]);
  });
});

describe("transformColumnCase / roundColumnValues", () => {
  test("title case", () => {
    const d = ds([{ a: "hello world" }, { a: 5 }]);
    const { dataset: next, changed } = transformColumnCase(d, "a", "title");
    expect(changed).toBe(1);
    expect(next.rows[0].a).toBe("Hello World");
    expect(next.rows[1].a).toBe(5);
  });
  test("round to 2dp leaves strings alone", () => {
    const d = ds([{ a: 12.34567 }, { a: "keep" }]);
    const { dataset: next, changed } = roundColumnValues(d, "a", 2);
    expect(changed).toBe(1);
    expect(next.rows[0].a).toBe(12.35);
    expect(next.rows[1].a).toBe("keep");
  });
});

describe("fillMissingInColumn", () => {
  test("auto picks median for numeric-majority columns", () => {
    const d = ds([{ a: 1 }, { a: 3 }, { a: 10 }, { a: null }]);
    const { dataset: next, filled, fillValue } = fillMissingInColumn(d, "a", "auto");
    expect(filled).toBe(1);
    expect(fillValue).toBe(3);
    expect(next.rows[3].a).toBe(3);
  });
  test("auto picks mode for string columns", () => {
    const d = ds([{ a: "x" }, { a: "x" }, { a: "y" }, { a: null }]);
    const { fillValue } = fillMissingInColumn(d, "a", "auto");
    expect(fillValue).toBe("x");
  });
  test("literal value keeps numeric typing when it parses", () => {
    const d = ds([{ a: 1 }, { a: null }]);
    const { fillValue } = fillMissingInColumn(d, "a", { value: "7" });
    expect(fillValue).toBe(7);
  });
  test("all-null column cannot derive a statistical fill", () => {
    const d = ds([{ a: null }, { a: null }]);
    const { filled, fillValue } = fillMissingInColumn(d, "a", "median");
    expect(filled).toBe(0);
    expect(fillValue).toBeNull();
  });
});

describe("dropColumnFromDataset / removeOutlierRows", () => {
  test("drop removes schema entry and row keys", () => {
    const d = ds([{ a: 1, b: "x" }]);
    const { dataset: next } = dropColumnFromDataset(d, "a");
    expect(next.columns).toEqual(["b"]);
    expect(next.rows[0]).toEqual({ b: "x" });
  });
  test("outlier rows outside the meta fences are removed; nulls kept", () => {
    const d = ds([{ a: 1 }, { a: 2 }, { a: 900 }, { a: null }]);
    const meta = { name: "a", loFence: 0, hiFence: 10 } as unknown as ColumnMeta;
    const res = removeOutlierRows(d, "a", meta);
    expect(res).not.toBeNull();
    expect(res?.removed).toBe(1);
    expect(res?.dataset.rows.map((r) => r.a)).toEqual([1, 2, null]);
  });
  test("non-numeric column (no fences) yields null", () => {
    const d = ds([{ a: "x" }]);
    expect(removeOutlierRows(d, "a", { name: "a" } as unknown as ColumnMeta)).toBeNull();
  });
});
