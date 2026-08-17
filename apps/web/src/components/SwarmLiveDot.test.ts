// The swarm LED's state → look contract: green + glowing when the probe
// succeeds, red when it fails, a hollow pulsing ring while probing. Every
// swarm-liveness surface renders through this, so if it drifts they all do.
import { describe, expect, test } from "bun:test";
import { swarmLedClass, swarmLedLabel } from "./SwarmLiveDot";

describe("swarmLedClass", () => {
  test("live is the lit green LED", () => {
    expect(swarmLedClass("up")).toBe("ia-led ia-led-live");
  });
  test("offline is the red LED — not a grey pip", () => {
    expect(swarmLedClass("down")).toBe("ia-led ia-led-down");
    expect(swarmLedClass("down")).not.toContain("fg-dim");
  });
  test("probing is the hollow pulsing ring", () => {
    expect(swarmLedClass("probing")).toBe("ia-led ia-led-probing");
  });
});

test("labels name the state for titles / screen readers", () => {
  expect(swarmLedLabel("up")).toBe("swarm live");
  expect(swarmLedLabel("down")).toBe("swarm offline");
  expect(swarmLedLabel("probing")).toContain("probing");
});
