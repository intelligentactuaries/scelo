// The desktop IDE's bridged runners must honour the Tools canvas's pins the
// way the in-browser runners do — a wire the canvas shows but the IDE
// ignores is exactly the decoration the typed pins removed. Stubs the
// preload bridge (`window.scelo`) with a canned statsmodels reply.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Dataset, Row } from "@scelo/core";
import { type RunResult, runModel, runModelAsync } from "./modelRunner";

const BETA0 = { frequency: Math.log(0.12), severity: Math.log(8_000) };

function pricing(): Dataset {
  const rows: Row[] = [];
  for (let i = 0; i < 120; i++) {
    const claims = i % 3;
    rows.push({
      region: ["north", "south", "east"][i % 3],
      claims,
      claim_amount: claims > 0 ? 1_000 + (i % 7) * 900 : 0,
    });
  }
  return { name: "book.csv", columns: ["region", "claims", "claim_amount"], rows };
}

const g = globalThis as unknown as { window?: unknown };
let hadWindow = false;
let savedWindow: unknown;

beforeAll(() => {
  hadWindow = "window" in g;
  savedWindow = g.window;
  g.window = {
    scelo: {
      runtimeStatus: async () => ({ python: true, r: false, resourceDir: "" }),
      runPython: async ({ stdin }: { stdin?: string }) => {
        const { kind, covariates } = JSON.parse(stdin ?? "{}") as {
          kind: "frequency" | "severity";
          covariates: string[];
        };
        return {
          ok: true,
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            kind,
            family: kind === "frequency" ? "Poisson" : "Gamma",
            link: "log",
            covariates,
            coefficients: [{ name: "Intercept", estimate: BETA0[kind], se: 0.1, z: 1, p: 0.3 }],
            aic: 100,
            deviance: 50,
            pearsonChi2: 48,
            nObservations: 120,
            source: "statsmodels-python",
          }),
        };
      },
    },
  };
});

afterAll(() => {
  // `typeof window` is what the bridges test, so undefined restores it.
  g.window = hadWindow ? savedWindow : undefined;
});

describe("IDE bridges honour the canvas wiring", () => {
  test("frequency wired into severity gives the base pure premium", async () => {
    const ds = pricing();
    const freq = await runModelAsync("glm-frequency", ds);
    expect(freq.source).toBe("python-bridge");
    expect(freq.headline.value).toBeCloseTo(0.12, 12);
    const sev = await runModelAsync("glm-severity", ds, new Map([["glm-frequency", freq]]));
    expect(sev.source).toBe("python-bridge");
    expect(sev.wiredFrom?.[0]?.id).toBe("glm-frequency");
    expect(sev.detail?.purePremium as number).toBeCloseTo(0.12 * 8_000, 6);
    expect(sev.secondary[0]?.label).toBe("base pure premium (freq × sev)");
  });

  test("unwired severity is severity alone", async () => {
    const sev = await runModelAsync("glm-severity", pricing());
    expect(sev.wiredFrom).toBeUndefined();
    expect(sev.detail?.purePremium).toBeUndefined();
  });

  test("a portfolio-mean frequency is not multiplied into a baseline severity", async () => {
    const ds = pricing();
    // The in-browser frequency (a mean, not a baseline) — e.g. after a
    // bridge failure fell back.
    const browserFreq: RunResult = runModel("glm-frequency", ds);
    expect(browserFreq.source).toBe("browser");
    const sev = await runModelAsync("glm-severity", ds, new Map([["glm-frequency", browserFreq]]));
    expect(sev.wiredFrom).toBeUndefined();
    expect(sev.secondary[0]?.value).toBe("not combined — frequency ran in-browser");
  });
});
