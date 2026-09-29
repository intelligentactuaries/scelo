// The in-browser GBM + TreeSHAP engine. The TreeSHAP recursion is checked
// against brute-force Shapley values (exponential in the feature count, so
// only feasible on small trees — which is exactly why TreeSHAP exists); the
// booster is checked on synthetic data whose true drivers are known.

import { describe, expect, test } from "bun:test";
import type { Row } from "@scelo/core";
import {
  type GbmFeature,
  type GbmTree,
  aucScore,
  fitGbm,
  makeShapScratch,
  predictTree,
  treeExpectedValue,
  treeShap,
} from "./gbm";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function gauss(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
}

// ── TreeSHAP vs brute force ────────────────────────────────────────────────

/** Random tree over `nFeatures` features whose covers split randomly. Drawing
 *  features from a small pool forces repeated splits on the same feature
 *  along a path — the case unwindPath exists for. */
function randomTree(rand: () => number, nFeatures: number, maxDepth: number): GbmTree {
  const feature: number[] = [];
  const threshold: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const value: number[] = [];
  const cover: number[] = [];
  const build = (depth: number, c: number): number => {
    const node = feature.length;
    feature.push(-1);
    threshold.push(0);
    left.push(-1);
    right.push(-1);
    value.push(0);
    cover.push(c);
    if (depth >= maxDepth || (depth > 0 && rand() < 0.2)) {
      value[node] = gauss(rand) * 3;
      return node;
    }
    const u = 0.1 + 0.8 * rand();
    feature[node] = Math.floor(rand() * nFeatures);
    threshold[node] = Math.floor(rand() * 6);
    left[node] = build(depth + 1, c * u);
    right[node] = build(depth + 1, c * (1 - u));
    return node;
  };
  build(0, 100);
  return {
    feature: Int32Array.from(feature),
    threshold: Int32Array.from(threshold),
    left: Int32Array.from(left),
    right: Int32Array.from(right),
    value: Float64Array.from(value),
    cover: Float64Array.from(cover),
  };
}

/** Path-dependent E[f(x) | x_S] (Lundberg et al. 2018, Algorithm 1). */
function conditionalExpectation(tree: GbmTree, x: number[], S: Set<number>): number {
  const walk = (n: number): number => {
    const f = tree.feature[n];
    if (f < 0) return tree.value[n];
    if (S.has(f)) return walk(x[f] <= tree.threshold[n] ? tree.left[n] : tree.right[n]);
    const l = tree.left[n];
    const r = tree.right[n];
    return (tree.cover[l] * walk(l) + tree.cover[r] * walk(r)) / tree.cover[n];
  };
  return walk(0);
}

function factorial(k: number): number {
  let out = 1;
  for (let i = 2; i <= k; i++) out *= i;
  return out;
}

function bruteForceShap(tree: GbmTree, x: number[], M: number): number[] {
  const phi = new Array<number>(M).fill(0);
  for (let i = 0; i < M; i++) {
    const others = Array.from({ length: M }, (_, j) => j).filter((j) => j !== i);
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const S = new Set<number>();
      for (let b = 0; b < others.length; b++) if (mask & (1 << b)) S.add(others[b]);
      const weight = (factorial(S.size) * factorial(M - S.size - 1)) / factorial(M);
      const withI = new Set(S);
      withI.add(i);
      phi[i] +=
        weight * (conditionalExpectation(tree, x, withI) - conditionalExpectation(tree, x, S));
    }
  }
  return phi;
}

