import { describe, expect, test } from "bun:test";
import type { Row } from "@scelo/core";
import {
  MONTH_LABELS,
  WEEKDAY_LABELS,
  binKey,
  binSeries,
  chooseBin,
  collectDates,
  dateSummary,
  describeSpan,
  monthProfile,
  parseDatePoint,
  weekdayProfile,
  yearMonthGrid,
} from "./dateProfile";

const rows = (values: Array<string | null>, col = "d"): Row[] => values.map((v) => ({ [col]: v }));
const pts = (values: string[]) => collectDates(rows(values), "d").points;

describe("parseDatePoint", () => {
  test("reads ISO components without going through local time", () => {
    const p = parseDatePoint("2024-03-14");
    expect(p).not.toBeNull();
    expect([p?.y, p?.m, p?.d]).toEqual([2024, 3, 14]);
  });

  test("accepts a trailing time part and slashed dates", () => {
    expect(parseDatePoint("2024-03-14T09:30:00")?.d).toBe(14);
    expect(parseDatePoint("2024/03/14")?.m).toBe(3);
  });

  test("rejects impossible and non-date values", () => {
    expect(parseDatePoint("2024-02-31")).toBeNull(); // Feb 31 normalises away
    expect(parseDatePoint("2024-13-01")).toBeNull();
    expect(parseDatePoint("not a date")).toBeNull();
    expect(parseDatePoint(null)).toBeNull();
    expect(parseDatePoint(42)).toBeNull();
  });

  test("the first and last day of a month stay in that month", () => {
    // The bug this guards: `new Date("2024-03-01").getMonth()` returns 1
    // (February) for any user west of UTC, silently shifting month buckets.
    expect(parseDatePoint("2024-03-01")?.m).toBe(3);
    expect(parseDatePoint("2024-03-31")?.m).toBe(3);
    expect(parseDatePoint("2024-01-01")?.y).toBe(2024);
    expect(parseDatePoint("2024-12-31")?.m).toBe(12);
  });
});

describe("chooseBin", () => {
  test("widens the bucket as the span grows", () => {
    expect(chooseBin(10)).toBe("day");
    expect(chooseBin(120)).toBe("week");
    expect(chooseBin(700)).toBe("month");
    expect(chooseBin(2000)).toBe("quarter");
    expect(chooseBin(9000)).toBe("year");
  });
});

describe("binKey", () => {
  test("keys each resolution", () => {
    const p = parseDatePoint("2024-05-15");
    if (!p) throw new Error("unreachable");
    expect(binKey(p, "day")).toBe("2024-05-15");
    expect(binKey(p, "month")).toBe("2024-05");
    expect(binKey(p, "quarter")).toBe("2024-Q2");
    expect(binKey(p, "year")).toBe("2024");
  });

  test("weeks snap back to the Monday", () => {
    // 2024-05-15 is a Wednesday → week starts Monday 2024-05-13.
    const wed = parseDatePoint("2024-05-15");
    const sun = parseDatePoint("2024-05-19");
    const mon = parseDatePoint("2024-05-13");
    if (!wed || !sun || !mon) throw new Error("unreachable");
    expect(binKey(wed, "week")).toBe("2024-05-13");
    expect(binKey(mon, "week")).toBe("2024-05-13");
    // Sunday belongs to the week that started the previous Monday.
    expect(binKey(sun, "week")).toBe("2024-05-13");
  });
});

describe("binSeries", () => {
  test("fills gaps with zeros so missing periods stay visible", () => {
    // Jan and Apr only — Feb and Mar must appear as explicit zeros.
    const series = binSeries(pts(["2024-01-10", "2024-01-20", "2024-04-05"]), "month");
    expect(series.map((s) => s.key)).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(series.map((s) => s.count)).toEqual([2, 0, 0, 1]);
  });

  test("rolls over a year boundary", () => {
    const series = binSeries(pts(["2023-11-02", "2024-02-02"]), "month");
    expect(series.map((s) => s.key)).toEqual(["2023-11", "2023-12", "2024-01", "2024-02"]);
  });

  test("quarters roll over correctly", () => {
    const series = binSeries(pts(["2023-02-01", "2024-05-01"]), "quarter");
    expect(series.map((s) => s.key)).toEqual([
      "2023-Q1",
      "2023-Q2",
      "2023-Q3",
      "2023-Q4",
      "2024-Q1",
      "2024-Q2",
    ]);
  });

  test("daily bins step one day at a time, including across a leap day", () => {
    const series = binSeries(pts(["2024-02-27", "2024-03-02"]), "day");
    expect(series.map((s) => s.key)).toEqual([
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
      "2024-03-02",
    ]);
  });

  test("counts are preserved in total", () => {
    const values = ["2024-01-01", "2024-01-01", "2024-03-15", "2024-06-30"];
    const series = binSeries(pts(values), "month");
    expect(series.reduce((n, s) => n + s.count, 0)).toBe(values.length);
  });

  test("empty input yields an empty series", () => {
    expect(binSeries([], "month")).toEqual([]);
  });
});

