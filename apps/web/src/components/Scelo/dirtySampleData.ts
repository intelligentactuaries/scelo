// "Messy intake" demo dataset.
//
// Hand-crafted to exercise EVERY cleaning op in `cleaning.ts` so a
// reviewer can load the sample, open the banner, and see suggestions
// for trim, collapse-whitespace, fix-encoding, missing-markers, parse-
// numeric, parse-dates, standardise-booleans, replace-sentinel-numerics,
// merge-case-only-duplicates, rename-snake-case, drop-empty-cols,
// drop-constant-cols, and drop-duplicate-rows ALL fire simultaneously.
//
// Deliberately small (52 rows) so the bundle impact stays trivial. Mix
// is calibrated so:
//   - String columns carry leading/trailing whitespace, internal double
//     whitespace, mojibake (UTF-8 → Latin-1 misdecode), NBSP, BOM, and
//     sentinel "missing" markers ("N/A", "?", "-", "TBD", "null").
//   - Numeric-looking columns are stored as strings with $/,/%/(...)
//     decoration so parse-numeric has work to do.
//   - One numeric column carries -999 / 9999 sentinels well outside the
//     IQR so replace-numeric-sentinels triggers.
//   - Date column mixes ISO, slashed, and month-name formats so
//     parse-dates can canonicalise.
//   - Boolean column rotates Y / N / yes / no / true / false / 1 / 0.
//   - Region column has WEST / west / West case-only duplicates.
//   - `country` is constant ("ZA") so drop-constant-cols fires.
//   - `notes` and `internal_ref_v2` are >95% null so drop-empty-cols
//     fires.
//   - Headers `Customer Name` / `Joined Date` carry spaces so rename-
//     snake-case fires.
//   - Last two rows are exact duplicates of row 0 so drop-duplicates
//     fires.

import type { Dataset, Row } from "./SoftDataWorkstation";

// Tiny seeded LCG so the dirty sample is stable across reloads (same
// pattern as the claims / climate samples).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const FIRST_NAMES = [
  "Jane",
  "  José", // leading whitespace + accented (real é, not mojibake)
  "JosÃ©", // mojibake: UTF-8 "é" misdecoded as Latin-1 → "Ã©"
  "Thandi",
  "Pieter",
  "﻿Acme", // BOM-prefixed
  "Lerato",
  "Naledi",
  "Sipho",
  "Ayanda",
];
const LAST_NAMES = [
  "Smith",
  "van der Merwe",
  "Mokoena ", // trailing whitespace
  "Naidoo",
  "Patel",
  "Dlamini",
  "Nkosi",
  "Williams",
];
const REGIONS = [
  "WEST",
  "west",
  "West",
  "EAST",
  "east",
  "East",
  "NORTH",
  "north",
  "SOUTH",
  "south",
];
const MISSING_TOKENS = ["N/A", "?", "-", "TBD", "null", "none", ""];
const BOOL_VARIANTS_TRUE = ["Y", "yes", "TRUE", "true", "1", "y"];
const BOOL_VARIANTS_FALSE = ["N", "no", "FALSE", "false", "0", "n"];

function maybeMissing<T extends string | number | null>(
  rand: () => number,
  v: T,
  missingRate: number,
): string | T {
  if (rand() < missingRate) {
    const i = Math.floor(rand() * MISSING_TOKENS.length);
    return MISSING_TOKENS[i];
  }
  return v;
}

// Format a number as a dirty currency-ish string — picks one of several
// dialects so parse-numeric has to deal with the full long tail.
function dirtyMoney(rand: () => number, value: number): string {
  const dialect = Math.floor(rand() * 5);
  const negative = value < 0;
  const abs = Math.abs(value);
  switch (dialect) {
    case 0: {
      const formatted = abs.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return negative ? `($${formatted})` : `$${formatted}`;
    }
    case 1:
      // trailing currency code
      return `${abs.toFixed(2)} ZAR`;
    case 2:
      // thousand separator only
      return abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
    case 3:
      // bare number with whitespace padding
      return ` ${abs.toFixed(2)} `;
    default:
      // accounting parens for negatives, plain otherwise
      return negative ? `(${abs.toFixed(2)})` : abs.toFixed(2);
  }
}

