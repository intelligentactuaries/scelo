// Date-column aggregation for the smart dashboard.
//
// A date column is NOT a categorical one. Rendering it as "top values"
// ranks individual calendar days by whether they happened to occur 8 times
// or 9 — noise dressed up as a finding — and a treemap of a few thousand
// distinct days is a wall of confetti. What a reader actually wants from a
// date column is: when does it start and end, how does volume move over
// that span, where are the gaps, and is there a repeating cycle.
//
// Everything here is pure and works on parsed (y, m, d) components rather
// than `Date` objects wherever possible, for two reasons:
//
//   1. TIMEZONE SAFETY. `new Date("2024-03-14")` is parsed as UTC midnight,
//      but `.getMonth()` / `.getDate()` read it back in LOCAL time. For any
//      user west of UTC that shifts every date one day earlier, so a
//      month-boundary value lands in the wrong month and a Monday reads as
//      a Sunday. Every calendar field below comes from the parsed string or
//      from `getUTC*`, never from the local-time accessors.
//   2. Testability — binning logic is easy to get subtly wrong, so it is
//      separated from rendering entirely.

import type { Row } from "@scelo/core";

/** Calendar components plus a UTC timestamp for ordering and day arithmetic. */
export type DatePoint = { y: number; m: number; d: number; ms: number };

export type DateBin = "day" | "week" | "month" | "quarter" | "year";

const MS_PER_DAY = 86_400_000;

/** Leading `YYYY-MM-DD` / `YYYY/MM/DD`, optionally followed by a time part.
 *  Date columns reach this module already canonicalised by the profiler's
 *  detection pass, so we only need the strict shape. */
const DATE_HEAD_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/;

export function parseDatePoint(raw: unknown): DatePoint | null {
  if (typeof raw !== "string") return null;
  const m = DATE_HEAD_RE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  // Rejects 31 Feb and friends: UTC normalises the overflow, so if the
  // components don't survive the round trip the input wasn't a real date.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return { y, m: mo, d, ms };
}

/** Rows scanned before we switch to a stride sample. Matches the profiler's
 *  posture elsewhere: shape stays honest, wall-clock stays flat. */
export const DATE_SCAN_TARGET = 200_000;

export function collectDates(
  rows: Row[],
  column: string,
): { points: DatePoint[]; sampled: boolean; stride: number } {
  const total = rows.length;
  const sampled = total > DATE_SCAN_TARGET;
  const stride = sampled ? Math.ceil(total / DATE_SCAN_TARGET) : 1;
  const points: DatePoint[] = [];
  for (let i = 0; i < total; i += stride) {
    const p = parseDatePoint(rows[i][column]);
    if (p) points.push(p);
  }
  points.sort((a, b) => a.ms - b.ms);
  return { points, sampled, stride };
}

/** Bin width that keeps a timeline readable: aim for roughly 12-60 buckets
 *  across the span, so the shape is visible without becoming a comb. */
