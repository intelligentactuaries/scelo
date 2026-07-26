import { describe, expect, test } from "bun:test";
import { pipelinePlan } from "./pipeline";

describe("pipelinePlan", () => {
  test("unwired selection keeps its original order", () => {
    const plan = pipelinePlan(["a", "b", "c"], []);
    expect(plan.order).toEqual(["a", "b", "c"]);
    expect(plan.cyclic).toBe(false);
    expect(plan.upstreamOf.size).toBe(0);
  });

  test("wires reorder execution so sources run first", () => {
    // selection order has BF before chain-ladder; the wire flips them.
    const plan = pipelinePlan(
      ["bornhuetter-ferguson", "chain-ladder", "mack"],
      [
        { source: "chain-ladder", target: "bornhuetter-ferguson" },
        { source: "chain-ladder", target: "mack" },
      ],
    );
    expect(plan.order[0]).toBe("chain-ladder");
    expect(plan.order).toContain("mack");
    expect(plan.upstreamOf.get("bornhuetter-ferguson")).toEqual(["chain-ladder"]);
    expect(plan.cyclic).toBe(false);
  });

  test("stable among ready nodes: unwired models keep selection order", () => {
    const plan = pipelinePlan(["gbm", "descriptive", "shap"], [{ source: "gbm", target: "shap" }]);
    expect(plan.order).toEqual(["gbm", "descriptive", "shap"]);
  });

  test("wires to models outside the selection are ignored", () => {
    const plan = pipelinePlan(["a"], [{ source: "a", target: "ghost" }]);
    expect(plan.order).toEqual(["a"]);
    expect(plan.upstreamOf.size).toBe(0);
  });

  test("duplicate and self wires are deduped/ignored", () => {
    const plan = pipelinePlan(
      ["a", "b"],
      [
        { source: "a", target: "b" },
        { source: "a", target: "b" },
        { source: "b", target: "b" },
      ],
    );
    expect(plan.upstreamOf.get("b")).toEqual(["a"]);
  });

  test("cycles fall back to selection order and flag cyclic", () => {
    const plan = pipelinePlan(
      ["a", "b"],
      [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
      ],
    );
    expect(plan.cyclic).toBe(true);
    expect(plan.order).toEqual(["a", "b"]);
  });

  test("chain of three orders transitively", () => {
    const plan = pipelinePlan(
      ["shap", "gbm", "glm-severity"],
      [
        { source: "glm-severity", target: "gbm" },
        { source: "gbm", target: "shap" },
      ],
    );
    expect(plan.order).toEqual(["glm-severity", "gbm", "shap"]);
  });
});
