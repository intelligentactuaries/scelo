// Global geography registry for the chat-embedded map viz.
//
// We pull from `sane-topojson` (Plotly's Natural-Earth-derived TopoJSON
// bundle) for world + US, and from a slimmed cut of Natural Earth's
// 1:50m admin1 dataset for SA provinces. Maps are registered with ECharts
// at module load; at render time the registry picks the right one by
// sampling the user's data column.
//
// Today's coverage:
//   "world" — Natural Earth 1:110m country polygons (177 countries).
//             Feature IDs are ISO 3166-1 alpha-3 ("USA", "ZAF", "GBR"…).
//             We populate `properties.name` with the standard English name
//             via `Intl.DisplayNames` so ECharts' default name-matching
//             works against user data that uses country names or codes.
//
//   "US"    — Natural Earth US states (51 features). Feature IDs are
//             2-letter state codes ("CA", "NY"…); names populated from an
//             inline lookup so user data matches whether they pass codes or
//             full names.
//
//   "ZA"    — Natural Earth 1:50m admin1 cut for South Africa (9 provinces).
//             Bundled as zaProvinces.geo.json (~30 KB). Real polygons —
//             dropped the earlier hand-traced approximations that were
//             hallucinating shapes. Postal codes follow Natural Earth
//             conventions (GT, NP, NL) but the resolver also accepts the
//             commonly-used codes (GP, LP, KZN).
//
// Sub-national admin1 for other countries isn't bundled. Adding (say) UK
// regions or India states is a `bun add <package>` + register call.

import * as echarts from "echarts/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import usaTopo from "sane-topojson/dist/usa_110m.json";
import worldTopo from "sane-topojson/dist/world_110m.json";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import zaProvinces from "./zaProvinces.geo.json";

// ── helpers ────────────────────────────────────────────────────────────

// Try to use the browser's Intl.DisplayNames to turn ISO codes into
// English country names. Falls back to the raw code if Intl isn't there
// (older Node etc.).
function regionDisplayName(): (code: string) => string {
  if (typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function") {
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      return (code: string) => {
        try {
          return dn.of(code) ?? code;
        } catch {
          return code;
        }
      };
    } catch {
      // fall through
    }
  }
  return (code: string) => code;
}

const displayName = regionDisplayName();

// Inline US state code → name lookup so user data of either form matches.
const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

// ── world map ──────────────────────────────────────────────────────────

const WORLD_TOPO = worldTopo as unknown as Topology<{
  countries: GeometryCollection;
}>;
const WORLD_RAW = feature(WORLD_TOPO, WORLD_TOPO.objects.countries) as FeatureCollection<
  Geometry,
  { ct?: [number, number]; name?: string }
>;
// Walk each feature once at module load: populate `properties.name` from
// `feature.id` (an ISO 3166-1 alpha-3 code) using Intl.DisplayNames. Some
// codes Intl doesn't recognise (e.g. "ATA" Antarctica is fine; "ESH"
// Western Sahara may resolve as "Western Sahara"). Either way we end up
// with a non-empty name string.
const WORLD_GEO: FeatureCollection<Geometry, { name: string }> = {
  type: "FeatureCollection",
  features: WORLD_RAW.features.map((f) => ({
    ...f,
    properties: {
      name: typeof f.id === "string" ? displayName(f.id) : "Unknown",
    },
  })),
};
const WORLD_NAME_BY_LOWER = new Map<string, string>();
for (const f of WORLD_GEO.features) {
  const name = f.properties.name;
  WORLD_NAME_BY_LOWER.set(name.toLowerCase(), name);
  if (typeof f.id === "string") WORLD_NAME_BY_LOWER.set(f.id.toLowerCase(), name);
}

// Aliases for country names that differ between common usage and the
// Intl/Natural Earth canonical form.
const WORLD_ALIASES: Record<string, string> = {
  us: "United States",
  usa: "United States",
  "united states of america": "United States",
  america: "United States",
  uk: "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  drc: "Congo - Kinshasa",
  "democratic republic of the congo": "Congo - Kinshasa",
  "democratic republic of congo": "Congo - Kinshasa",
  "republic of the congo": "Congo - Brazzaville",
  "ivory coast": "Côte d’Ivoire",
  burma: "Myanmar (Burma)",
  myanmar: "Myanmar (Burma)",
  korea: "South Korea",
  "czech republic": "Czechia",
  swaziland: "Eswatini",
  "east timor": "Timor-Leste",
  vatican: "Vatican City",
};

// Take any raw country-ish input and return the canonical world-map name
// (matching `feature.properties.name` populated above). Returns null when
// nothing matches.
export function resolveCountryName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  const direct = WORLD_NAME_BY_LOWER.get(lower);
  if (direct) return direct;
  const aliased = WORLD_ALIASES[lower];
  if (aliased) return aliased;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 || upper.length === 3) {
    // ISO alpha-2 / alpha-3 — route through Intl, then canonicalise.
    const displayed = displayName(upper);
    if (displayed && displayed !== upper) {
      const dl = displayed.toLowerCase();
      if (WORLD_NAME_BY_LOWER.has(dl)) return WORLD_NAME_BY_LOWER.get(dl) ?? null;
      if (WORLD_ALIASES[dl]) return WORLD_ALIASES[dl];
    }
  }
  return null;
}

// ── US map ─────────────────────────────────────────────────────────────

const USA_TOPO = usaTopo as unknown as Topology<{
  subunits: GeometryCollection;
}>;
const USA_RAW = feature(USA_TOPO, USA_TOPO.objects.subunits) as FeatureCollection<
  Geometry,
  { ct?: [number, number]; gu?: string; name?: string }
