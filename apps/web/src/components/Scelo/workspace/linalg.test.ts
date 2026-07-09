import { describe, expect, test } from "bun:test";
import { corr, jacobiEigen, r2Score, solveLinear } from "./linalg";

describe("linalg · jacobiEigen", () => {
  test("recovers a known 2x2 spectrum", () => {
    // [[2,1],[1,2]] has eigenvalues 3 and 1, vectors (1,1)/sqrt2 and (1,-1)/sqrt2.
    const { values, vectors } = jacobiEigen([
      [2, 1],
      [1, 2],
    ]);
    expect(values[0]).toBeCloseTo(3, 6);
    expect(values[1]).toBeCloseTo(1, 6);
    // First eigenvector aligns with (1,1) up to sign.
    expect(Math.abs(vectors[0][0])).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(vectors[0][1])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  test("sorts a diagonal matrix in descending order", () => {
    const { values } = jacobiEigen([
      [1, 0, 0],
      [0, 3, 0],
      [0, 0, 2],
    ]);
    expect(values).toEqual([3, 2, 1]);
  });
});

describe("linalg · solveLinear", () => {
  test("solves a small system", () => {
    // 2x + y = 5 ; x + 3y = 10  ->  x = 1, y = 3.
    const x = solveLinear(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x).not.toBeNull();
    expect(x?.[0]).toBeCloseTo(1, 8);
    expect(x?.[1]).toBeCloseTo(3, 8);
  });

  test("returns null for a singular matrix", () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });
});

describe("linalg · scores", () => {
  test("r2Score is 1 for a perfect fit", () => {
    expect(r2Score([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 8);
  });
  test("corr is 1 for a positive linear relation", () => {
    expect(corr([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 8);
  });
});
