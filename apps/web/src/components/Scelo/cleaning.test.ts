import { describe, expect, test } from "bun:test";
import type { Dataset } from "./SoftDataWorkstation";
import type { ColumnMeta } from "./SoftDataWorkstation";
import {
  augmentDataset,
  cleanColumnCells,
  clearNonDateCells,
  detectDateColumns,
  formatDateStyled,
  reformatDateColumns,
} from "./cleaning";

describe("formatDateStyled", () => {
  test("ISO input → American MM/DD/YYYY", () => {
    expect(formatDateStyled("2024-03-14", "us")).toBe("03/14/2024");
  });

  test("ISO input → European DD/MM/YYYY", () => {
    expect(formatDateStyled("2024-03-14", "eu")).toBe("14/03/2024");
  });

  test("slashed US input → ISO", () => {
    expect(formatDateStyled("3/14/2024", "iso")).toBe("2024-03-14");
  });

  test("month-name input → American", () => {
    expect(formatDateStyled("January 5, 2024", "us")).toBe("01/05/2024");
    expect(formatDateStyled("Feb 25, 2024", "us")).toBe("02/25/2024");
  });

  test("zero-pads single-digit month and day", () => {
    expect(formatDateStyled("2024-01-05", "us")).toBe("01/05/2024");
  });

  test("day-first source (DD-MM-YYYY) read correctly with the hint", () => {
    // 29-01-2025 is unambiguously day-first (29 can't be a month).
    expect(formatDateStyled("29-01-2025", "us", true)).toBe("01/29/2025");
    // ambiguous 04/10/2024 honours the day-first hint → 4 Oct → US 10/04/2024
    expect(formatDateStyled("04/10/2024", "us", true)).toBe("10/04/2024");
    // same input, month-first reading → 4 Apr → stays 04/10/2024
    expect(formatDateStyled("04/10/2024", "us", false)).toBe("04/10/2024");
  });

  test("forces day-first when the first part can't be a month, even without the hint", () => {
    // 23 can't be a month, so this is unambiguously 23 Aug regardless of hint.
    expect(formatDateStyled("23/08/2024", "iso", false)).toBe("2024-08-23");
  });

  test("rejects impossible component combinations", () => {
    expect(formatDateStyled("2024-02-31", "iso")).toBeNull(); // Feb 31
    expect(formatDateStyled("13/13/2024", "iso", true)).toBeNull(); // neither part a month
    expect(formatDateStyled("32/01/2024", "iso", true)).toBeNull(); // day 32
  });

  test("non-date cell returns null (left untouched by callers)", () => {
    expect(formatDateStyled("not a date", "us")).toBeNull();
    expect(formatDateStyled("42", "us")).toBeNull();
  });
});

function ds(rows: Dataset["rows"], columns: string[]): Dataset {
  return { name: "t", columns, rows };
}

describe("detectDateColumns", () => {
  test("flags a ≥80% date-shaped string column, ignores numeric/text", () => {
    const data = ds(
      [
        { joined: "2024-01-01", n: 1, label: "alpha" },
        { joined: "2024-02-15", n: 2, label: "beta" },
        { joined: "2024-03-30", n: 3, label: "gamma" },
        { joined: "2024-04-04", n: 4, label: "delta" },
        { joined: "n/a", n: 5, label: "epsilon" },
      ],
      ["joined", "n", "label"],
    );
    expect(detectDateColumns(data)).toEqual(["joined"]);
  });

  test("returns nothing on an empty dataset", () => {
    expect(detectDateColumns(ds([], ["a"]))).toEqual([]);
  });
});

