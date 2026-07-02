import { describe, expect, test } from "bun:test";
import { detectMap, featureNamesFor, resolveCountryName } from "./geoRegistry";

// detectMap must pick the right registry case by case from the column's own
// values — SA provinces, US states, and world countries each land on their
// own map, and the counts aggregate against that map's features.

describe("detectMap", () => {
  test("South African province codes pick the ZA map (incl. the NC/North-Carolina collision and LIM)", () => {
    const values = ["FS", "KZN", "WC", "GP", "EC", "MP", "NW", "NC", "LIM", "GP", "KZN", "FS"];
    const { mapKey, resolve } = detectMap(values);
    expect(mapKey).toBe("ZA");
    // Every code — including the US-colliding NC and the StatsSA-style LIM —
    // must resolve to a real ZA feature so no province drops off the count.
    const features = new Set(featureNamesFor("ZA"));
    for (const v of new Set(values)) {
      const name = resolve(v);
      expect(name).not.toBeNull();
      expect(features.has(name as string)).toBe(true);
    }
    expect(resolve("NC")).toBe("Northern Cape");
    expect(resolve("LIM")).toBe("Limpopo");
    expect(resolve("KZN")).toBe("KwaZulu-Natal");
  });

  test("full South African province names also pick the ZA map", () => {
    const { mapKey, resolve } = detectMap([
      "Gauteng",
      "Western Cape",
      "KwaZulu-Natal",
      "Limpopo",
      "Eastern Cape",
    ]);
    expect(mapKey).toBe("ZA");
    expect(resolve("Gauteng")).toBe("Gauteng");
  });

  test("US state codes and names pick the US map", () => {
    const { mapKey, resolve } = detectMap(["CA", "NY", "TX", "Florida", "WA", "IL", "GA", "OH"]);
    expect(mapKey).toBe("US");
    expect(resolve("CA")).toBe("California");
    expect(resolve("Florida")).toBe("Florida");
  });

  test("country names pick the world map", () => {
    const { mapKey, resolve } = detectMap([
      "South Africa",
      "Germany",
      "Japan",
      "Brazil",
      "Kenya",
      "France",
    ]);
    expect(mapKey).toBe("world");
    expect(resolve("Germany")).toBe("Germany");
  });

  test("ISO alpha-3 country codes pick the world map", () => {
    const { mapKey, resolve } = detectMap(["ZAF", "USA", "GBR", "DEU", "JPN", "BRA"]);
    expect(mapKey).toBe("world");
    expect(resolve("ZAF")).toBe("South Africa");
  });

  test("non-geographic values fall through to world with no resolution", () => {
    const { resolve } = detectMap(["Single", "Married", "Separated"]);
    expect(resolve("Single")).toBeNull();
  });
});

describe("resolveCountryName", () => {
  test("handles names, codes, and blanks", () => {
    expect(resolveCountryName("south africa")).toBe("South Africa");
    expect(resolveCountryName("ZA")).toBe("South Africa");
    expect(resolveCountryName("")).toBeNull();
    expect(resolveCountryName("Narnia")).toBeNull();
  });
});