>;
const US_GEO: FeatureCollection<Geometry, { name: string; code: string }> = {
  type: "FeatureCollection",
  features: USA_RAW.features.map((f) => {
    const code = typeof f.id === "string" ? f.id.toUpperCase() : "";
    const name = US_STATE_NAMES[code] ?? code;
    return { ...f, properties: { name, code } };
  }),
};
const US_NAME_BY_LOWER = new Map<string, string>();
for (const f of US_GEO.features) {
  US_NAME_BY_LOWER.set(f.properties.name.toLowerCase(), f.properties.name);
  US_NAME_BY_LOWER.set(f.properties.code.toLowerCase(), f.properties.name);
}

function resolveUsState(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return US_NAME_BY_LOWER.get(trimmed.toLowerCase()) ?? null;
}

// ── ZA (South Africa) admin1 map ──────────────────────────────────────
// Pulled from Natural Earth 1:50m admin1, slimmed down to just 9 features
// at build time. The Natural Earth `postal` field uses GT/NP/NL for
// Gauteng / Limpopo / KwaZulu-Natal; common SA usage is GP/LP/KZN. The
// resolver below accepts both so user data works either way.

const ZA_GEO = zaProvinces as unknown as FeatureCollection<
  Geometry,
  { name: string; code: string }
>;
const ZA_NAME_BY_LOWER = new Map<string, string>();
for (const f of ZA_GEO.features) {
  const name = f.properties.name;
  ZA_NAME_BY_LOWER.set(name.toLowerCase(), name);
  ZA_NAME_BY_LOWER.set(f.properties.code.toLowerCase(), name);
}
// Common-usage SA province codes that differ from Natural Earth's postal
// field, mapped to the canonical feature name.
const ZA_COMMON_ALIASES: Record<string, string> = {
  gp: "Gauteng", // Natural Earth uses GT
  lp: "Limpopo", // Natural Earth uses NP
  kzn: "KwaZulu-Natal", // Natural Earth uses NL
  "kwazulu natal": "KwaZulu-Natal", // with space instead of hyphen
};
function resolveZaProvince(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  return ZA_NAME_BY_LOWER.get(lower) ?? ZA_COMMON_ALIASES[lower] ?? null;
}

// ── registry public API ────────────────────────────────────────────────

export type MapRegistryKey = "world" | "US" | "ZA";

// Detection picks the registered map that best fits the data column.
// Priority order is sub-national first (US states, SA provinces), then
// world countries — because province codes are short and unambiguous,
// and falling through to country level would silently drop granularity.
export function detectMap(values: string[]): {
  mapKey: MapRegistryKey;
  resolve: (raw: string) => string | null;
} {
  const sample = values.slice(0, 200);
  let usHits = 0;
  let zaHits = 0;
  let worldHits = 0;
  for (const v of sample) {
    if (resolveUsState(v)) {
      usHits++;
      continue;
    }
    if (resolveZaProvince(v)) {
      zaHits++;
      continue;
    }
    if (resolveCountryName(v)) worldHits++;
  }
  const minHits = Math.min(3, Math.ceil(sample.length / 3));
  if (zaHits > usHits && zaHits > worldHits && zaHits >= minHits) {
    return { mapKey: "ZA", resolve: resolveZaProvince };
  }
  if (usHits > worldHits && usHits >= minHits) {
    return { mapKey: "US", resolve: resolveUsState };
  }
  return { mapKey: "world", resolve: resolveCountryName };
}

export function featureNamesFor(mapKey: MapRegistryKey): string[] {
  if (mapKey === "US") return US_GEO.features.map((f) => f.properties.name);
  if (mapKey === "ZA") return ZA_GEO.features.map((f) => f.properties.name);
  return WORLD_GEO.features.map((f) => f.properties.name);
}

// Short label for compact in-polygon display. ZA uses the common-usage
// codes (GP, LP, KZN) rather than Natural Earth's GT/NP/NL.
const ZA_DISPLAY_CODE: Record<string, string> = {
  Gauteng: "GP",
  Limpopo: "LP",
  "KwaZulu-Natal": "KZN",
  "Western Cape": "WC",
  "Eastern Cape": "EC",
  "Northern Cape": "NC",
  "Free State": "FS",
  "North West": "NW",
  Mpumalanga: "MP",
};
export function shortLabel(mapKey: MapRegistryKey, name: string): string {
  if (mapKey === "US") {
    for (const [code, n] of Object.entries(US_STATE_NAMES)) if (n === name) return code;
  }
  if (mapKey === "ZA") {
    return ZA_DISPLAY_CODE[name] ?? name;
  }
  return name;
}

export function viewportFor(mapKey: MapRegistryKey): {
  center: [number, number];
  zoom: number;
  aspectScale: number;
} {
  if (mapKey === "US") return { center: [-97, 38], zoom: 1.0, aspectScale: 0.85 };
  if (mapKey === "ZA") return { center: [25, -29], zoom: 1.1, aspectScale: 0.95 };
  // World — Atlantic-centred so the eye lands on Europe / Africa first.
  return { center: [10, 15], zoom: 1.05, aspectScale: 0.85 };
}

// ── registration (side-effectful, idempotent) ──────────────────────────

type RegisterMapArg = Parameters<typeof echarts.registerMap>[1];
echarts.registerMap("world", WORLD_GEO as unknown as RegisterMapArg);
echarts.registerMap("US", US_GEO as unknown as RegisterMapArg);
echarts.registerMap("ZA", ZA_GEO as unknown as RegisterMapArg);

export type { Feature, FeatureCollection };
