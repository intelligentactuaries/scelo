import { describe, expect, test } from "bun:test";
import { type ActivityEvent, trimEventsPreservingAnchors } from "./activityLog";

// ── fixtures ─────────────────────────────────────────────────────────────

function loadEvent(ts: number): ActivityEvent {
  return {
    ts,
    stage: "soft",
    kind: "dataset.load",
    payload: {
      name: "claims.csv",
      rows: 2_000_000,
      cols: 25,
      columns: ["id", "sum_insurd", "province"],
      source: "import",
    },
  };
}

function pickEvent(ts: number): ActivityEvent {
  return {
    ts,
    stage: "tools",
    kind: "models.aiPick",
    payload: {
      domain: "pricing",
      models: [{ id: "glm-freq", rationale: "frequency GLM" }],
      summary: "pricing dataset — GLMs",
      source: "ai",
    },
  };
}

function fillerEvent(ts: number): ActivityEvent {
  return {
    ts,
    stage: "soft",
    kind: "cleaning.column",
    payload: { column: `col_${ts}`, action: "trim", affected: ts },
  };
}

describe("trimEventsPreservingAnchors", () => {
  test("returns the log untouched when under the cap", () => {
    const events = [loadEvent(1), fillerEvent(2), fillerEvent(3)];
    expect(trimEventsPreservingAnchors(events, 10)).toBe(events);
  });

  test("plain tail-slice when the anchors are already inside the tail", () => {
    const events = [fillerEvent(1), fillerEvent(2), loadEvent(3), pickEvent(4), fillerEvent(5)];
    const out = trimEventsPreservingAnchors(events, 4);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.ts)).toEqual([2, 3, 4, 5]);
  });

  test("pins the most recent dataset.load that a tail-slice would drop", () => {
    const events: ActivityEvent[] = [loadEvent(1)];
    for (let ts = 2; ts <= 300; ts++) events.push(fillerEvent(ts));
    const out = trimEventsPreservingAnchors(events, 200);
    expect(out).toHaveLength(200);
    expect(out[0].kind).toBe("dataset.load");
    // The rest is the newest tail, minus one slot ceded to the pin.
    expect(out[1].ts).toBe(102);
    expect(out[out.length - 1].ts).toBe(300);
  });

  test("pins both anchor kinds, in chronological order, within the cap", () => {
    const events: ActivityEvent[] = [loadEvent(1), pickEvent(2)];
    for (let ts = 3; ts <= 300; ts++) events.push(fillerEvent(ts));
    const out = trimEventsPreservingAnchors(events, 200);
    expect(out).toHaveLength(200);
    expect(out[0].kind).toBe("dataset.load");
    expect(out[1].kind).toBe("models.aiPick");
    expect(out[out.length - 1].ts).toBe(300);
  });

  test("pins the MOST RECENT anchor of each kind, not the first", () => {
    const events: ActivityEvent[] = [loadEvent(1), loadEvent(2)];
    for (let ts = 3; ts <= 300; ts++) events.push(fillerEvent(ts));
    const out = trimEventsPreservingAnchors(events, 200);
    const loads = out.filter((e) => e.kind === "dataset.load");
    expect(loads).toHaveLength(1);
    expect(loads[0].ts).toBe(2);
  });
});