describe("TreeSHAP", () => {
  test("matches brute-force Shapley values on random trees (incl. repeated features)", () => {
    const rand = makeRng(11);
    let worst = 0;
    for (let trial = 0; trial < 300; trial++) {
      const M = 2 + Math.floor(rand() * 4); // 2..5 features
      const depth = 1 + Math.floor(rand() * 4); // 1..4 levels
      const tree = randomTree(rand, M, depth);
      const x = Array.from({ length: M }, () => Math.floor(rand() * 7));
      const phi = new Float64Array(M);
      treeShap(tree, (f) => x[f], phi, makeShapScratch(depth));
      const exact = bruteForceShap(tree, x, M);
      for (let f = 0; f < M; f++) worst = Math.max(worst, Math.abs(phi[f] - exact[f]));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  test("local accuracy: E[f] + Σφ reproduces the tree's prediction", () => {
    const rand = makeRng(5);
    for (let trial = 0; trial < 100; trial++) {
      const tree = randomTree(rand, 4, 4);
      const x = Array.from({ length: 4 }, () => Math.floor(rand() * 7));
      const phi = new Float64Array(4);
      treeShap(tree, (f) => x[f], phi, makeShapScratch(4));
      const total = treeExpectedValue(tree) + phi.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(
        predictTree(tree, (f) => x[f]),
        9,
      );
    }
  });

  test("a feature the tree never splits on gets exactly zero", () => {
    const rand = makeRng(3);
    const tree = randomTree(rand, 2, 3); // features 0 and 1 only
    const x = [3, 1, 5];
    const phi = new Float64Array(3);
    treeShap(tree, (f) => x[f], phi, makeShapScratch(3));
    expect(phi[2]).toBe(0);
  });
});

// ── metrics ────────────────────────────────────────────────────────────────

describe("aucScore", () => {
  test("matches the textbook example and handles ties", () => {
    expect(aucScore([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])).toBeCloseTo(0.75, 12);
    expect(aucScore([0, 1], [0.5, 0.5])).toBeCloseTo(0.5, 12);
    expect(aucScore([1, 1], [0.2, 0.9])).toBeNull();
  });
});

// ── the booster on known signals ───────────────────────────────────────────

const NUM = (name: string): GbmFeature => ({ name, kind: "numeric" });

function continuousData(n: number, seed = 1): Row[] {
  const rand = makeRng(seed);
  return Array.from({ length: n }, () => {
    const x1 = rand() * 4 - 2;
    const x2 = rand() * 4 - 2;
    const x3 = rand() * 4 - 2;
    const x4 = gauss(rand) * 5;
    return { x1, x2, x3, x4, y: 3 * x1 + 2 * Math.sin(1.5 * x2) + 0.1 * gauss(rand) };
  });
}

describe("fitGbm", () => {
  test("continuous target: high holdout R², SHAP recovers the true drivers", () => {
    const fit = fitGbm(continuousData(1500), { column: "y", kind: "continuous" }, [
      NUM("x1"),
      NUM("x2"),
      NUM("x3"),
      NUM("x4"),
    ]);
    expect(fit.metrics.primaryName).toBe("R²");
    expect(fit.metrics.primary).toBeGreaterThan(0.85);
    expect(fit.nHoldout).toBe(300);
    expect(fit.nTrain).toBe(1200);
    expect(fit.shap.features.slice(0, 2)).toEqual(["x1", "x2"]);
    const noise = fit.shap.features
      .map((f, i) => ({ f, s: fit.shap.share[i] }))
      .filter((r) => r.f === "x3" || r.f === "x4");
    for (const r of noise) expect(r.s).toBeLessThan(0.05);
    expect(fit.shap.share.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(fit.shap.direction[0]).toBe("up"); // y rises with x1
    // Local accuracy across every explained holdout row.
    expect(fit.shap.maxAdditivityError).toBeLessThan(1e-8);
    // Lift: the top predicted decile has a far higher mean than the bottom.
    expect(fit.lift.groups.length).toBe(10);
    expect(fit.lift.actual[9]).toBeGreaterThan(fit.lift.actual[0] + 5);
  });

  test("binary target: AUC well above chance, directions read correctly", () => {
    const rand = makeRng(21);
    const rows: Row[] = Array.from({ length: 2000 }, () => {
      const x1 = gauss(rand);
      const x2 = gauss(rand);
      const x3 = gauss(rand);
      const p = 1 / (1 + Math.exp(-(2 * x1 - 1.5 * x2)));
      return { x1, x2, x3, claim_flag: rand() < p ? 1 : 0 };
    });
    const fit = fitGbm(rows, { column: "claim_flag", kind: "binary" }, [
      NUM("x1"),
      NUM("x2"),
      NUM("x3"),
    ]);
    expect(fit.metrics.primaryName).toBe("AUC");
    expect(fit.metrics.primary).toBeGreaterThan(0.8);
    expect(fit.metrics.logLoss).toBeLessThan(Math.log(2));
    expect(fit.shap.features[2]).toBe("x3");
    const dir = Object.fromEntries(fit.shap.features.map((f, i) => [f, fit.shap.direction[i]]));
    expect(dir.x1).toBe("up");
    expect(dir.x2).toBe("down");
    expect(fit.shap.scale).toBe("log-odds");
    expect(fit.shap.maxAdditivityError).toBeLessThan(1e-8);
  });

  test("count target: Poisson boosting explains deviance on the holdout", () => {
    const rand = makeRng(8);
    const poisson = (mu: number) => {
      const L = Math.exp(-mu);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= rand();
      } while (p > L);
      return k - 1;
    };
    const rows: Row[] = Array.from({ length: 3000 }, () => {
      const x1 = gauss(rand);
      const x2 = gauss(rand);
      return { x1, x2, claim_count: poisson(Math.exp(-0.5 + 0.9 * x1)) };
    });
    const fit = fitGbm(rows, { column: "claim_count", kind: "count" }, [NUM("x1"), NUM("x2")]);
    expect(fit.metrics.primaryName).toBe("deviance explained");
    expect(fit.metrics.primary).toBeGreaterThan(0.15);
    expect(fit.shap.features[0]).toBe("x1");
    expect(fit.shap.direction[0]).toBe("up");
    expect(fit.shap.scale).toBe("log mean");
  });

  test("categorical features split on their levels", () => {
    const rand = makeRng(4);
    const levels = ["north", "south", "east"];
    const effect: Record<string, number> = { north: 0, south: 2, east: 5 };
    const rows: Row[] = Array.from({ length: 900 }, () => {
      const region = levels[Math.floor(rand() * 3)];
      return { region, x: gauss(rand), y: effect[region] + 0.2 * gauss(rand) };
    });
    const fit = fitGbm(rows, { column: "y", kind: "continuous" }, [
      { name: "region", kind: "categorical" },
      NUM("x"),
    ]);
    expect(fit.metrics.primary).toBeGreaterThan(0.9);
    expect(fit.shap.features[0]).toBe("region");
    expect(fit.shap.direction[0]).toBeNull(); // levels have no direction
  });

  test("missing feature values are routed, not fatal", () => {
    const rows = continuousData(600, 9).map((r, i) => (i % 7 === 0 ? { ...r, x1: null } : r));
    const fit = fitGbm(rows, { column: "y", kind: "continuous" }, [NUM("x1"), NUM("x2")]);
    expect(Number.isFinite(fit.metrics.primary)).toBe(true);
    expect(fit.shap.maxAdditivityError).toBeLessThan(1e-8);
  });

  test("deterministic for a given seed", () => {
    const rows = continuousData(700, 2);
    const a = fitGbm(rows, { column: "y", kind: "continuous" }, [NUM("x1"), NUM("x2")]);
    const b = fitGbm(rows, { column: "y", kind: "continuous" }, [NUM("x1"), NUM("x2")]);
    expect(a.metrics.primary).toBe(b.metrics.primary);
    expect(a.shap.share).toEqual(b.shap.share);
  });

  test("row cap samples evenly and says so", () => {
    const fit = fitGbm(
      continuousData(3000, 3),
      { column: "y", kind: "continuous" },
      [NUM("x1"), NUM("x2")],
      { rowCap: 1000 },
    );
    expect(fit.sampled).toBe(true);
    expect(fit.rowsUsable).toBe(3000);
    expect(fit.nTrain + fit.nHoldout).toBe(1000);
  });

  test("refuses, with a reason, when the data cannot support a fit", () => {
    const tiny = continuousData(30);
    expect(() => fitGbm(tiny, { column: "y", kind: "continuous" }, [NUM("x1")])).toThrow(
      /need at least 50/,
    );
    const rows = continuousData(300);
    expect(() => fitGbm(rows, { column: "y", kind: "continuous" }, [])).toThrow(/no feature/);
    const constant = rows.map((r) => ({ ...r, y: 4 }));
    expect(() => fitGbm(constant, { column: "y", kind: "continuous" }, [NUM("x1")])).toThrow(
      /no variation/,
    );
    const rare = rows.map((r, i) => ({ ...r, flag: i < 3 ? 1 : 0 }));
    expect(() => fitGbm(rare, { column: "flag", kind: "binary" }, [NUM("x1")])).toThrow(
      /at least 5 of each/,
    );
  });
});