export function chooseBin(spanDays: number): DateBin {
  if (spanDays <= 45) return "day";
  if (spanDays <= 240) return "week";
  if (spanDays <= 1200) return "month";
  if (spanDays <= 4000) return "quarter";
  return "year";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Monday-based ISO-ish week start, in UTC. */
function weekStartMs(ms: number): number {
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  const backToMonday = (dow + 6) % 7;
  return ms - backToMonday * MS_PER_DAY;
}

export function binKey(p: DatePoint, bin: DateBin): string {
  switch (bin) {
    case "day":
      return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
    case "week": {
      const w = new Date(weekStartMs(p.ms));
      return `${w.getUTCFullYear()}-${pad2(w.getUTCMonth() + 1)}-${pad2(w.getUTCDate())}`;
    }
    case "month":
      return `${p.y}-${pad2(p.m)}`;
    case "quarter":
      return `${p.y}-Q${Math.floor((p.m - 1) / 3) + 1}`;
    case "year":
      return String(p.y);
  }
}

/** Step one bin forward. Used to fill gaps — a period with no rows must
 *  render as a zero, not be skipped, or the gap becomes invisible. */
function nextBinKey(key: string, bin: DateBin): string {
  switch (bin) {
    case "day":
    case "week": {
      const [y, m, d] = key.split("-").map(Number);
      const step = bin === "day" ? MS_PER_DAY : 7 * MS_PER_DAY;
      const nx = new Date(Date.UTC(y, m - 1, d) + step);
      return `${nx.getUTCFullYear()}-${pad2(nx.getUTCMonth() + 1)}-${pad2(nx.getUTCDate())}`;
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
    }
    case "quarter": {
      const [ys, qs] = key.split("-Q");
      const y = Number(ys);
      const q = Number(qs);
      return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
    }
    case "year":
      return String(Number(key) + 1);
  }
}

/** Gap-filled counts per bin, in chronological order. */
export function binSeries(
  points: DatePoint[],
  bin: DateBin,
): Array<{ key: string; count: number }> {
  if (points.length === 0) return [];
  const counts = new Map<string, number>();
  for (const p of points) {
    const k = binKey(p, bin);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const first = binKey(points[0], bin);
  const last = binKey(points[points.length - 1], bin);
  const out: Array<{ key: string; count: number }> = [];
  let cursor = first;
  // Bounded so a malformed key can never spin forever.
  for (let guard = 0; guard < 20_000; guard++) {
    out.push({ key: cursor, count: counts.get(cursor) ?? 0 });
    if (cursor === last) break;
    cursor = nextBinKey(cursor, bin);
  }
  return out;
}

/** Counts by calendar month (index 0 = January). Reveals annual seasonality. */
export function monthProfile(points: DatePoint[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (const p of points) out[p.m - 1]++;
  return out;
}

/** Counts by weekday (index 0 = Monday). Exposes business-day-only data and
 *  weekend structure, which is invisible in a monthly timeline. */
export function weekdayProfile(points: DatePoint[]): number[] {
  const out = new Array<number>(7).fill(0);
  for (const p of points) {
    const dow = new Date(p.ms).getUTCDay(); // 0 = Sunday
    out[(dow + 6) % 7]++;
  }
  return out;
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Year × month matrix — the long-span bird's-eye. A daily calendar past
 *  ~3 years is unreadable; this keeps one row per year and stays legible
 *  over decades. */
export function yearMonthGrid(points: DatePoint[]): {
  years: number[];
  cells: Array<{ year: number; month: number; count: number }>;
  max: number;
} {
  if (points.length === 0) return { years: [], cells: [], max: 0 };
  const counts = new Map<string, number>();
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const k = `${p.y}-${p.m}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const years: number[] = [];
  for (let y = minY; y <= maxY; y++) years.push(y);
  const cells: Array<{ year: number; month: number; count: number }> = [];
  let max = 0;
  for (const y of years) {
    for (let m = 1; m <= 12; m++) {
      const count = counts.get(`${y}-${m}`) ?? 0;
      if (count > max) max = count;
      cells.push({ year: y, month: m, count });
    }
  }
  return { years, cells, max };
}

export type DateSummary = {
  first: string;
  last: string;
  spanDays: number;
  /** Distinct calendar days present. */
  uniqueDays: number;
  /** Days inside the span with no rows at all. */
  emptyDays: number;
  /** Densest bin at the chosen resolution, and its count. */
  busiestKey: string;
  busiestCount: number;
  bin: DateBin;
};

export function dateSummary(points: DatePoint[]): DateSummary | null {
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = Math.round((last.ms - first.ms) / MS_PER_DAY) + 1;
  const days = new Set<number>();
  for (const p of points) days.add(p.ms);
  const bin = chooseBin(spanDays);
  const series = binSeries(points, bin);
  let busiestKey = series[0]?.key ?? "";
  let busiestCount = 0;
  for (const s of series) {
    if (s.count > busiestCount) {
      busiestCount = s.count;
      busiestKey = s.key;
    }
  }
  const iso = (p: DatePoint) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  return {
    first: iso(first),
    last: iso(last),
    spanDays,
    uniqueDays: days.size,
    emptyDays: Math.max(0, spanDays - days.size),
    busiestKey,
    busiestCount,
    bin,
  };
}

/** Human phrasing for a span, e.g. "4 years 2 months". */
export function describeSpan(days: number): string {
  if (days < 1) return "same day";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years} year${years === 1 ? "" : "s"}` : `${years}y ${rem}m`;
}