describe("reformatDateColumns", () => {
  test("rewrites only the named column and counts changed cells", () => {
    const data = ds(
      [
        { joined: "2024-01-05", other: "2020-12-31" },
        { joined: "2024-12-25", other: "2020-01-01" },
      ],
      ["joined", "other"],
    );
    const { dataset, changed } = reformatDateColumns(data, ["joined"], "us");
    expect(changed).toBe(2);
    expect(dataset.rows[0].joined).toBe("01/05/2024");
    expect(dataset.rows[1].joined).toBe("12/25/2024");
    // untouched column keeps its original ISO values
    expect(dataset.rows[0].other).toBe("2020-12-31");
  });

  test("leaves non-date cells alone and does not count them", () => {
    const data = ds([{ joined: "2024-01-05" }, { joined: "tbd" }], ["joined"]);
    const { dataset, changed } = reformatDateColumns(data, ["joined"], "us");
    expect(changed).toBe(1);
    expect(dataset.rows[1].joined).toBe("tbd");
  });

  test("already-formatted values produce zero changes", () => {
    const data = ds([{ joined: "01/05/2024" }], ["joined"]);
    const { changed } = reformatDateColumns(data, ["joined"], "us");
    expect(changed).toBe(0);
  });

  test("mixed-format day-first column (the real 'Joined Date' case) → American", () => {
    // Lifted from the actual screenshot: day-first slashed/dashed, ISO, and
    // month-name values all in one column, plus a null and a junk cell.
    const data = ds(
      [
        { joined: "29-01-2025" }, // day-first → 29 Jan 2025
        { joined: "17/03/2025" }, // day-first → 17 Mar 2025
        { joined: "Feb 25, 2024" }, // month-name
        { joined: "11/02/2024" }, // ambiguous → day-first wins → 11 Feb
        { joined: "2024-01-25" }, // ISO
        { joined: "23/08/2024" }, // day-first → 23 Aug
        { joined: null }, // missing
        { joined: "Aug 17, 2024" }, // month-name
        { joined: "31-10-2024" }, // day-first → 31 Oct
        { joined: "not a date" }, // junk
      ],
      ["joined"],
    );
    const { dataset, changed, columns } = reformatDateColumns(data, ["joined"], "us");
    expect(columns[0].dayFirst).toBe(true); // inferred from 29/17/23/31 leading parts
    expect(dataset.rows[0].joined).toBe("01/29/2025");
    expect(dataset.rows[1].joined).toBe("03/17/2025");
    expect(dataset.rows[2].joined).toBe("02/25/2024");
    expect(dataset.rows[3].joined).toBe("02/11/2024"); // 11 Feb → US 02/11
    expect(dataset.rows[4].joined).toBe("01/25/2024"); // ISO → US
    expect(dataset.rows[5].joined).toBe("08/23/2024");
    expect(dataset.rows[6].joined).toBeNull(); // missing left alone
    expect(dataset.rows[7].joined).toBe("08/17/2024");
    expect(dataset.rows[8].joined).toBe("10/31/2024");
    expect(dataset.rows[9].joined).toBe("not a date"); // junk left alone
    expect(changed).toBe(8);
    expect(columns[0].unparsed).toBe(1); // only the junk cell
  });

  test("detectDateColumns finds a day-first column the native parser would reject", () => {
    const data = ds(
      [
        { d: "29-01-2025" },
        { d: "17/03/2025" },
        { d: "23/08/2024" },
        { d: "31-10-2024" },
        { d: "27/10/2024" },
      ],
      ["d"],
    );
    expect(detectDateColumns(data)).toEqual(["d"]);
  });
});

describe("clearNonDateCells", () => {
  test("nulls non-date values, keeps real dates (incl. day-first)", () => {
    const data = ds(
      [
        { joined: "29-01-2025", other: "keep" }, // day-first date → kept
        { joined: "Feb 25, 2024", other: "keep" }, // month-name → kept
        { joined: "not a date", other: "keep" }, // junk → nulled
        { joined: "n/a", other: "keep" }, // junk → nulled
        { joined: null, other: "keep" }, // already null → untouched
        { joined: "2024-01-25", other: "keep" }, // ISO → kept
      ],
      ["joined", "other"],
    );
    const { dataset, cleared } = clearNonDateCells(data, "joined");
    expect(cleared).toBe(2);
    expect(dataset.rows[0].joined).toBe("29-01-2025");
    expect(dataset.rows[2].joined).toBeNull();
    expect(dataset.rows[3].joined).toBeNull();
    expect(dataset.rows[4].joined).toBeNull();
    // untouched column intact
    expect(dataset.rows[2].other).toBe("keep");
  });

  test("no non-dates → returns the same dataset reference and cleared 0", () => {
    const data = ds([{ d: "2024-01-01" }, { d: "2024-02-02" }], ["d"]);
    const { dataset, cleared } = clearNonDateCells(data, "d");
    expect(cleared).toBe(0);
    expect(dataset).toBe(data);
  });
});

