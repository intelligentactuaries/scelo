// Pure-logic tests for the swarm modal's augment pre-flight guard and
// failure classification. The component itself (mode reset on open,
// replace-confirm arming) is exercised in the browser; these cover the
// text/branching that decides what the user is told when things fail.
import { describe, expect, test } from "bun:test";
import {
  augmentRowGuard,
  describeHttpFailure,
  describeNetworkFailure,
} from "./SimulateScenarioModal";

describe("augmentRowGuard", () => {
  test("allows datasets at or under the 100k limit", () => {
    expect(augmentRowGuard(0)).toBeNull();
    expect(augmentRowGuard(10_000)).toBeNull();
    expect(augmentRowGuard(100_000)).toBeNull();
  });

  test("blocks datasets over the limit with an actionable message", () => {
    const msg = augmentRowGuard(250_000);
    expect(msg).not.toBeNull();
    expect(msg).toContain((250_000).toLocaleString());
    expect(msg).toContain((100_000).toLocaleString());
    expect(msg).toContain("smaller sample");
  });

  test("mentions the full-fidelity row count for sampled imports", () => {
    const msg = augmentRowGuard(250_000, 2_000_000);
    expect(msg).toContain(`a sample of ${(2_000_000).toLocaleString()}`);
  });

  test("omits the sample note when sourceTotalRows adds nothing", () => {
    expect(augmentRowGuard(250_000, 250_000)).not.toContain("sample of");
    expect(augmentRowGuard(250_000, undefined)).not.toContain("sample of");
  });
});

describe("describeNetworkFailure", () => {
  test("blames the server and gives start instructions", () => {
    const f = describeNetworkFailure(1024);
    expect(f.message).toContain(":3010");
    expect(f.message).toContain("is it running");
    expect(f.hint).toContain("PORT=3010");
    expect(f.hint).toContain("docs: swarm/running");
  });

  test("small bodies get no severed-body note", () => {
    const f = describeNetworkFailure(1024);
    expect(f.hint).not.toContain("128 MB");
  });

  test("oversize bodies add the severed-body explanation", () => {
    const f = describeNetworkFailure(200 * 1024 * 1024);
    expect(f.hint).toContain("~200 MB");
    expect(f.hint).toContain("128 MB");
  });
});

describe("describeHttpFailure", () => {
  test("shows status + collapsed body snippet, and NO server-down hint", () => {
    const f = describeHttpFailure("/api/simulate", 500, "Internal Server Error", "boom\n  at x");
    expect(f.message).toContain("500 Internal Server Error");
    expect(f.message).toContain("boom at x");
    expect(f.hint).toBeNull();
  });

  test("truncates long bodies to a 200-char snippet", () => {
    const f = describeHttpFailure("/api/simulate", 413, "", "x".repeat(10_000));
    expect(f.message.length).toBeLessThan(300);
  });

  test("omits the snippet separator for empty bodies", () => {
    const f = describeHttpFailure("/api/simulate/augment", 502, "", "");
    expect(f.message).toBe("swarm /api/simulate/augment responded 502");
  });
});
