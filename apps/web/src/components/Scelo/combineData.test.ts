import { describe, expect, test } from "bun:test";
import type { Dataset, Row } from "./SoftDataWorkstation";
import {
  combineAll,
  combinePair,
  detectJoinKeys,
  previewCombine,
  suggestCombine,
} from "./combineData";
import type { CombineStep } from "./combineData";

function ds(name: string, columns: string[], rows: Array<Array<unknown>>): Dataset {
  return {
    name,
    columns,
    rows: rows.map((cells) => {
      const row: Row = {};
      columns.forEach((c, i) => {
        row[c] = (cells[i] ?? null) as Row[string];
      });
      return row;
    }),
  };
}

const policies = ds(
  "policies.csv",
  ["id", "province", "sum_insurd"],
  [
    ["A1", "GP", 100_000],
    ["A2", "WC", 250_000],
    ["A3", "KZN", 175_000],
    ["A4", "EC", 90_000],
  ],
);

const claims = ds(
  "claims.csv",
  ["ID", "past_claims", "excess"],
  [
    ["A1", 2, 5000],
    ["A2", 0, 3000],
    ["A3", 1, 4000],
  ],
);

describe("detectJoinKeys", () => {
  test("finds the id key case-insensitively with overlap stats", () => {
    const keys = detectJoinKeys(policies, claims);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0].baseColumn).toBe("id");
    expect(keys[0].otherColumn).toBe("ID");
    expect(keys[0].overlap).toBeCloseTo(0.75, 2); // 3 of 4 base ids match
    expect(keys[0].uniqueness).toBe(1);
    expect(keys[0].idLikeName).toBe(true);
  });

  test("rejects shared columns whose values do not line up", () => {
    const other = ds(
      "other.csv",
      ["id", "x"],
      [
        ["Z9", 1],
        ["Z8", 2],
      ],
    );
    expect(detectJoinKeys(policies, other)).toEqual([]);
  });
});