describe("augmentDataset", () => {
  const meta = (name: string, type: ColumnMeta["type"], count: number, unique: number): ColumnMeta => ({
    name,
    type,
    count,
    missing: 0,
    unique,
  });

  test("appends the requested number of rows", () => {
    const data = ds(
      [
        { id: 1, age: 30, region: "west" },
        { id: 2, age: 45, region: "east" },
        { id: 3, age: 51, region: "west" },
        { id: 4, age: 38, region: "east" },
      ],
      ["id", "age", "region"],
    );
    const metas = [meta("id", "number", 4, 4), meta("age", "number", 4, 4), meta("region", "string", 4, 2)];
    const { dataset, added } = augmentDataset(data, metas, 10);
    expect(added).toBe(10);
    expect(dataset.rows.length).toBe(14);
  });

  test("keeps numeric values within the observed range and integers integral", () => {
    const data = ds(
      [{ age: 20 }, { age: 30 }, { age: 40 }, { age: 50 }, { age: 60 }],
      ["age"],
    );
    const metas = [meta("age", "number", 5, 5)];
    const { dataset } = augmentDataset(data, metas, 200);
    for (const r of dataset.rows) {
      const v = r.age as number;
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(60);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test("categoricals only ever take real observed values", () => {
    const data = ds(
      [{ region: "west" }, { region: "east" }, { region: "north" }, { region: "south" }],
      ["region"],
    );
    const metas = [meta("region", "string", 4, 4)];
    const { dataset } = augmentDataset(data, metas, 100);
    const allowed = new Set(["west", "east", "north", "south"]);
    for (const r of dataset.rows) expect(allowed.has(r.region as string)).toBe(true);
  });

  test("id-like near-unique integer column stays unique (extended past max)", () => {
    const data = ds(
      [{ id: 1, v: 10 }, { id: 2, v: 11 }, { id: 3, v: 12 }, { id: 4, v: 13 }, { id: 5, v: 14 }],
      ["id", "v"],
    );
    // id is 100% unique integer → treated as an identifier
    const metas = [meta("id", "number", 5, 5), meta("v", "number", 5, 5)];
    const { dataset } = augmentDataset(data, metas, 20);
    const ids = dataset.rows.map((r) => r.id as number);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate IDs
  });

  test("empty dataset or non-positive count is a no-op", () => {
    const empty = ds([], ["a"]);
    expect(augmentDataset(empty, [meta("a", "number", 0, 0)], 10).added).toBe(0);
    const data = ds([{ a: 1 }], ["a"]);
    expect(augmentDataset(data, [meta("a", "number", 1, 1)], 0).added).toBe(0);
  });
});

describe("cleanColumnCells", () => {
  test("trims, collapses whitespace, and nulls missing-markers in one column", () => {
    const data = ds(
      [
        { name: "  Alice  ", keep: "  x  " }, // trim → "Alice", other col untouched
        { name: "Bob\t\tJones", keep: "y" }, // collapse internal whitespace
        { name: "N/A", keep: "y" }, // missing-marker → null
        { name: "Carol", keep: "y" }, // already clean
      ],
      ["name", "keep"],
    );
    const { dataset, tidied, nulled } = cleanColumnCells(data, "name");
    expect(dataset.rows[0].name).toBe("Alice");
    expect(dataset.rows[1].name).toBe("Bob Jones");
    expect(dataset.rows[2].name).toBeNull();
    expect(dataset.rows[3].name).toBe("Carol");
    expect(tidied).toBe(2);
    expect(nulled).toBe(1);
    // other column untouched
    expect(dataset.rows[0].keep).toBe("  x  ");
  });
});
