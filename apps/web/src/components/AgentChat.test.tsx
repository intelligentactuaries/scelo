// Bun test — exercises pure event-rendering logic only. The React component
// itself needs a DOM and is verified manually in the dev server (Phase 1
// doesn't install jsdom). We re-implement the event-to-history reducer here
// so we can assert the contract independently.

import { describe, expect, test } from "bun:test";
import type { OrchestratorEvent } from "@/lib/api";

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; tool: string; output: unknown; duration_ms?: number }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string };

function reduce(items: ChatItem[], ev: OrchestratorEvent): ChatItem[] {
  switch (ev.kind) {
    case "thinking":
      return [...items, { kind: "thinking", text: ev.payload.text }];
    case "tool_call":
      return [
        ...items,
        {
          kind: "tool_call",
          tool: ev.payload.tool,
          arguments: ev.payload.arguments ?? {},
        },
      ];
    case "tool_result":
      return [
        ...items,
        {
          kind: "tool_result",
          tool: ev.payload.tool,
          output: ev.payload.output,
          duration_ms: ev.payload.duration_ms,
        },
      ];
    case "message":
      return [...items, { kind: "message", text: ev.payload.text }];
    case "error":
      return [...items, { kind: "error", text: ev.payload.message }];
    case "done":
      return items;
    default:
      // routing / wiki_retrieval / regulatory_retrieval — ignored by this
      // legacy reducer; the new chat-first reducer in lib/chatStream
      // handles them.
      return items;
  }
}

describe("AgentChat reducer", () => {
  test("renders thinking → tool_call → tool_result → message in order", () => {
    let s: ChatItem[] = [{ kind: "user", text: "what's my IBNR?" }];
    const events: OrchestratorEvent[] = [
      { kind: "thinking", payload: { text: "deciding tool" } },
      { kind: "tool_call", payload: { tool: "reserving.predict", arguments: { triangle: {} } } },
      {
        kind: "tool_result",
        payload: {
          tool: "reserving.predict",
          output: { mack: { ibnr_total: 52135.23 } },
          duration_ms: 234,
        },
      },
      { kind: "message", payload: { text: "Reserving result attached." } },
      { kind: "done", payload: { routing_engine: "rule_based" } },
    ];
    for (const ev of events) s = reduce(s, ev);
    expect(s.map((x) => x.kind)).toEqual([
      "user",
      "thinking",
      "tool_call",
      "tool_result",
      "message",
    ]);
  });

  test("error events render with their message text", () => {
    const s = reduce([], {
      kind: "error",
      payload: { message: "timeout" },
    });
    expect(s).toEqual([{ kind: "error", text: "timeout" }]);
  });

  test("done is a no-op for the rendered list", () => {
    const before: ChatItem[] = [{ kind: "user", text: "hi" }];
    const after = reduce(before, {
      kind: "done",
      payload: { routing_engine: "openrouter" },
    });
    expect(after).toBe(before);
  });
});

describe("conversation-history builder", () => {
  // The component sends the last 10 turns. The reducer here mirrors the
  // component's `buildHistory` shape — only user + assistant turns count.
  function buildHistory(items: ChatItem[]): { role: string; content: string }[] {
    const turns: { role: string; content: string }[] = [];
    for (const it of items) {
      if (it.kind === "user") turns.push({ role: "user", content: it.text });
      else if (it.kind === "message") turns.push({ role: "assistant", content: it.text });
    }
    return turns.slice(-10);
  }

  test("interleaves user + message; ignores thinking / tool_call / tool_result / error", () => {
    const items: ChatItem[] = [
      { kind: "user", text: "q1" },
      { kind: "thinking", text: "x" },
      { kind: "tool_call", tool: "a", arguments: {} },
      { kind: "tool_result", tool: "a", output: 1 },
      { kind: "message", text: "a1" },
      { kind: "error", text: "e1" },
      { kind: "user", text: "q2" },
      { kind: "message", text: "a2" },
    ];
    expect(buildHistory(items)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  test("trims to the last 10 turns", () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < 20; i++) {
      items.push({ kind: "user", text: `q${i}` });
      items.push({ kind: "message", text: `a${i}` });
    }
    const out = buildHistory(items);
    expect(out.length).toBe(10);
    expect(out[0]).toEqual({ role: "user", content: "q15" });
    expect(out[out.length - 1]).toEqual({ role: "assistant", content: "a19" });
  });
});
