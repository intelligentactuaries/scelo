import { describe, expect, test } from "bun:test";
import { buhlmannShrink } from "./credibility";

describe("credibility · Buhlmann shrinkage", () => {
  const result = buhlmannShrink([
    { gradient: [2, 0], n: 1000 }, // data-rich segment
    { gradient: [0, 2], n: 20 }, // data-poor segment
    { gradient: [1, 1], n: 500 },
  ]);

  test("the collective is the n-weighted mean", () => {
    // Weighted mean of [2,0],[0,2],[1,1] with weights 1000,20,500 over 1520.
    expect(result.collective[0]).toBeCloseTo((1000 * 2 + 500 * 1) / 1520, 6);
    expect(result.collective[1]).toBeCloseTo((20 * 2 + 500 * 1) / 1520, 6);
  });

  test("data-rich segments keep more of their own direction", () => {
    expect(result.Z[0]).toBeGreaterThan(result.Z[1]);
    expect(result.Z[1]).toBeGreaterThan(0);
    expect(result.Z[0]).toBeLessThanOrEqual(1);
  });

  test("data-poor segments shrink toward the collective", () => {
    const raw = [0, 2];
    const shrunk = result.shrunk[1];
    const distRaw = Math.hypot(raw[0] - result.collective[0], raw[1] - result.collective[1]);
    const distShrunk = Math.hypot(
      shrunk[0] - result.collective[0],
      shrunk[1] - result.collective[1],
    );
    expect(distShrunk).toBeLessThan(distRaw);
  });
});
