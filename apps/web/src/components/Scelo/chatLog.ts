// Append-only audit trail of every chatbot turn in the system.
//
// This is NOT the same thing as `useNodeChat`'s `memoryKey` persistence.
// That stores the LIVE state of one thread, keyed by thread, and is
// overwritten in place on every change — it answers "what is in this chat
// right now". This log answers "what was asked, of which bot, when", never
// overwrites, and spans every surface:
//
//   • the macro node chats            (macro-<stage>)
//   • the three stage chats           (soft-stage / tools-stage / hard-stage)
//   • the per-column chats            (soft-col:<column>)
//   • the tools hub + per-model chats (tools-hub / tools-model:<id>)
//   • the hard-data detail chats      (hard-detail:<modelId>)
//   • the swarm council chatbot       (logged server-side, merged in by the
//                                      history view — see /api/chat-log)
//
// Storage is a bounded ring buffer in localStorage. Chat transcripts are
// unbounded by nature and localStorage is a hard ~5MB per origin shared with
// the session snapshot, so both a turn count AND a character budget are
// enforced; the oldest entries are dropped first.

export type ChatLogSource = "scelo" | "swarm";

export type ChatLogEntry = {
  id: string;
  /** Epoch ms. */
  ts: number;
  source: ChatLogSource;
  /** Stable thread identifier — the `memoryKey` suffix for Scelo chats, the
   *  run id for swarm chats. Groups turns into conversations. */
  thread: string;
  /** Human label for the surface, e.g. `soft · column «premium»`. */
  label: string;
  role: "user" | "assistant";
  content: string;
  /** Project name at the time of the turn, when the session had one. */
  project?: string;
  /** Assistant turns from the swarm carry the model that answered. */
  model?: string;
};

const STORAGE_KEY = "scelo:chat-log.v1";
/** Hard ceiling on retained turns. */
export const CHAT_LOG_MAX_ENTRIES = 2000;
/** Character budget across all retained content. localStorage is ~5MB for the
 *  whole origin and the session snapshot already claims a large share of it,
 *  so the log caps itself well below that rather than racing for the quota. */
export const CHAT_LOG_MAX_CHARS = 600_000;
/** Longest single turn retained verbatim. A pasted 200k-row CSV in a chat
 *  would otherwise evict the entire rest of the history by itself. */
export const CHAT_LOG_MAX_ENTRY_CHARS = 8_000;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `scelo-${crypto.randomUUID()}`;
  }
  return `scelo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Oldest-first eviction against both budgets. Exported for testing. */
export function trimChatLog(entries: ChatLogEntry[]): ChatLogEntry[] {
  let out = entries.length > CHAT_LOG_MAX_ENTRIES ? entries.slice(-CHAT_LOG_MAX_ENTRIES) : entries;
  let chars = 0;
  for (const e of out) chars += e.content.length;
  if (chars <= CHAT_LOG_MAX_CHARS) return out;
  let drop = 0;
  while (drop < out.length - 1 && chars > CHAT_LOG_MAX_CHARS) {
    chars -= out[drop].content.length;
    drop++;
  }
  out = out.slice(drop);
  return out;
}

export function readChatLog(): ChatLogEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatLogEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: ChatLogEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded even after trimming — halve and retry once. Losing old
    // audit rows beats throwing inside a chat send.
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(entries.slice(-Math.ceil(entries.length / 2))),
      );
    } catch {
      // give up silently
    }
  }
}

/** Notifies open history views in this tab (the `storage` event only fires
 *  in OTHER tabs, so a same-tab viewer would never refresh without this). */
const CHANGE_EVENT = "scelo:chat-log-changed";

export function subscribeChatLog(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => fn();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

export function appendChatTurns(
  turns: Array<Omit<ChatLogEntry, "id" | "ts" | "source"> & { ts?: number }>,
): void {
  if (turns.length === 0) return;
  const now = Date.now();
  const additions: ChatLogEntry[] = turns.map((t, i) => ({
    id: newId(),
    // +i so a question and its reply, appended in the same millisecond,
    // still sort in the order they happened.
    ts: t.ts ?? now + i,
    source: "scelo",
    thread: t.thread,
    label: t.label,
    role: t.role,
    content:
      t.content.length > CHAT_LOG_MAX_ENTRY_CHARS
        ? `${t.content.slice(0, CHAT_LOG_MAX_ENTRY_CHARS)}\n…[truncated in log]`
        : t.content,
    ...(t.project ? { project: t.project } : {}),
    ...(t.model ? { model: t.model } : {}),
  }));
  write(trimChatLog([...readChatLog(), ...additions]));
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearChatLog(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

// ── swarm merge ───────────────────────────────────────────────────────────

import { swarmApiUrl } from "../../lib/swarmConfig";

type SwarmLogRow = {
  id: string;
  ts: number;
  runId: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
};

/** Pull the swarm council chatbot's server-side transcript. Returns [] when
 *  the swarm isn't running — its history is a bonus, not a precondition for
 *  showing Scelo's own. */
export async function fetchSwarmChatLog(signal?: AbortSignal): Promise<ChatLogEntry[]> {
  try {
    const res = await fetch(`${swarmApiUrl()}/api/chat-log?limit=2000`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { entries?: SwarmLogRow[] };
    return (body.entries ?? []).map((r) => ({
      id: r.id,
      ts: r.ts,
      source: "swarm" as const,
      thread: `swarm-run:${r.runId}`,
      label: `swarm · council run ${r.runId.slice(0, 8)}`,
      role: r.role,
      content: r.content,
      ...(r.model ? { model: r.model } : {}),
    }));
  } catch {
    return [];
  }
}

// ── export ────────────────────────────────────────────────────────────────

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

export function exportChatLogMarkdown(entries: ChatLogEntry[]): string {
  const out: string[] = ["# Scelo chat history", ""];
  out.push(`${entries.length} turn${entries.length === 1 ? "" : "s"} across all chatbots.`, "");
  // Grouped by thread so a conversation reads as a conversation, with threads
  // ordered by their most recent activity.
  const byThread = new Map<string, ChatLogEntry[]>();
  for (const e of entries) {
    const list = byThread.get(e.thread) ?? [];
    list.push(e);
    byThread.set(e.thread, list);
  }
  const threads = [...byThread.entries()].sort(
    (a, b) => Math.max(...b[1].map((e) => e.ts)) - Math.max(...a[1].map((e) => e.ts)),
  );
  for (const [thread, turns] of threads) {
    const sorted = [...turns].sort((a, b) => a.ts - b.ts);
    out.push(`## ${sorted[0].label}`);
    out.push(
      `\`${thread}\` · ${sorted.length} turns · last active ${stamp(sorted.at(-1)?.ts ?? 0)}`,
    );
    out.push("");
    for (const t of sorted) {
      const who = t.role === "user" ? "**you**" : `**${t.source === "swarm" ? "swarm" : "scelo"}**`;
      const model = t.model ? ` _(${t.model})_` : "";
      out.push(`- ${stamp(t.ts)} ${who}${model}: ${t.content.replace(/\n/g, "\n  ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function exportChatLogJson(entries: ChatLogEntry[]): string {
  return JSON.stringify({ exportedAt: Date.now(), count: entries.length, entries }, null, 2);
}
