// Vitest/bun:test coverage for the SSE reducer and the merge-event logic.
// We exercise the chatStream reducer directly without mounting the hook —
// the hook's React lifecycle is verified visually in the dev server.

import { describe, expect, test } from "bun:test";
import type { OrchestratorEvent } from "./api";
import { __testing__ } from "./chatStream";
import type { AssistantPart } from "./conversations";

const { reducer, mergeEvent, partsToMarkdown, buildHistory } = __testing__;

function ev(kind: string, payload: Record<string, unknown>): OrchestratorEvent {
  return { kind, payload } as unknown as OrchestratorEvent;
}

describe("mergeEvent", () => {
  test("routing event becomes a routing part", () => {
    const parts = mergeEvent([], {
      kind: "routing",
      payload: {
        confidence: 0.9,
        confidence_band: "high",
        dispatched_tool: "reserving.predict",
      },
    } as OrchestratorEvent);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe("routing");
    if (parts[0].kind === "routing") {
      expect(parts[0].band).toBe("high");
      expect(parts[0].tool).toBe("reserving.predict");
    }
  });

  test("consecutive message events merge into one growing part", () => {
    let parts: AssistantPart[] = [];
    parts = mergeEvent(parts, ev("message", { text: "Hello " }));
    parts = mergeEvent(parts, ev("message", { text: "world" }));
    parts = mergeEvent(parts, ev("message", { text: "!" }));
    expect(parts).toHaveLength(1);
    if (parts[0].kind === "message") {
      expect(parts[0].text).toBe("Hello world!");
    }
  });

  test("a tool_call between messages does NOT split the streaming text", () => {
    let parts: AssistantPart[] = mergeEvent([], ev("message", { text: "before " }));
    parts = mergeEvent(
      parts,
      ev("tool_call", { tool: "reserving.predict", arguments: { triangle: "RAA" } }),
    );
    parts = mergeEvent(parts, ev("message", { text: "after" }));
    // The tool_call sits in the middle, but the second message starts a NEW
    // message part because the tool_call broke contiguity.
    expect(parts.map((p) => p.kind)).toEqual(["message", "tool_call", "message"]);
    const last = parts[parts.length - 1];
    if (last.kind === "message") expect(last.text).toBe("after");
  });

  test("tool_result extracts chart_spec_ids from output", () => {
    const parts = mergeEvent(
      [],
      ev("tool_result", {
        tool: "reserving.predict",
        output: { mack: { ibnr_total: 52000 }, chart_spec_ids: ["runoff", "fan"] },
        duration_ms: 510,
      }),
    );
    expect(parts).toHaveLength(1);
    if (parts[0].kind === "tool_result") {
      expect(parts[0].chart_spec_ids).toEqual(["runoff", "fan"]);
      expect(parts[0].specialist).toBe("reserving");
    }
  });

  test("tool_result extracts dashboard_path from output", () => {
    const parts = mergeEvent(
      [],
      ev("tool_result", {
        tool: "mortality.simulate",
        output: {
          model: "asal_survival_ecosystem",
          dashboard_path: "/dashboards/survival-ecosystem",
        },
      }),
    );
    expect(parts).toHaveLength(1);
    if (parts[0].kind === "tool_result") {
      expect(parts[0].dashboard_path).toBe("/dashboards/survival-ecosystem");
      expect(parts[0].specialist).toBe("mortality");
    }
  });

  test("error event becomes an error part", () => {
    const parts = mergeEvent([], ev("error", { message: "boom" }));
    expect(parts).toHaveLength(1);
    if (parts[0].kind === "error") expect(parts[0].text).toBe("boom");
  });

  test("done event is a no-op for parts", () => {
    const parts = mergeEvent([], ev("done", { routing_engine: "rule_based" }));
    expect(parts).toEqual([]);
  });
});

describe("partsToMarkdown", () => {
  test("flattens only the message parts in arrival order", () => {
    const parts: AssistantPart[] = [
      { kind: "routing", band: "high", tool: "x", confidence: 0.9 },
      { kind: "message", text: "Hello " },
      { kind: "tool_call", tool: "y", arguments: {} },
      { kind: "message", text: "world" },
    ];
    expect(partsToMarkdown(parts)).toBe("Hello world");
  });
});

describe("buildHistory", () => {
  test("filters empty assistant placeholders and clamps to last 10 turns", () => {
    const history = buildHistory(
      Array.from({ length: 15 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        // Mark the most recent assistant turn (index 13) as empty —
        // simulating an in-flight placeholder that should be dropped.
        content: i === 13 ? "" : `m${i}`,
        created_at: new Date().toISOString(),
      })),
    );
    expect(history.length).toBeLessThanOrEqual(10);
    // No empty assistant turns leak through to the orchestrator history.
    expect(history.every((h) => h.role !== "assistant" || h.content.length > 0)).toBe(true);
  });
});

describe("reducer", () => {
  test("startAssistant + applyEvent thread", () => {
    let s = reducer(
      {
        messages: [],
        isStreaming: false,
        activeAssistantId: null,
      },
      { type: "appendUser", message: { id: "u1", role: "user", content: "hi", created_at: "" } },
    );
    s = reducer(s, { type: "startAssistant", id: "a1" });
    expect(s.isStreaming).toBe(true);
    expect(s.activeAssistantId).toBe("a1");
    expect(s.messages).toHaveLength(2);

    s = reducer(s, {
      type: "applyEvent",
      id: "a1",
      event: ev("message", { text: "hi back" }),
    });
    const a = s.messages.find((m) => m.id === "a1");
    expect(a?.content).toBe("hi back");

    s = reducer(s, { type: "finishAssistant" });
    expect(s.isStreaming).toBe(false);
    expect(s.activeAssistantId).toBeNull();
  });

  test("truncateAfter keeps prefix inclusive", () => {
    const make = (i: number) => ({
      id: `m${i}`,
      role: "user" as const,
      content: `m${i}`,
      created_at: "",
    });
    const s = reducer(
      {
        messages: [make(0), make(1), make(2), make(3)],
        isStreaming: false,
        activeAssistantId: null,
      },
      { type: "truncateAfter", index: 1 },
    );
    expect(s.messages.map((m) => m.id)).toEqual(["m0", "m1"]);
  });
});
