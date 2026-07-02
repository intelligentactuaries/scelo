import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Dataset } from "./SoftDataWorkstation";
import type { ColumnMeta } from "./SoftDataWorkstation";
import {
  type CleaningPlan,
  analyseCleaning,
  applyCleaning,
  applyRecodeValue,
  augmentDataset,
  canonicaliseDateCell,
  cleanColumnCells,
  clearNonDateCells,
  coerceNumericValue,
  defaultEnabled,
  detectDateColumns,
  findNearDuplicateLabel,
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
  const meta = (
    name: string,
    type: ColumnMeta["type"],
    count: number,
    unique: number,
  ): ColumnMeta => ({
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
    const metas = [
      meta("id", "number", 4, 4),
      meta("age", "number", 4, 4),
      meta("region", "string", 4, 2),
    ];
    const { dataset, added } = augmentDataset(data, metas, 10);
    expect(added).toBe(10);
    expect(dataset.rows.length).toBe(14);
  });

  test("keeps numeric values within the observed range and integers integral", () => {
    const data = ds([{ age: 20 }, { age: 30 }, { age: 40 }, { age: 50 }, { age: 60 }], ["age"]);
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
      [
        { id: 1, v: 10 },
        { id: 2, v: 11 },
        { id: 3, v: 12 },
        { id: 4, v: 13 },
        { id: 5, v: 14 },
      ],
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

// Minimal ColumnMeta builder for analyse/apply fixtures — only the fields
// the analyser actually reads.
function metaOf(
  partial: Partial<ColumnMeta> & { name: string; type: ColumnMeta["type"] },
): ColumnMeta {
  return { count: 0, missing: 0, unique: 0, ...partial };
}

// Single-op plan builder so apply tests don't have to hand-write the shell.
function planOf(ops: CleaningPlan["ops"], rowCount: number): CleaningPlan {
  return { ops, rowCount, columnCount: 1, sampled: false, sampleSize: rowCount };
}

describe("date canonicalisation is timezone-safe", () => {
  // Bun re-reads TZ on Date construction, so forcing a UTC+2 zone here makes
  // the suite reproduce the original bug on ANY machine: the old native
  // round-trip (`new Date("05/01/2024")` → getUTC*) lands on 2024-04-30.
  // Verified that runtime TZ switching works in bun before relying on it.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Africa/Johannesburg";
  });
  afterAll(() => {
    if (originalTz === undefined) Reflect.deleteProperty(process.env, "TZ");
    else process.env.TZ = originalTz;
  });

  test("the TZ trap is armed (native parse shifts a day on UTC+2)", () => {
    expect(new Date("2024-05-01T00:00:00").getTimezoneOffset()).toBe(-120);
    expect(new Date("05/01/2024").getUTCDate()).toBe(30); // the old bug
  });

  test("US-slashed date keeps its calendar day", () => {
    expect(canonicaliseDateCell("05/01/2024")).toBe("2024-05-01");
    expect(canonicaliseDateCell("01/01/2024")).toBe("2024-01-01");
  });

  test("month-name and ISO forms keep their calendar day", () => {
    expect(canonicaliseDateCell("Jan 1, 2024")).toBe("2024-01-01");
    expect(canonicaliseDateCell("5 Jan 2024")).toBe("2024-01-05");
    expect(canonicaliseDateCell("2024-01-01")).toBe("2024-01-01");
  });

  test("day-first hint respected; unambiguous day-first needs no hint", () => {
    expect(canonicaliseDateCell("05/01/2024", true)).toBe("2024-01-05");
    expect(canonicaliseDateCell("25/12/2024")).toBe("2024-12-25");
  });

  test("naive timestamps normalise textually without a zone shift", () => {
    expect(canonicaliseDateCell("2024-05-01 07:30")).toBe("2024-05-01T07:30:00");
    expect(canonicaliseDateCell("2024-05-01T07:30:15.5")).toBe("2024-05-01T07:30:15.5");
  });

  test("zoned timestamps keep their instant", () => {
    expect(canonicaliseDateCell("2024-05-01T07:30:00+02:00")).toBe("2024-05-01T05:30:00.000Z");
    expect(canonicaliseDateCell("2024-05-01T05:30:00Z")).toBe("2024-05-01T05:30:00.000Z");
  });

  test("junk and out-of-range years are rejected", () => {
    expect(canonicaliseDateCell("not a date")).toBeNull();
    expect(canonicaliseDateCell("2024-02-31")).toBeNull();
    expect(canonicaliseDateCell("0001-01-01")).toBeNull();
  });

  test("applyCleaning parse-dates canonicalises without a day shift", () => {
    const data = ds(
      [{ joined: "05/01/2024" }, { joined: "Feb 25, 2024" }, { joined: "2024-03-14" }],
      ["joined"],
    );
    const plan = planOf([{ key: "parse-dates", columns: ["joined"], cells: 3, safe: true }], 3);
    const out = applyCleaning(data, plan, new Set(["parse-dates"]));
    expect(out.rows[0].joined).toBe("2024-05-01"); // NOT 2024-04-30
    expect(out.rows[1].joined).toBe("2024-02-25");
    expect(out.rows[2].joined).toBe("2024-03-14");
  });

  test("applyCleaning parse-dates infers a day-first column from the data", () => {
    const data = ds([{ d: "29/01/2025" }, { d: "17/03/2025" }, { d: "04/10/2024" }], ["d"]);
    const plan = planOf([{ key: "parse-dates", columns: ["d"], cells: 3, safe: true }], 3);
    const out = applyCleaning(data, plan, new Set(["parse-dates"]));
    expect(out.rows[0].d).toBe("2025-01-29");
    expect(out.rows[2].d).toBe("2024-10-04"); // ambiguous cell follows the column
  });
});

describe("coerce-numeric", () => {
  test("coerceNumericValue keeps numeric prefixes, rejects digit-free residue", () => {
    expect(coerceNumericValue("6+")).toBe(6);
    expect(coerceNumericValue("10 or more")).toBe(10);
    expect(coerceNumericValue("2.5x")).toBe(2.5);
    expect(coerceNumericValue("1,234")).toBe(1234);
    expect(coerceNumericValue("-999")).toBe(-999);
    expect(coerceNumericValue("abc")).toBeNull();
    expect(coerceNumericValue("")).toBeNull();
  });

  test("analyseCleaning suggests coercion for a number column with string residue", () => {
    const data = ds(
      [
        { id: 1, airbags: 2 },
        { id: 2, airbags: 4 },
        { id: 3, airbags: "6+" },
        { id: 4, airbags: 0 },
        { id: 5, airbags: "junk" },
        { id: 6, airbags: 6 },
      ],
      ["id", "airbags"],
    );
    const metas = [
      metaOf({ name: "id", type: "number", count: 6, unique: 6 }),
      metaOf({ name: "airbags", type: "number", count: 6, unique: 5 }),
    ];
    const plan = analyseCleaning(data, metas);
    const op = plan.ops.find((o) => o.key === "coerce-numeric");
    if (op?.key !== "coerce-numeric") throw new Error("expected coerce-numeric op");
    expect(op.columns).toEqual([{ name: "airbags", converted: 1, nulled: 1 }]);
    expect(op.safe).toBe(true);
    expect(defaultEnabled(plan).has("coerce-numeric")).toBe(true);
  });

  test("applyCleaning coerces '6+' → 6 and nulls unparseable residue", () => {
    const data = ds(
      [{ airbags: 2 }, { airbags: "6+" }, { airbags: "junk" }, { airbags: "1,000" }],
      ["airbags"],
    );
    const plan = planOf(
      [
        {
          key: "coerce-numeric",
          columns: [{ name: "airbags", converted: 2, nulled: 1 }],
          cells: 3,
          safe: true,
        },
      ],
      4,
    );
    const out = applyCleaning(data, plan, new Set(["coerce-numeric"]));
    expect(out.rows[0].airbags).toBe(2); // untouched real number
    expect(out.rows[1].airbags).toBe(6);
    expect(out.rows[2].airbags).toBeNull();
    expect(out.rows[3].airbags).toBe(1000);
  });
});

describe("recode-value", () => {
  const maritalRows = (): Dataset => {
    const rows: Dataset["rows"] = [];
    let id = 0;
    for (let i = 0; i < 12; i++) rows.push({ id: id++, marital_st: "Separated" });
    for (let i = 0; i < 6; i++) rows.push({ id: id++, marital_st: "Seperated" });
    for (let i = 0; i < 10; i++) rows.push({ id: id++, marital_st: "Married" });
    return ds(rows, ["id", "marital_st"]);
  };
  const maritalMetas = () => [
    metaOf({ name: "id", type: "number", count: 28, unique: 28 }),
    metaOf({
      name: "marital_st",
      type: "string",
      count: 28,
      unique: 3,
      topValues: [
        { value: "Separated", count: 12 },
        { value: "Married", count: 10 },
        { value: "Seperated", count: 6 },
      ],
    }),
  ];

  test("findNearDuplicateLabel spots the classic typo pair", () => {
    const pair = findNearDuplicateLabel(
      [
        { value: "Separated", count: 12 },
        { value: "Married", count: 10 },
        { value: "Seperated", count: 6 },
      ],
      28,
    );
    expect(pair).toEqual({ from: "Seperated", to: "Separated", count: 6 });
  });

  test("short codes at distance 2 are NOT merged (WEST vs EAST)", () => {
    expect(
      findNearDuplicateLabel(
        [
          { value: "WEST", count: 10 },
          { value: "EAST", count: 8 },
        ],
        18,
      ),
    ).toBeNull();
  });

  test("enumerated code categories are NOT merged (Sector B vs Sector D)", () => {
    expect(
      findNearDuplicateLabel(
        [
          { value: "Sector B", count: 10 },
          { value: "Sector D", count: 8 },
          { value: "Sector A", count: 6 },
        ],
        24,
      ),
    ).toBeNull();
  });

  test("numbered zone codes are NOT merged (Zone 1 vs Zone 2)", () => {
    expect(
      findNearDuplicateLabel(
        [
          { value: "Zone 1", count: 10 },
          { value: "Zone 2", count: 7 },
        ],
        17,
      ),
    ).toBeNull();
  });

  test("case-only pairs are left to lowercase-categoricals", () => {
    expect(
      findNearDuplicateLabel(
        [
          { value: "WEST", count: 10 },
          { value: "west", count: 5 },
        ],
        15,
      ),
    ).toBeNull();
  });

  test("analyseCleaning suggests the recode as a review-only op", () => {
    const plan = analyseCleaning(maritalRows(), maritalMetas());
    const op = plan.ops.find((o) => o.key === "recode-value");
    if (op?.key !== "recode-value") throw new Error("expected recode-value op");
    expect(op.column).toBe("marital_st");
    expect(op.from).toBe("Seperated");
    expect(op.to).toBe("Separated");
    expect(op.safe).toBe(false);
    expect(defaultEnabled(plan).has("recode-value")).toBe(false);
  });

  test("applyCleaning rewrites only the exact from-value in the named column", () => {
    const data = maritalRows();
    const plan = planOf(
      [
        {
          key: "recode-value",
          column: "marital_st",
          from: "Seperated",
          to: "Separated",
          cells: 6,
          safe: false,
        },
      ],
      data.rows.length,
    );
    const out = applyCleaning(data, plan, new Set(["recode-value"]));
    const counts = new Map<string, number>();
    for (const r of out.rows) {
      const v = r.marital_st as string;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.get("Separated")).toBe(18);
    expect(counts.get("Seperated")).toBeUndefined();
    expect(counts.get("Married")).toBe(10);
  });

  test("applyRecodeValue (chat path) rewrites exact matches and counts them", () => {
    const data = ds(
      [{ m: "Seperated" }, { m: "Separated" }, { m: " Seperated " }, { m: null }],
      ["m"],
    );
    const { dataset, changed } = applyRecodeValue(data, "m", "Seperated", "Separated");
    expect(changed).toBe(1);
    expect(dataset.rows[0].m).toBe("Separated");
    expect(dataset.rows[2].m).toBe(" Seperated "); // exact match only
    const noop = applyRecodeValue(data, "missing_col", "a", "b");
    expect(noop.changed).toBe(0);
    expect(noop.dataset).toBe(data);
  });
});

describe("null-future-years", () => {
  const thisYear = new Date().getFullYear();

  test("analyseCleaning flags year-named integer columns with future values", () => {
    const data = ds(
      [
        { car_year: 2005, premium: 2099 },
        { car_year: 2010, premium: 2099 },
        { car_year: thisYear + 1, premium: 810 },
        { car_year: thisYear + 1, premium: 920 },
        { car_year: 1999, premium: 505 },
      ],
      ["car_year", "premium"],
    );
    const metas = [
      metaOf({
        name: "car_year",
        type: "number",
        count: 5,
        unique: 4,
        min: 1999,
        max: thisYear + 1,
      }),
      // premium also holds year-looking values but isn't year-named → ignored
      metaOf({ name: "premium", type: "number", count: 5, unique: 4, min: 505, max: 2099 }),
    ];
    const plan = analyseCleaning(data, metas);
    const op = plan.ops.find((o) => o.key === "null-future-years");
    if (op?.key !== "null-future-years") throw new Error("expected null-future-years op");
    expect(op.columns).toEqual([{ name: "car_year", maxYear: thisYear, count: 2 }]);
    // Suggestion only — must never be pre-selected.
    expect(op.safe).toBe(false);
    expect(defaultEnabled(plan).has("null-future-years")).toBe(false);
  });

  test("columns with no beyond-current-year values produce no op", () => {
    const data = ds([{ car_year: 2005 }, { car_year: thisYear }], ["car_year"]);
    const metas = [
      metaOf({ name: "car_year", type: "number", count: 2, unique: 2, min: 2005, max: thisYear }),
    ];
    const plan = analyseCleaning(data, metas);
    expect(plan.ops.find((o) => o.key === "null-future-years")).toBeUndefined();
  });

  test("applyCleaning nulls only the beyond-cutoff cells in the named column", () => {
    const data = ds(
      [
        { car_year: 2005, other: thisYear + 2 },
        { car_year: thisYear + 1, other: 3 },
      ],
      ["car_year", "other"],
    );
    const plan = planOf(
      [
        {
          key: "null-future-years",
          columns: [{ name: "car_year", maxYear: thisYear, count: 1 }],
          cells: 1,
          safe: false,
        },
      ],
      2,
    );
    const out = applyCleaning(data, plan, new Set(["null-future-years"]));
    expect(out.rows[0].car_year).toBe(2005);
    expect(out.rows[1].car_year).toBeNull();
    expect(out.rows[0].other).toBe(thisYear + 2); // untargeted column untouched
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