// Mixed date formats: ISO, slashed (DD/MM/YYYY), month-name, dashed
// non-ISO. parse-dates should snap all of them to YYYY-MM-DD.
function dirtyDate(rand: () => number, base: Date): string {
  const dialect = Math.floor(rand() * 4);
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + 1;
  const d = base.getUTCDate();
  const monthNames = [
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
  switch (dialect) {
    case 0:
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    case 1:
      return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
    case 2:
      return `${monthNames[m - 1]} ${d}, ${y}`;
    default:
      return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${y}`;
  }
}

export function buildDirtySample(): Dataset {
  const rand = lcg(0xc0ffee);
  const rows: Row[] = [];
  const startMs = Date.UTC(2024, 0, 1);
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < 50; i++) {
    const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
    // Inject occasional double internal whitespace so collapse-whitespace
    // has something to find.
    const fullName = rand() < 0.2 ? `${first}  ${last}` : `${first} ${last}`;

    const email = rand() < 0.1 ? "" : `${first.trim().toLowerCase().replace(/\W/g, "")}@example.za`;

    const joined = new Date(startMs + Math.floor(rand() * 500) * dayMs);
    const joinedStr = dirtyDate(rand, joined);

    const region = REGIONS[Math.floor(rand() * REGIONS.length)];

    // Premium: realistic ZAR figures, occasional negative (refund), all
    // stored as messy strings.
    const premiumValue = Math.round((1000 + rand() * 9000) * 100) / 100;
    const signed = rand() < 0.08 ? -premiumValue : premiumValue;
    const premium = dirtyMoney(rand, signed);

    // Discount %: usually 0-25%, written as "10%" / "5%" etc.
    const discountPct = `${Math.floor(rand() * 25)}%`;

    // Age: usually 22-78, occasional -999 / 9999 sentinels (legacy
    // "missing" codes) — placed often enough to clear the analyser's
    // ≥3-occurrence threshold.
    let age: number | string;
    const roll = rand();
    if (roll < 0.1) age = -999;
    else if (roll < 0.16) age = 9999;
    else age = 22 + Math.floor(rand() * 56);

    // Active flag — rotates through every common boolean spelling.
    const activeBucket = i % 12;
    const active =
      activeBucket < 6
        ? BOOL_VARIANTS_TRUE[activeBucket]
        : BOOL_VARIANTS_FALSE[activeBucket - 6];

    // notes: 96% null, 4% short free-text. Triggers drop-empty-cols.
    const notes = rand() < 0.04 ? "VIP customer" : null;

    // internal_ref_v2: 100% null in this snapshot. Triggers drop-empty.
    const internalRef: string | null = null;

    rows.push({
      "Customer Name": maybeMissing(rand, fullName, 0.08),
      Email: email === "" ? "?" : email,
      "Joined Date": maybeMissing(rand, joinedStr, 0.06),
      Region: region,
      country: "ZA",
      premium_zar: maybeMissing(rand, premium, 0.04),
      discount_pct: discountPct,
      age,
      active,
      notes,
      internal_ref_v2: internalRef,
    });
  }

  // Inject duplicate rows so drop-duplicates fires (3 exact copies of
  // row 0, placed at the end so they survive the sample stride).
  if (rows.length > 0) {
    rows.push({ ...rows[0] });
    rows.push({ ...rows[0] });
    rows.push({ ...rows[0] });
  }

  // Inject an NBSP-corrupted region into the first row so fix-encoding
  // has at least one cell to repair.
  rows[1] = { ...rows[1], Region: "West Cape" };
  rows[2] = { ...rows[2], "Customer Name": "Cape Town Office" };
  // Zero-width space snuck into a free-text cell — a common Word
  // import artefact, invisible in most viewers but real for
  // downstream string comparisons.
  rows[3] = { ...rows[3], notes: "VIP​customer" };

  return {
    name: "messy_intake (dirty demo)",
    columns: [
      "Customer Name",
      "Email",
      "Joined Date",
      "Region",
      "country",
      "premium_zar",
      "discount_pct",
      "age",
      "active",
      "notes",
      "internal_ref_v2",
    ],
    rows,
  };
}
