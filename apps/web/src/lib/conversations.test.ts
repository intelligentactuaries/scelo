// Vitest/bun:test coverage for the localStorage-backed ConversationStore.
// We use an in-memory localStorage shim to keep the tests deterministic and
// avoid leaking between cases.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ConversationMessage, __testing__, conversationStore } from "./conversations";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

const realLocalStorage = globalThis.localStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: realLocalStorage,
    configurable: true,
  });
});

function userMsg(content: string): ConversationMessage {
  return {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content,
    created_at: new Date().toISOString(),
  };
}

describe("conversationStore.create", () => {
  test("mints a UUID-shaped id and starts with no messages", () => {
    const c = conversationStore.create();
    expect(c.id.length).toBeGreaterThan(8);
    expect(c.messages).toEqual([]);
    expect(c.title).toBe("New conversation");
    expect(c.created_at).toBe(c.updated_at);
  });

  test("persists across reads", () => {
    const c = conversationStore.create();
    const round = conversationStore.get(c.id);
    expect(round).not.toBeNull();
    expect(round?.id).toBe(c.id);
  });

  test("records branched_from when supplied", () => {
    const c = conversationStore.create({ conversation_id: "abc", message_index: 4 });
    expect(c.branched_from).toEqual({ conversation_id: "abc", message_index: 4 });
  });
});

describe("conversationStore.update + title derivation", () => {
  test("auto-derives title from first user message when title is still default", () => {
    const c = conversationStore.create();
    const updated = conversationStore.update(c.id, {
      messages: [userMsg("what is the IBNR for the RAA triangle?")],
    });
    expect(updated?.title).toBe("what is the IBNR for the RAA triangle?");
  });

  test("preserves a user-renamed title even when messages change", () => {
    const c = conversationStore.create();
    conversationStore.rename(c.id, "RAA review");
    const updated = conversationStore.update(c.id, {
      messages: [userMsg("a different first message")],
    });
    expect(updated?.title).toBe("RAA review");
  });

  test("truncates a long first message to 50 chars with ellipsis", () => {
    const c = conversationStore.create();
    const long = "x".repeat(200);
    const updated = conversationStore.update(c.id, { messages: [userMsg(long)] });
    expect(updated?.title.length).toBeLessThanOrEqual(50);
    expect(updated?.title.endsWith("…")).toBe(true);
  });

  test("uses only the first line for title", () => {
    const c = conversationStore.create();
    const updated = conversationStore.update(c.id, {
      messages: [userMsg("first line\nsecond line\nthird line")],
    });
    expect(updated?.title).toBe("first line");
  });

  test("bumps updated_at on every update", async () => {
    const c = conversationStore.create();
    await new Promise((r) => setTimeout(r, 5));
    const u = conversationStore.update(c.id, { messages: [userMsg("hi")] });
    expect(u && Date.parse(u.updated_at) >= Date.parse(c.updated_at)).toBe(true);
  });

  test("returns null when id does not exist", () => {
    expect(conversationStore.update("does-not-exist", { messages: [] })).toBeNull();
  });
});

describe("conversationStore.list / sort", () => {
  test("sorts by updated_at descending", async () => {
    const a = conversationStore.create();
    await new Promise((r) => setTimeout(r, 2));
    const b = conversationStore.create();
    await new Promise((r) => setTimeout(r, 2));
    conversationStore.update(a.id, { messages: [userMsg("touched a")] });
    const ids = conversationStore.list().map((c) => c.id);
    expect(ids[0]).toBe(a.id);
    expect(ids).toContain(b.id);
  });
});

describe("conversationStore.delete + export", () => {
  test("delete removes the conversation", () => {
    const c = conversationStore.create();
    conversationStore.delete(c.id);
    expect(conversationStore.get(c.id)).toBeNull();
  });

  test("export returns a JSON Blob", async () => {
    const c = conversationStore.create();
    conversationStore.update(c.id, { messages: [userMsg("hi")] });
    const blob = conversationStore.export(c.id);
    expect(blob).not.toBeNull();
    expect(blob?.type.startsWith("application/json")).toBe(true);
    const text = await blob?.text();
    expect(text).toContain('"hi"');
  });

  test("export returns null for unknown id", () => {
    expect(conversationStore.export("nope")).toBeNull();
  });
});

describe("storage tolerance", () => {
  test("recovers from corrupt JSON in localStorage", () => {
    localStorage.setItem(__testing__.STORAGE_KEY, "not json");
    expect(conversationStore.list()).toEqual([]);
  });

  test("ignores non-array stored values", () => {
    localStorage.setItem(__testing__.STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(conversationStore.list()).toEqual([]);
  });
});
