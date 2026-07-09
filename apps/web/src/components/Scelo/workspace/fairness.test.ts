// Case C, in miniature: a model trained on (proxy, legit) launders the
// protected attribute through the proxy; the workspace surfaces the channel and
// residualising the proxy against the protected attribute closes it.

import { describe, expect, test } from "bun:test";
import { protectedReadout } from "./fairness";
import { caseCData } from "./fixtures";

describe("fairness · protected-direction audit", () => {
  const audit = protectedReadout({
    rows: caseCData().rows,
    protectedCol: "protected",
    legitimateCols: ["legit"],
    proxyCols: ["proxy", "legit"],
    targetCol: "cost",
  });

  test("the concealed channel is visible before mitigation", () => {
    expect(audit.alignmentBefore).toBeGreaterThan(0.1);
    expect(audit.disparityBefore).toBeGreaterThan(0.2);
  });

  test("residualising the proxy closes the channel", () => {
    expect(audit.alignmentAfter).toBeLessThan(audit.alignmentBefore);
    expect(audit.disparityAfter).toBeLessThan(audit.disparityBefore);
    expect(audit.alignmentAfter).toBeLessThan(0.05);
  });

  test("fit to the legitimate (fair) target is not sacrificed", () => {
    expect(audit.fitAfter).toBeGreaterThanOrEqual(audit.fitBefore - 0.05);
  });
});
