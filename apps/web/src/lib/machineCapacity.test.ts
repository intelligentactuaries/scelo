// The machine is the only limit: estimates are sane, the guard only refuses
// when heap numbers say it must, and it never refuses where the platform
// exposes none.

import { afterEach, describe, expect, test } from "bun:test";
import type { Dataset } from "@scelo/core";
import {
  HEAP_CEILING,
  capacityCheck,
  estimateBytesPerRow,
  estimateDatasetBytes,
  fmtBytes,
  heapInfo,
  rowBudget,
} from "./machineCapacity";

type PerfWithMemory = Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
};

function withHeap(used: number, limit: number, fn: () => void) {
  const perf = performance as PerfWithMemory;
  const prev = perf.memory;
  perf.memory = { usedJSHeapSize: used, jsHeapSizeLimit: limit };
  try {
    fn();
  } finally {
    if (prev === undefined) delete perf.memory;
    else perf.memory = prev;
  }
}

const ds = (rows: number, cols = 4): Dataset => ({
  name: "d",
  columns: Array.from({ length: cols }, (_, i) => `c${i}`),
  rows: Array.from({ length: rows }, (_, r) =>
    Object.fromEntries(Array.from({ length: cols }, (_, i) => [`c${i}`, i % 2 ? r : `v${r}`])),
  ),
});

afterEach(() => {
  delete (performance as PerfWithMemory).memory;
});

describe("estimates", () => {
  test("bytes per row scale with columns and string length", () => {
    const small = estimateBytesPerRow(ds(100, 2));
    const wide = estimateBytesPerRow(ds(100, 20));
    expect(wide).toBeGreaterThan(small * 4);
    const empty = estimateBytesPerRow({ name: "e", columns: ["a", "b"], rows: [] });
    expect(empty).toBeGreaterThan(0);
  });
  test("dataset bytes ≈ rows × bytes/row", () => {
    const d = ds(1_000);
    const per = estimateBytesPerRow(d);
    expect(estimateDatasetBytes(d)).toBeGreaterThan(per * 900);
    expect(estimateDatasetBytes(d)).toBeLessThan(per * 1_100 + 10_000);
  });
  test("fmtBytes", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(3 * 1024 ** 2)).toBe("3 MB");
    expect(fmtBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe("∞");
  });
});

describe("guard", () => {
  test("no heap numbers → never refuses, budget is unbounded", () => {
    expect(heapInfo()).toBeNull();
    expect(capacityCheck(10 ** 12).ok).toBe(true);
    expect(rowBudget(1_000)).toBe(Number.POSITIVE_INFINITY);
  });
  test("refuses only past the ceiling, and says why in bytes", () => {
    withHeap(1 * 1024 ** 3, 4 * 1024 ** 3, () => {
      // 4 GB limit → 3.2 GB ceiling; 1 GB used → 2.2 GB room; ×2 working copies
      expect(capacityCheck(1 * 1024 ** 3).ok).toBe(true); // 1 + 2 = 3 GB ≤ 3.2
      const no = capacityCheck(1.5 * 1024 ** 3); // 1 + 3 = 4 GB > 3.2
      expect(no.ok).toBe(false);
      expect(no.message).toContain("4.0 GB");
      expect(no.message).toContain("1.5 GB");
      expect(no.heap?.limit).toBe(4 * 1024 ** 3);
    });
  });
  test("row budget = headroom / bytes-per-row / working copies", () => {
    withHeap(0, 1000, () => {
      // ceiling 800, room 800, 100 B/row, 2 copies → 4 rows
      expect(rowBudget(100)).toBe(4);
      expect(HEAP_CEILING).toBe(0.8);
    });
    withHeap(1000, 1000, () => {
      expect(rowBudget(100)).toBe(0);
    });
  });
});
