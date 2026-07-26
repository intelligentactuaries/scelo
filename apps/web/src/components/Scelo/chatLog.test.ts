import { beforeEach, describe, expect, test } from "bun:test";
import {
  CHAT_LOG_MAX_ENTRIES,
  CHAT_LOG_MAX_ENTRY_CHARS,
  type ChatLogEntry,
  appendChatTurns,
  clearChatLog,
  exportChatLogJson,
  exportChatLogMarkdown,
  readChatLog,
  trimChatLog,
} from "./chatLog";

// Bare bun has no DOM, so the module's persistence path would short-circuit
// and never be exercised. Install minimal stubs — but ONLY when the global
// is genuinely absent: another test file in the same run registers a DOM
// environment, which makes `localStorage` a readonly accessor, and a plain
// assignment there throws (`Attempted to assign to readonly property`) and
// fails every test in this file depending on file order. defineProperty +
// the presence check makes this file order-independent.
function installStubs() {
  const store = new Map<string, string>();
  if (typeof localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  }
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        dispatchEvent: () => true,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  }
}

const entry = (over: Partial<ChatLogEntry> = {}): ChatLogEntry => ({
  id: "e",
  ts: 1,
  source: "scelo",
  thread: "t",
  label: "soft · stage",
  role: "user",
  content: "hi",
  ...over,
});

beforeEach(() => {
  installStubs();
  clearChatLog();
});

describe("trimChatLog", () => {
  test("keeps a small log untouched", () => {
    const log = [entry({ id: "a" }), entry({ id: "b" })];
    expect(trimChatLog(log)).toHaveLength(2);
  });

  test("caps entry count, dropping the OLDEST", () => {
    const log = Array.from({ length: CHAT_LOG_MAX_ENTRIES + 50 }, (_, i) =>
      entry({ id: `e${i}`, ts: i }),
    );
    const out = trimChatLog(log);
    expect(out).toHaveLength(CHAT_LOG_MAX_ENTRIES);
    // Newest must survive — an audit view opens on recent activity.
    expect(out.at(-1)?.id).toBe(`e${CHAT_LOG_MAX_ENTRIES + 49}`);
  });

  test("character budget evicts further when turns are long", () => {
    // 40 turns × 50k chars = 2M, far over the 600k budget.
    const log = Array.from({ length: 40 }, (_, i) =>
      entry({ id: `e${i}`, ts: i, content: "x".repeat(50_000) }),
    );
    const out = trimChatLog(log);
    expect(out.length).toBeLessThan(40);
    expect(out.at(-1)?.id).toBe("e39");
    const chars = out.reduce((n, e) => n + e.content.length, 0);
    expect(chars).toBeLessThanOrEqual(600_000);
  });

  test("never empties the log entirely, even for one oversized turn", () => {
    const out = trimChatLog([entry({ id: "huge", content: "x".repeat(5_000_000) })]);
    expect(out).toHaveLength(1);
  });
});

describe("appendChatTurns", () => {
  test("round-trips through storage", () => {
    appendChatTurns([
      { thread: "p:soft-stage", label: "soft · stage", role: "user", content: "clean my data" },
      { thread: "p:soft-stage", label: "soft · stage", role: "assistant", content: "Done." },
    ]);
    const log = readChatLog();
    expect(log).toHaveLength(2);
    expect(log[0].role).toBe("user");
    expect(log[0].source).toBe("scelo");
    expect(log[1].content).toBe("Done.");
  });

  test("a question and its reply keep their order within one millisecond", () => {
    appendChatTurns([
      { thread: "t", label: "l", role: "user", content: "q" },
      { thread: "t", label: "l", role: "assistant", content: "a" },
    ]);
    const [q, a] = readChatLog();
    expect(a.ts).toBeGreaterThan(q.ts);
  });

  test("appends rather than overwriting", () => {
    appendChatTurns([{ thread: "t", label: "l", role: "user", content: "one" }]);
    appendChatTurns([{ thread: "t", label: "l", role: "user", content: "two" }]);
    expect(readChatLog().map((e) => e.content)).toEqual(["one", "two"]);
  });

  test("truncates a single oversized turn instead of letting it evict the log", () => {
    appendChatTurns([
      { thread: "t", label: "l", role: "user", content: "y".repeat(CHAT_LOG_MAX_ENTRY_CHARS * 3) },
    ]);
    const [e] = readChatLog();
    expect(e.content.length).toBeLessThan(CHAT_LOG_MAX_ENTRY_CHARS + 100);
    expect(e.content).toContain("[truncated in log]");
  });

  test("no-ops on an empty batch", () => {
    appendChatTurns([]);
    expect(readChatLog()).toHaveLength(0);
  });

  test("carries project when supplied, omits it otherwise", () => {
    appendChatTurns([
      { thread: "t", label: "l", role: "user", content: "a", project: "Motor 2026" },
      { thread: "t", label: "l", role: "user", content: "b" },
    ]);
    const log = readChatLog();
    expect(log[0].project).toBe("Motor 2026");
    expect(log[1].project).toBeUndefined();
  });
});

describe("export", () => {
  const sample: ChatLogEntry[] = [
    entry({ id: "1", ts: 1_000, thread: "A", label: "soft · stage", role: "user", content: "q1" }),
    entry({
      id: "2",
      ts: 2_000,
      thread: "A",
      label: "soft · stage",
      role: "assistant",
      content: "a1",
    }),
    entry({
      id: "3",
      ts: 9_000,
      thread: "B",
      label: "swarm · council run 1234",
      source: "swarm",
      role: "user",
      content: "q2",
    }),
    // The swarm records provider/model on assistant rows only.
    entry({
      id: "4",
      ts: 9_500,
      thread: "B",
      label: "swarm · council run 1234",
      source: "swarm",
      role: "assistant",
      content: "a2",
      model: "gemma3",
    }),
  ];

  test("markdown groups by conversation, most recent first", () => {
    const md = exportChatLogMarkdown(sample);
    expect(md).toContain("# Scelo chat history");
    // Thread B is more recent, so it must come before A.
    expect(md.indexOf("swarm · council run 1234")).toBeLessThan(md.indexOf("soft · stage"));
    expect(md).toContain("q1");
    expect(md).toContain("gemma3");
    expect(md).toContain("4 turns");
  });

  test("markdown labels swarm turns as swarm, not scelo", () => {
    const md = exportChatLogMarkdown([sample[3], sample[1]]);
    expect(md).toContain("**swarm**");
    expect(md).toContain("**scelo**");
  });

  test("json export is parseable and complete", () => {
    const parsed = JSON.parse(exportChatLogJson(sample));
    expect(parsed.count).toBe(4);
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[3].source).toBe("swarm");
    expect(parsed.entries[3].model).toBe("gemma3");
  });

  test("empty export still produces a valid document", () => {
    expect(exportChatLogMarkdown([])).toContain("0 turns");
    expect(JSON.parse(exportChatLogJson([])).count).toBe(0);
  });
});
