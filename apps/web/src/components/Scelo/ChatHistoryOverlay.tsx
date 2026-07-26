// Full-screen audit view over every chatbot turn in the system.
//
// Merges two sources into one timeline:
//   • Scelo's own bots — read from localStorage (see chatLog.ts), written by
//     `useNodeChat` for every surface that passes a `logLabel`.
//   • The swarm council chatbot — fetched from the swarm server's
//     /api/chat-log. It lives in a separate process behind an iframe, so its
//     transcript can only come over HTTP; when the swarm is down we show
//     Scelo's history alone rather than failing the whole view.
//
// Read-only by design. This is a record of what was asked and answered, not
// a place to resume a conversation — reopening a thread is what the chat
// panels themselves are for.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatLogEntry,
  clearChatLog,
  exportChatLogJson,
  exportChatLogMarkdown,
  fetchSwarmChatLog,
  readChatLog,
  subscribeChatLog,
} from "./chatLog";

type SourceFilter = "all" | "scelo" | "swarm";

export function ChatHistoryOverlay({ onClose }: { onClose: () => void }) {
  const [local, setLocal] = useState<ChatLogEntry[]>(() => readChatLog());
  const [swarm, setSwarm] = useState<ChatLogEntry[]>([]);
  const [swarmState, setSwarmState] = useState<"loading" | "ok" | "unreachable">("loading");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  // Live-follow Scelo's log so a chat happening behind the overlay appears.
  useEffect(() => subscribeChatLog(() => setLocal(readChatLog())), []);

  useEffect(() => {
    const ac = new AbortController();
    fetchSwarmChatLog(ac.signal).then((rows) => {
      if (ac.signal.aborted) return;
      setSwarm(rows);
      // An empty array is ambiguous — the swarm may be up with no chats yet,
      // or down. Probe health so the footer can say which.
      fetch("http://localhost:3010/api/health", { signal: ac.signal })
        .then((r) => setSwarmState(r.ok ? "ok" : "unreachable"))
        .catch(() => setSwarmState("unreachable"));
    });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = useMemo(() => [...local, ...swarm], [local, swarm]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((e) => {
      if (source !== "all" && e.source !== source) return false;
      if (!q) return true;
      return (
        e.content.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q) ||
        (e.project ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, query, source]);

  // Grouped into conversations, most recently active first.
  const threads = useMemo(() => {
    const map = new Map<string, ChatLogEntry[]>();
    for (const e of filtered) {
      const list = map.get(e.thread) ?? [];
      list.push(e);
      map.set(e.thread, list);
    }
    return [...map.entries()]
      .map(([thread, turns]) => ({
        thread,
        turns: [...turns].sort((a, b) => a.ts - b.ts),
        last: Math.max(...turns.map((t) => t.ts)),
      }))
      .sort((a, b) => b.last - a.last);
  }, [filtered]);

  const download = (kind: "md" | "json") => {
    const body = kind === "md" ? exportChatLogMarkdown(filtered) : exportChatLogJson(filtered);
    const blob = new Blob([body], {
      type: kind === "md" ? "text/markdown" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scelo-chat-history.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-bg/95 backdrop-blur-md">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <div className="mr-auto">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
            chat history
          </div>
          <h2 className="text-sm text-fg">
            {filtered.length.toLocaleString()} turn{filtered.length === 1 ? "" : "s"}
            <span className="text-fg-mute">
              {" "}
              · {threads.length} conversation{threads.length === 1 ? "" : "s"}
            </span>
          </h2>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search transcripts…"
          className="w-56 rounded border border-border bg-bg-1 px-2 py-1 text-xs text-fg placeholder:text-fg-dim focus:border-primary focus:outline-none"
        />

        <div className="flex items-center gap-1">
          {(["all", "scelo", "swarm"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSource(s)}
              className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                source === s
                  ? "border-primary text-primary"
                  : "border-border text-fg-mute hover:text-fg"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => download("md")}
          disabled={filtered.length === 0}
          className="rounded border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute transition hover:border-primary hover:text-fg disabled:opacity-40"
        >
          export .md
        </button>
        <button
          type="button"
          onClick={() => download("json")}
          disabled={filtered.length === 0}
          className="rounded border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute transition hover:border-primary hover:text-fg disabled:opacity-40"
        >
          export .json
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="rounded border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute transition hover:border-error hover:text-error"
        >
          ✕ close
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {threads.length === 0 ? (
          <p className="mt-10 text-center text-[12px] text-fg-dim">
            {all.length === 0
              ? "No chat turns recorded yet. Ask any of the chatbots something and it will appear here."
              : "No turns match that search."}
          </p>
        ) : (
          <ul className="mx-auto flex max-w-4xl flex-col gap-4">
            {threads.map((t) => {
              const isCollapsed = collapsed.has(t.thread);
              const head = t.turns[0];
              return (
                <li key={t.thread} className="rounded-lg border border-border bg-bg-1">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(t.thread)) next.delete(t.thread);
                        else next.add(t.thread);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                  >
                    <span
                      aria-hidden
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        head.source === "swarm" ? "bg-accent-3" : "bg-primary"
                      }`}
                    />
                    <span className="truncate font-mono text-[11px] text-fg">{head.label}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-dim">
                      {t.turns.length} turn{t.turns.length === 1 ? "" : "s"} ·{" "}
                      {new Date(t.last).toLocaleString()} {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <ul className="flex flex-col gap-2 border-t border-border px-3 py-2">
                      {t.turns.map((turn) => (
                        <li key={turn.id} className="flex flex-col gap-0.5">
                          <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                            {turn.role === "user"
                              ? "you"
                              : turn.source === "swarm"
                                ? "swarm"
                                : "scelo"}
                            {" · "}
                            {new Date(turn.ts).toLocaleTimeString()}
                            {turn.model ? ` · ${turn.model}` : ""}
                            {turn.project ? ` · ${turn.project}` : ""}
                          </span>
                          <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-fg">
                            {turn.content}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2 font-mono text-[10px] text-fg-dim">
        <span>
          scelo: {local.length.toLocaleString()} turn{local.length === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>
          swarm:{" "}
          {swarmState === "loading"
            ? "checking…"
            : swarmState === "unreachable"
              ? "server unreachable (:3010) — its history is not included"
              : `${swarm.length.toLocaleString()} turn${swarm.length === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {confirmClear ? (
            <>
              <span className="text-warn">Clear Scelo's recorded history?</span>
              <button
                type="button"
                onClick={() => {
                  clearChatLog();
                  setLocal([]);
                  setConfirmClear(false);
                }}
                className="rounded border border-error px-2 py-0.5 uppercase tracking-wider text-error"
              >
                clear
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="rounded border border-border px-2 py-0.5 uppercase tracking-wider hover:text-fg"
              >
                keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              // Only Scelo's side is clearable from here: the swarm's rows
              // live in its SQLite DB on another process and deleting them
              // over HTTP is not something a viewer should be able to do.
              title="Clears Scelo's local record only — the swarm's server-side log is untouched."
              className="rounded border border-border px-2 py-0.5 uppercase tracking-wider hover:border-error hover:text-error"
            >
              clear local history
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** Small header affordance that opens the overlay. Lives in the stage chat
 *  panels so the history is reachable from wherever the user is chatting. */
export function ChatHistoryButton() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(true)}
        title="Chat history — every bot's turns, searchable and exportable"
        className="font-mono text-[9px] uppercase tracking-wider text-fg-mute transition hover:text-fg"
      >
        history
      </button>
      {open && <ChatHistoryOverlay onClose={() => setOpen(false)} />}
    </>
  );
}
