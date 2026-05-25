// Conversation store — localStorage-backed. The full CRUD + Vitest coverage
// lands in checkpoint 3; for now we expose just enough surface for ChatHome to
// mint an id without crashing if storage is unavailable (private mode etc.).

export type AttachedFile = {
  filename: string;
  bytes: number;
  classification: {
    specialist: string;
    confidence: number;
    reasoning: string;
    suggested_capability: string;
  };
  // Server-side path under .ia/uploads/{conv}/...; included in the user
  // message so the orchestrator/specialists can read it back.
  saved_path: string;
};

export type ConversationMessage = {
  // Stable per-message id so React keys are deterministic and edit/branch can
  // target a specific point in the thread.
  id: string;
  role: "user" | "assistant";
  // For user messages, content is the raw text. For assistant messages, the
  // chat composes one message from many SSE events (see ADR-0018) so we keep a
  // structured `parts` array; `content` is the markdown-only rendering.
  content: string;
  parts?: AssistantPart[];
  attachments?: AttachedFile[];
  created_at: string; // ISO
};

export type AssistantPart =
  | { kind: "routing"; band: "high" | "medium" | "low"; tool?: string; confidence?: number }
  | { kind: "wiki_retrieval"; n: number; sources: string[] }
  | { kind: "regulatory_retrieval"; n: number; sources: string[] }
  | { kind: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | {
      kind: "tool_result";
      tool: string;
      output: unknown;
      duration_ms?: number;
      chart_spec_ids?: string[];
      specialist?: string;
      dashboard_path?: string;
    }
  | { kind: "message"; text: string }
  | {
      kind: "usage";
      provider?: string;
      input_tokens?: number;
      output_tokens?: number;
    }
  | { kind: "error"; text: string };

export type Conversation = {
  id: string;
  title: string;
  messages: ConversationMessage[];
  created_at: string;
  updated_at: string;
  branched_from?: { conversation_id: string; message_index: number };
  pinned?: boolean;
};

const STORAGE_KEY = "ia.conversations.v1";
const TITLE_MAX = 50;

function uuid(): string {
  // Use crypto.randomUUID where available; fall back to a v4-ish stamp.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readAll(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as Conversation[];
  } catch {
    return [];
  }
}

function writeAll(items: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Quota exceeded or storage unavailable — silently drop. UI will show a
    // toast in checkpoint 14 if writes fail.
  }
}

function deriveTitle(messages: ConversationMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New conversation";
  const oneLine = first.content.split("\n", 1)[0].trim();
  if (oneLine.length === 0) return "New conversation";
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1)}…` : oneLine;
}

export const conversationStore = {
  list(): Conversation[] {
    const items = readAll();
    return [...items].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  },
  get(id: string): Conversation | null {
    return readAll().find((c) => c.id === id) ?? null;
  },
  create(branchedFrom?: { conversation_id: string; message_index: number }): Conversation {
    const conv: Conversation = {
      id: uuid(),
      title: "New conversation",
      messages: [],
      created_at: nowIso(),
      updated_at: nowIso(),
      ...(branchedFrom ? { branched_from: branchedFrom } : {}),
    };
    const items = readAll();
    items.unshift(conv);
    writeAll(items);
    return conv;
  },
  update(
    id: string,
    patch: Partial<Pick<Conversation, "title" | "messages">>,
  ): Conversation | null {
    const items = readAll();
    const i = items.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const merged: Conversation = {
      ...items[i],
      ...patch,
      updated_at: nowIso(),
    };
    // Auto-derive a title only when the caller didn't pass one *and* the
    // existing title is still the default — preserves user renames.
    const titleIsStillDefault = items[i].title === "New conversation" || items[i].title === "";
    if (patch.messages && patch.title === undefined && titleIsStillDefault) {
      merged.title = deriveTitle(patch.messages);
    }
    items[i] = merged;
    writeAll(items);
    return merged;
  },
  rename(id: string, title: string): Conversation | null {
    return conversationStore.update(id, { title });
  },
  setPinned(id: string, pinned: boolean): Conversation | null {
    const items = readAll();
    const i = items.findIndex((c) => c.id === id);
    if (i < 0) return null;
    items[i] = { ...items[i], pinned, updated_at: items[i].updated_at };
    writeAll(items);
    return items[i];
  },
  delete(id: string): void {
    writeAll(readAll().filter((c) => c.id !== id));
  },
  /** Create the conversation if it doesn't exist, otherwise leave it
   *  alone. Used by the workspace AI panel, whose id is derived from
   *  the workspace path rather than minted by `create()` — the record
   *  has to materialise before useChatStream's debounce-saver writes
   *  to it, since `update()` no-ops on missing ids. */
  upsert(seed: { id: string; title?: string; messages?: ConversationMessage[] }): Conversation {
    const items = readAll();
    const existing = items.find((c) => c.id === seed.id);
    if (existing) return existing;
    const conv: Conversation = {
      id: seed.id,
      title: seed.title ?? "New conversation",
      messages: seed.messages ?? [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    items.unshift(conv);
    writeAll(items);
    return conv;
  },
  // Forward-only branching — copy messages 0..messageIndex inclusive into a
  // new conversation and stamp `branched_from` so the UI can show a
  // breadcrumb. The original is left untouched.
  branch(sourceId: string, messageIndex: number): Conversation | null {
    const src = conversationStore.get(sourceId);
    if (!src) return null;
    const i = Math.max(0, Math.min(messageIndex, src.messages.length - 1));
    const slice = src.messages.slice(0, i + 1);
    const conv: Conversation = {
      id: uuid(),
      title: src.title === "New conversation" ? deriveTitle(slice) : `${src.title} (branch)`,
      messages: slice,
      created_at: nowIso(),
      updated_at: nowIso(),
      branched_from: { conversation_id: sourceId, message_index: i },
    };
    const items = readAll();
    items.unshift(conv);
    writeAll(items);
    return conv;
  },
  export(id: string): Blob | null {
    const conv = conversationStore.get(id);
    if (!conv) return null;
    return new Blob([JSON.stringify(conv, null, 2)], { type: "application/json" });
  },
};

export const __testing__ = { deriveTitle, STORAGE_KEY };
