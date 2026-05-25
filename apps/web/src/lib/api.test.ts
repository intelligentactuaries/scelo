// Tests the Result-shaped API client surface. We stub global fetch so we don't
// need a live backend.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Err, Ok, api, parseTriangleCsv } from "./api";

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "text/csv", ...(init?.headers ?? {}) },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("Result discriminator", () => {
  test("Ok / Err produce the expected shape", () => {
    const o = Ok(42);
    const e = Err<number>({ status: 500, code: "x", message: "boom" });
    expect(o.ok).toBe(true);
    expect(e.ok).toBe(false);
    if (o.ok) expect(o.value).toBe(42);
    if (!e.ok) expect(e.error.message).toBe("boom");
  });
});

describe("parseTriangleCsv", () => {
  test("parses the RAA-shaped CSV with empty cells", () => {
    const csv = "origin,1,2,3\n2020,100,150,200\n2021,110,165,\n2022,120,,\n";
    const tri = parseTriangleCsv(csv);
    expect(tri.origin_years).toEqual([2020, 2021, 2022]);
    expect(tri.dev_periods).toEqual([1, 2, 3]);
    expect(tri.values[1]).toEqual([110, 165, null]);
    expect(tri.values[2]).toEqual([120, null, null]);
  });

  test("rejects bad headers", () => {
    expect(() => parseTriangleCsv("year,1,2\n2020,1,2")).toThrow(/origin/);
  });
});

describe("api.* error handling", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  test("4xx returns Err with structured detail", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ detail: "unknown sample: nope" }, { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await api.loadSample("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(404);
      expect(r.error.message).toBe("unknown sample: nope");
    }
  });

  test("network error maps to status 0", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const r = await api.health();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(0);
      expect(r.error.code).toBe("network_error");
    }
  });

  test("loadSample success returns parsed Triangle", async () => {
    globalThis.fetch = mock(async () =>
      textResponse("origin,1,2\n2020,100,150\n2021,110,\n"),
    ) as unknown as typeof fetch;
    const r = await api.loadSample("raa");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.origin_years).toEqual([2020, 2021]);
      expect(r.value.values[1]).toEqual([110, null]);
    }
  });

  test("invokeReserving 200 returns Ok with parsed body", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ mack: { ibnr_total: 52135.23 } }),
    ) as unknown as typeof fetch;
    const r = await api.invokeReserving<{ mack: { ibnr_total: number } }>("predict", {
      triangle: { origin_years: [], dev_periods: [], values: [] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.mack.ibnr_total).toBeCloseTo(52135.23, 1);
  });
});
