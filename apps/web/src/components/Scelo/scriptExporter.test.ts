import { describe, expect, test } from "bun:test";
import type { ActivityEvent } from "./activityLog";
import { generateScript } from "./scriptExporter";

// ── fixtures ─────────────────────────────────────────────────────────────

const EVENTS: ActivityEvent[] = [
  {
    ts: 1,
    stage: "soft",
    kind: "dataset.load",
    payload: {
      name: "claims.csv",
      rows: 2_000_000,
      cols: 3,
      columns: ["id", "province", "sum_insurd"],
      source: "import",
    },
  },
  {
    ts: 2,
    stage: "soft",
    kind: "filter.add",
    payload: {
      description: "province = LIM",
      column: "province",
      spec: { kind: "eq", column: "province", value: "LIM" },
    },
  },
  {
    ts: 3,
    stage: "hard",
    kind: "runs.execute",
    payload: { models: ["glm-freq"] },
  },
];

describe("generateScript fidelity caveat", () => {
  // The scripts apply filters/cleaning before the model steps, but the
  // in-app quick runs execute on the unfiltered in-memory dataset. Every
  // artifact must say so once, near the top, so exported numbers that
  // differ from the app's don't read as a reproduction bug.
  test.each(["python", "r", "cpp", "prompt"] as const)(
    "%s header carries the unfiltered-quick-run note",
    (lang) => {
      const script = generateScript({ lang, events: EVENTS, stage: "hard" });
      expect(script).toContain("applies the recorded filters/cleaning");
      expect(script).toContain("unfiltered");
      // Once, near the top — not repeated per step.
      expect(script.split("unfiltered").length - 1).toBeLessThanOrEqual(2);
    },
  );

  test("prompt no longer claims runs executed against the filtered dataset", () => {
    const script = generateScript({ lang: "prompt", events: EVENTS, stage: "hard" });
    expect(script).not.toContain("against the cleaned, filtered, augmented dataset");
    expect(script).toContain("Ran all enabled models (glm-freq)");
    expect(script).toContain("unfiltered in-memory dataset");
  });

  test("cpp header keeps every banner line commented", () => {
    const script = generateScript({ lang: "cpp", events: EVENTS, stage: "hard" });
    const noteLine = script
      .split("\n")
      .find((l) => l.includes("applies the recorded filters/cleaning"));
    expect(noteLine).toBeDefined();
    expect(noteLine?.startsWith("//")).toBe(true);
  });
});