describe("suggestCombine", () => {
  test("different schemas + shared key -> left join", () => {
    const s = suggestCombine(policies, claims);
    expect(s.step.strategy).toBe("join-left");
    expect(s.step.key).toBe("id");
    expect(s.step.rightKey).toBe("ID");
    expect(s.rationale).toContain("left join");
  });

  test("identical schema with disjoint ids -> append with dedupe", () => {
    const batch2 = ds(
      "batch2.csv",
      ["id", "province", "sum_insurd"],
      [
        ["B1", "FS", 120_000],
        ["B2", "NW", 80_000],
      ],
    );
    const s = suggestCombine(policies, batch2);
    expect(s.step.strategy).toBe("append");
    expect(s.step.dedupeExact).toBe(true);
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  test("identical schema but same ids with extra column -> join, not row doubling", () => {
    const rescored = ds(
      "rescored.csv",
      ["id", "province", "sum_insurd", "rescored_premium"],
      [
        ["A1", "GP", 100_000, 1200],
        ["A2", "WC", 250_000, 2900],
        ["A3", "KZN", 175_000, 2100],
        ["A4", "EC", 90_000, 950],
      ],
    );
    const s = suggestCombine(policies, rescored);
    expect(s.step.strategy).toBe("join-left");
  });

  test("no overlap at all -> low-confidence union append", () => {
    const weather = ds("weather.csv", ["date", "t2m"], [["2024-01-01", 21.5]]);
    const s = suggestCombine(policies, weather);
    expect(s.step.strategy).toBe("append");
    expect(s.confidence).toBeLessThan(0.3);
  });
});

describe("combinePair join", () => {
  test("left join attaches columns, keeps unmatched with nulls", () => {
    const { dataset, stats } = combinePair(policies, claims, {
      strategy: "join-left",
      key: "id",
      rightKey: "ID",
    });
    expect(dataset.columns).toEqual(["id", "province", "sum_insurd", "past_claims", "excess"]);
    expect(dataset.rows.length).toBe(4);
    expect(dataset.rows[0].past_claims).toBe(2);
    expect(dataset.rows[3].past_claims).toBeNull(); // A4 has no claims row
    expect(stats.matched).toBe(3);
    expect(stats.unmatched).toBe(1);
    expect(stats.duplicateRightKeys).toBe(0);
  });

  test("inner join drops unmatched base rows", () => {
    const { dataset, stats } = combinePair(policies, claims, {
      strategy: "join-inner",
      key: "id",
      rightKey: "ID",
    });
    expect(dataset.rows.length).toBe(3);
    expect(stats.unmatched).toBe(1);
  });

  test("duplicate right keys attach first match and are counted — no row explosion", () => {
    const dupes = ds(
      "dupes.csv",
      ["id", "note"],
      [
        ["A1", "first"],
        ["A1", "second"],
        ["A2", "only"],
      ],
    );
    const { dataset, stats } = combinePair(policies, dupes, {
      strategy: "join-left",
      key: "id",
    });
    expect(dataset.rows.length).toBe(4); // still one row per base row
    expect(dataset.rows[0].note).toBe("first");
    expect(stats.duplicateRightKeys).toBe(1);
  });

  test("colliding non-key columns get suffixed instead of overwritten", () => {
    const rescore = ds("rescore.csv", ["id", "sum_insurd"], [["A1", 111_000]]);
    const { dataset, stats } = combinePair(policies, rescore, {
      strategy: "join-left",
      key: "id",
    });
    expect(dataset.columns).toContain("sum_insurd_2");
    expect(dataset.rows[0].sum_insurd).toBe(100_000); // base untouched
    expect(dataset.rows[0].sum_insurd_2).toBe(111_000);
    expect(stats.renamedColumns).toEqual(["sum_insurd_2"]);
  });
});

describe("combinePair append", () => {
  test("case-insensitive column alignment + union of new columns", () => {
    const more = ds("more.csv", ["ID", "Province", "broker"], [["B1", "MP", "Acme"]]);
    const { dataset } = combinePair(policies, more, { strategy: "append" });
    expect(dataset.columns).toEqual(["id", "province", "sum_insurd", "broker"]);
    const added = dataset.rows[4];
    expect(added.id).toBe("B1");
    expect(added.province).toBe("MP");
    expect(added.sum_insurd).toBeNull();
    expect(added.broker).toBe("Acme");
    expect(dataset.rows[0].broker).toBeNull(); // base rows padded
  });

  test("dedupeExact drops exact duplicates and reports them", () => {
    const overlap = ds(
      "overlap.csv",
      ["id", "province", "sum_insurd"],
      [
        ["A1", "GP", 100_000], // exact duplicate of base row 0
        ["B9", "LP", 60_000],
      ],
    );
    const { dataset, stats } = combinePair(policies, overlap, {
      strategy: "append",
      dedupeExact: true,
    });
    expect(dataset.rows.length).toBe(5);
    expect(stats.matched).toBe(1);
    expect(stats.unmatched).toBe(1); // the dropped duplicate
  });
});

describe("combineAll", () => {
  test("three-way: join then append, provenance name, no cap", () => {
    const batch2 = ds(
      "batch2.csv",
      ["id", "province", "sum_insurd", "past_claims", "excess"],
      [["C1", "FS", 70_000, 0, 2000]],
    );
    const { dataset, stats, truncated } = combineAll(
      policies,
      [
        { dataset: claims, step: { strategy: "join-left", key: "id", rightKey: "ID" } },
        { dataset: batch2, step: { strategy: "append", dedupeExact: true } },
      ],
      250_000,
    );
    expect(truncated).toBe(false);
    expect(dataset.name).toBe("policies.csv + claims.csv + batch2.csv");
    expect(dataset.rows.length).toBe(5);
    expect(dataset.columns.length).toBe(5);
    expect(stats.length).toBe(2);
  });

  test("row cap truncates with honest provenance fields", () => {
    const bigA = ds(
      "a.csv",
      ["id", "v"],
      Array.from({ length: 60 }, (_, i) => [`a${i}`, i]),
    );
    const bigB = ds(
      "b.csv",
      ["id", "v"],
      Array.from({ length: 60 }, (_, i) => [`b${i}`, i]),
    );
    const { dataset, truncated, totalRows } = combineAll(
      bigA,
      [{ dataset: bigB, step: { strategy: "append" } }],
      100,
    );
    expect(truncated).toBe(true);
    expect(totalRows).toBe(120);
    expect(dataset.rows.length).toBe(100);
    expect(dataset.sampled).toBe(true);
    expect(dataset.sourceTotalRows).toBe(120);
    expect(dataset.sampleKind).toBe("first");
  });
});

describe("previewCombine", () => {
  test("join-left preview: exact region counts for the venn", () => {
    const p = previewCombine(policies, claims, {
      strategy: "join-left",
      key: "id",
      rightKey: "ID",
    });
    expect(p.join).toBeDefined();
    expect(p.join?.matched).toBe(3); // A1 A2 A3
    expect(p.join?.baseOnly).toBe(1); // A4
    expect(p.join?.baseNullKey).toBe(0);
    expect(p.join?.otherOnlyKeys).toBe(0);
    expect(p.newColumns).toEqual(["past_claims", "excess"]);
    expect(p.resultRows).toBe(4); // left join keeps every base row
    expect(p.resultColumns).toBe(5);
  });

  test("join-inner preview drops unmatched and null-key rows from the result", () => {
    const withNull = ds(
      "withnull.csv",
      ["id", "province"],
      [
        ["A1", "GP"],
        [null, "WC"],
        ["Z9", "EC"],
      ],
    );
    const p = previewCombine(withNull, claims, {
      strategy: "join-inner",
      key: "id",
      rightKey: "ID",
    });
    expect(p.join?.matched).toBe(1);
    expect(p.join?.baseOnly).toBe(1); // Z9
    expect(p.join?.baseNullKey).toBe(1);
    expect(p.join?.otherOnlyKeys).toBe(2); // A2 A3 unused
    expect(p.resultRows).toBe(1);
  });

  test("append preview with dedupe counts exact duplicates", () => {
    const batch = ds(
      "batch.csv",
      ["id", "province", "sum_insurd"],
      [
        ["A1", "GP", 100_000], // exact duplicate of a base row
        ["B9", "MP", 60_000],
      ],
    );
    const p = previewCombine(policies, batch, { strategy: "append", dedupeExact: true });
    expect(p.append?.appended).toBe(1);
    expect(p.append?.duplicatesDropped).toBe(1);
    expect(p.resultRows).toBe(5);
  });

  test("preview numbers equal the executed combine's stats", () => {
    const steps: CombineStep[] = [
      { strategy: "join-left", key: "id", rightKey: "ID" },
      { strategy: "join-inner", key: "id", rightKey: "ID" },
      { strategy: "append", dedupeExact: true },
      { strategy: "append", dedupeExact: false },
    ];
    for (const step of steps) {
      const p = previewCombine(policies, claims, step);
      const { dataset: out, stats } = combinePair(policies, claims, step);
      expect(p.resultRows).toBe(out.rows.length);
      expect(p.resultColumns).toBe(out.columns.length);
      if (step.strategy === "append") {
        expect(p.append?.appended).toBe(stats.matched);
        expect(p.append?.duplicatesDropped).toBe(stats.unmatched);
      } else {
        expect(p.join?.matched).toBe(stats.matched);
        expect((p.join?.baseOnly ?? 0) + (p.join?.baseNullKey ?? 0)).toBe(stats.unmatched);
        expect(p.join?.duplicateRightKeys).toBe(stats.duplicateRightKeys);
        expect(p.newColumns.filter((c) => /_\d+$/.test(c))).toEqual(stats.renamedColumns);
      }
    }
  });

  test("join preview mirrors combinePair's column renames", () => {
    const overlap = ds(
      "overlap.csv",
      ["ID", "province", "notes"],
      [
        ["A1", "GP-2", "checked"],
        ["A2", "WC-2", "ok"],
      ],
    );
    const p = previewCombine(policies, overlap, {
      strategy: "join-left",
      key: "id",
      rightKey: "ID",
    });
    const { dataset: out, stats } = combinePair(policies, overlap, {
      strategy: "join-left",
      key: "id",
      rightKey: "ID",
    });
    expect(p.newColumns).toEqual(["province_2", "notes"]);
    expect(p.resultColumns).toBe(out.columns.length);
    expect(stats.renamedColumns).toEqual(["province_2"]);
  });
});