describe("seasonality profiles", () => {
  test("month profile is indexed January-first", () => {
    const p = monthProfile(pts(["2024-01-05", "2024-01-19", "2024-12-25"]));
    expect(p[0]).toBe(2);
    expect(p[11]).toBe(1);
    expect(MONTH_LABELS[0]).toBe("Jan");
    expect(MONTH_LABELS).toHaveLength(12);
  });

  test("weekday profile is indexed Monday-first and matches the calendar", () => {
    // 2024-05-13 Mon, 14 Tue, 18 Sat, 19 Sun.
    const p = weekdayProfile(pts(["2024-05-13", "2024-05-14", "2024-05-18", "2024-05-19"]));
    expect(p[0]).toBe(1); // Mon
    expect(p[1]).toBe(1); // Tue
    expect(p[5]).toBe(1); // Sat
    expect(p[6]).toBe(1); // Sun
    expect(WEEKDAY_LABELS[0]).toBe("Mon");
    expect(WEEKDAY_LABELS[6]).toBe("Sun");
  });

  test("a business-day-only column shows an empty weekend", () => {
    const weekdaysOnly = ["2024-05-13", "2024-05-14", "2024-05-15", "2024-05-16", "2024-05-17"];
    const p = weekdayProfile(pts(weekdaysOnly));
    expect(p.slice(0, 5).every((n) => n === 1)).toBe(true);
    expect(p[5]).toBe(0);
    expect(p[6]).toBe(0);
  });
});

describe("yearMonthGrid", () => {
  test("emits a dense 12-cell row per year in the span", () => {
    const grid = yearMonthGrid(pts(["2022-03-01", "2024-07-01"]));
    expect(grid.years).toEqual([2022, 2023, 2024]);
    expect(grid.cells).toHaveLength(36);
    expect(grid.max).toBe(1);
    // 2023 is absent from the data but still present as zeros.
    expect(grid.cells.filter((c) => c.year === 2023).every((c) => c.count === 0)).toBe(true);
  });

  test("empty input is handled", () => {
    expect(yearMonthGrid([]).cells).toEqual([]);
  });
});

describe("dateSummary", () => {
  test("reports range, span, coverage and the densest bucket", () => {
    const s = dateSummary(pts(["2024-01-01", "2024-01-01", "2024-01-03"]));
    expect(s).not.toBeNull();
    expect(s?.first).toBe("2024-01-01");
    expect(s?.last).toBe("2024-01-03");
    expect(s?.spanDays).toBe(3); // inclusive
    expect(s?.uniqueDays).toBe(2);
    expect(s?.emptyDays).toBe(1); // the 2nd
    expect(s?.busiestKey).toBe("2024-01-01");
    expect(s?.busiestCount).toBe(2);
  });

  test("a single date is a one-day span, not zero", () => {
    const s = dateSummary(pts(["2024-06-01"]));
    expect(s?.spanDays).toBe(1);
    expect(s?.emptyDays).toBe(0);
  });

  test("null on empty input", () => {
    expect(dateSummary([])).toBeNull();
  });
});

describe("collectDates", () => {
  test("skips unparseable and null cells, and sorts ascending", () => {
    const { points } = collectDates(
      rows(["2024-03-01", null, "junk", "2022-01-01", "2023-06-15"]),
      "d",
    );
    expect(points.map((p) => p.y)).toEqual([2022, 2023, 2024]);
  });
});

describe("describeSpan", () => {
  test("scales the unit to the magnitude", () => {
    expect(describeSpan(1)).toBe("1 day");
    expect(describeSpan(45)).toBe("45 days");
    expect(describeSpan(365)).toBe("12 months");
    expect(describeSpan(730)).toBe("2 years");
    expect(describeSpan(800)).toBe("2y 2m");
  });
});
