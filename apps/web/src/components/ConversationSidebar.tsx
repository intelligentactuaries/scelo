// Left sidebar for the chat layout. Mirrors the layout standard set by leading
// chat UIs (Claude, ChatGPT, Gemini, Grok, DeepSeek):
//
// - Brand + collapse toggle
// - "New chat" + search (⌘K)
// - Quick-nav row (Dashboards / Agents / Wiki / Regulatory)
// - Pinned conversations
// - Recent conversations grouped by date (Today / Yesterday / 7d / 30d / Older)
// - Per-row hover actions: pin, inline rename, export, delete
// - Footer with user identity + settings popover + keyboard hint
//
// All persistence still goes through the conversationStore; pinning uses a
// non-breaking optional `pinned` flag added to the Conversation type.

import { conversationStore } from "@/lib/conversations";
import type { Conversation } from "@/lib/conversations";
import { type ThemeChoice, useTheme } from "@/lib/theme";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

type Props = {
  version?: number;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

const QUICK_LINKS: { label: string; to: string; icon: JSX.Element; hint: string }[] = [
  {
    label: "Dashboards",
    to: "/dashboards",
    hint: "Specialist dashboards",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <rect x="2" y="2" width="5" height="5" />
        <rect x="9" y="2" width="5" height="5" />
        <rect x="2" y="9" width="5" height="5" />
        <rect x="9" y="9" width="5" height="5" />
      </svg>
    ),
  },
  {
    label: "Agents",
    to: "/dashboards/agents",
    hint: "9 specialist agents",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <circle cx="8" cy="6" r="2.5" />
        <path d="M2.5 14c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5" />
      </svg>
    ),
  },
  {
    label: "Wiki",
    to: "/dashboards/wiki",
    hint: "Internal knowledge base",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <path d="M3 2.5h7L13 5.5V13.5H3z" />
        <path d="M10 2.5V5.5h3" />
        <path d="M5 8h6M5 10.5h6" />
      </svg>
    ),
  },
  {
    label: "Regulatory",
    to: "/dashboards/regulatory",
    hint: "FSCA · IFRS 17 · SAM",
    icon: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z" />
        <path d="M5.5 8l1.8 1.8L11 6" />
      </svg>
    ),
  },
];

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

function lastMessagePreview(c: Conversation): string {
  const last = c.messages[c.messages.length - 1];
  if (!last) return "no messages yet";
  const s = last.content.replace(/\s+/g, " ").trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

type Bucket = "today" | "yesterday" | "week" | "month" | "older";

function bucketize(c: Conversation): Bucket {
  const t = Date.parse(c.updated_at);
  if (Number.isNaN(t)) return "older";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - dayMs) return "yesterday";
  if (t >= startOfToday - 7 * dayMs) return "week";
  if (t >= startOfToday - 30 * dayMs) return "month";
  return "older";
}

const BUCKET_LABELS: Record<Bucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  month: "Previous 30 days",
  older: "Older",
};

export function ConversationSidebar({ version = 0, collapsed = false, onToggleCollapsed }: Props) {
  const { conversationId = "" } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();

  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the explicit reactive signal from the parent — we re-read storage when it bumps.
  useEffect(() => {
    setTick((t) => t + 1);
  }, [version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` exists solely to invalidate this memo when storage mutates.
  const all = useMemo(() => conversationStore.list(), [tick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [all, query]);

  const pinned = useMemo(() => filtered.filter((c) => c.pinned), [filtered]);
  const grouped = useMemo(() => {
    const groups: Record<Bucket, Conversation[]> = {
      today: [],
      yesterday: [],
      week: [],
      month: [],
      older: [],
    };
    for (const c of filtered) {
      if (c.pinned) continue;
      groups[bucketize(c)].push(c);
    }
    return groups;
  }, [filtered]);

  const onNewChat = useCallback(() => {
    const conv = conversationStore.create();
    navigate(`/c/${conv.id}`);
  }, [navigate]);

  const onDelete = (id: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    conversationStore.delete(id);
    setTick((t) => t + 1);
    if (id === conversationId) navigate("/");
  };

  const onTogglePin = (c: Conversation) => {
    conversationStore.setPinned(c.id, !c.pinned);
    setTick((t) => t + 1);
  };

  const onStartRename = (c: Conversation) => {
    setRenamingId(c.id);
    setRenameDraft(c.title);
  };

  const onCommitRename = () => {
    if (renamingId && renameDraft.trim()) {
      conversationStore.rename(renamingId, renameDraft.trim());
    }
    setRenamingId(null);
    setRenameDraft("");
    setTick((t) => t + 1);
  };

  const onExport = (id: string) => {
    const blob = conversationStore.export(id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Keyboard shortcuts: ⌘/Ctrl+N new chat, ⌘/Ctrl+K focus search.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        onNewChat();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNewChat]);

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-bg-1 py-3">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={onToggleCollapsed}
          className="text-fg-mute hover:text-fg"
          title="Expand sidebar"
        >
          ›
        </button>
        <button
          type="button"
          aria-label="New chat"
          onClick={onNewChat}
          className="mt-3 border border-primary px-2 py-1 font-mono text-primary text-xs hover:bg-primary/20"
          title="New chat (⌘N)"
        >
          +
        </button>
        <div className="mt-3 flex flex-col items-center gap-2 border-t border-border pt-3 text-fg-mute">
          {QUICK_LINKS.map((q) => (
            <Link
              key={q.label}
              to={q.to}
              title={q.label}
              aria-label={q.label}
              className="flex h-7 w-7 items-center justify-center hover:text-fg"
            >
              {q.icon}
            </Link>
          ))}
        </div>
        <ul className="mt-3 flex flex-col gap-1 overflow-y-auto border-t border-border pt-3 text-fg-dim">
          {all.slice(0, 16).map((c) => (
            <li key={c.id}>
              <Link
                to={`/c/${c.id}`}
                title={c.title}
                className={`block px-1 text-base hover:text-fg ${
                  c.id === conversationId ? "text-primary" : ""
                }`}
              >
                {c.pinned ? "★" : "▮"}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border bg-bg-1">
      {/* Brand + collapse */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo_math.JPG" alt="(Iα)ai" className="h-5 w-5" />
          <span className="font-mono text-xs">
            <span className="text-primary">(Iα)</span>
            <span className="text-fg-mute">ₐᵢ</span>
          </span>
        </Link>
        {onToggleCollapsed && (
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={onToggleCollapsed}
            className="text-fg-mute hover:text-fg"
            title="Collapse sidebar"
          >
            ‹
          </button>
        )}
      </div>

      {/* New chat */}
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center justify-between border border-primary bg-primary/10 px-3 py-2 font-mono text-primary text-xs hover:bg-primary/20"
          title="New chat (⌘N)"
        >
          <span className="flex items-center gap-2">
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <path d="M6 1.5v9M1.5 6h9" strokeLinecap="round" />
            </svg>
            New chat
          </span>
          <kbd className="font-mono text-[10px] text-primary/70">⌘N</kbd>
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-2">
        <label className="relative block">
          <span className="sr-only">Search chats</span>
          <svg
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            <circle cx="5" cy="5" r="3.5" />
            <path d="M7.7 7.7L10.5 10.5" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full border border-border bg-bg-2 py-1.5 pl-7 pr-12 font-mono text-fg text-xs placeholder:text-fg-dim focus:border-primary focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-fg-dim">
            ⌘K
          </kbd>
        </label>
      </div>

      {/* Quick nav */}
      <div className="grid grid-cols-4 gap-1 border-b border-border px-3 py-3">
        {QUICK_LINKS.map((q) => (
          <Link
            key={q.label}
            to={q.to}
            title={`${q.label} — ${q.hint}`}
            className="group flex flex-col items-center gap-1 border border-border bg-bg-2 px-1 py-1.5 text-fg-mute hover:border-primary/50 hover:text-primary"
          >
            <span>{q.icon}</span>
            <span className="font-mono text-[9px] uppercase tracking-wide">{q.label}</span>
          </Link>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-3 text-fg-dim text-xs">
            {query ? (
              <>
                No matches for <span className="font-mono text-fg-mute">"{query}"</span>.
              </>
            ) : (
              <>
                No conversations yet. Start one with the{" "}
                <span className="text-primary">+ new chat</span> button or press{" "}
                <kbd className="font-mono">⌘N</kbd>.
              </>
            )}
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label="Pinned" icon="★">
                {pinned.map((c) => (
                  <ConversationRow
                    key={c.id}
                    c={c}
                    active={c.id === conversationId}
                    renaming={renamingId === c.id}
                    renameDraft={renameDraft}
                    onRenameDraft={setRenameDraft}
                    onStartRename={() => onStartRename(c)}
                    onCommitRename={onCommitRename}
                    onCancelRename={() => setRenamingId(null)}
                    onTogglePin={() => onTogglePin(c)}
                    onExport={() => onExport(c.id)}
                    onDelete={() => onDelete(c.id)}
                  />
                ))}
              </Section>
            )}

            {(["today", "yesterday", "week", "month", "older"] as Bucket[]).map((b) =>
              grouped[b].length > 0 ? (
                <Section key={b} label={BUCKET_LABELS[b]}>
                  {grouped[b].map((c) => (
                    <ConversationRow
                      key={c.id}
                      c={c}
                      active={c.id === conversationId}
                      renaming={renamingId === c.id}
                      renameDraft={renameDraft}
                      onRenameDraft={setRenameDraft}
                      onStartRename={() => onStartRename(c)}
                      onCommitRename={onCommitRename}
                      onCancelRename={() => setRenamingId(null)}
                      onTogglePin={() => onTogglePin(c)}
                      onExport={() => onExport(c.id)}
                      onDelete={() => onDelete(c.id)}
                    />
                  ))}
                </Section>
              ) : null,
            )}
          </>
        )}
      </div>

      {/* Footer — user identity + settings + version */}
      <div className="relative border-t border-border">
        {settingsOpen && (
          <div className="absolute bottom-full left-3 right-3 mb-2 border border-border bg-bg-2 font-mono text-xs shadow-lg">
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-fg-dim">
              Theme
            </div>
            <div className="grid grid-cols-3 gap-1 px-2 pb-2">
              {(["system", "light", "dark"] as ThemeChoice[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setThemeChoice(t)}
                  className={`border px-2 py-1.5 text-center capitalize ${
                    themeChoice === t
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-fg-mute hover:border-primary/40 hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="border-t border-border" />
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-fg-mute hover:bg-bg hover:text-fg"
              onClick={() => {
                setSettingsOpen(false);
                navigate("/dashboards");
              }}
            >
              Dashboards
            </button>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-fg-mute hover:bg-bg hover:text-fg"
              onClick={() => {
                setSettingsOpen(false);
                navigate("/dashboards/runs");
              }}
            >
              Runs
            </button>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-fg-mute hover:bg-bg hover:text-fg"
              onClick={() => setSettingsOpen(false)}
              title="Settings panel coming soon"
            >
              Settings…
            </button>
            <a
              href="https://github.com/intelligentactuaries"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-fg-mute hover:bg-bg hover:text-fg"
              onClick={() => setSettingsOpen(false)}
            >
              GitHub ↗
            </a>
            <button
              type="button"
              className="block w-full border-t border-border px-3 py-2 text-left text-fg-dim hover:bg-bg hover:text-fg"
              onClick={() => {
                if (confirm("Clear all conversations from this browser?")) {
                  for (const c of all) conversationStore.delete(c.id);
                  setTick((t) => t + 1);
                  setSettingsOpen(false);
                  navigate("/");
                }
              }}
            >
              Clear all conversations
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setSettingsOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-2"
          aria-haspopup="menu"
          aria-expanded={settingsOpen}
        >
          <span className="flex h-7 w-7 items-center justify-center border border-border bg-bg-2 font-mono text-[11px] text-primary">
            AD
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-fg text-xs">Ali Denewade</span>
            <span className="block truncate font-mono text-[10px] text-fg-dim">Local · alpha</span>
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
            className="text-fg-dim"
          >
            <circle cx="6" cy="6" r="1" />
            <circle cx="6" cy="2" r="1" />
            <circle cx="6" cy="10" r="1" />
          </svg>
        </button>
        <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-fg-dim">
          v0.5.0-alpha · localStorage
        </div>
      </div>
    </aside>
  );
}

function Section({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 font-mono text-[10px] uppercase tracking-widest text-fg-dim">
        {icon && <span className="text-primary">{icon}</span>}
        <span>{label}</span>
      </div>
      <ul>{children}</ul>
    </div>
  );
}

type RowProps = {
  c: Conversation;
  active: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (s: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  onExport: () => void;
  onDelete: () => void;
};

function ConversationRow({
  c,
  active,
  renaming,
  renameDraft,
  onRenameDraft,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onExport,
  onDelete,
}: RowProps) {
  const navigate = useNavigate();
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancelRename();
    }
  };
  return (
    <li>
      <div
        className={`group flex items-start gap-1 px-3 py-1.5 hover:bg-bg-2 ${
          active ? "bg-bg-2" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => !renaming && navigate(`/c/${c.id}`)}
          onDoubleClick={onStartRename}
          className="min-w-0 flex-1 text-left"
          title={c.title}
        >
          {renaming ? (
            <input
              autoFocus
              type="text"
              value={renameDraft}
              onChange={(e) => onRenameDraft(e.target.value)}
              onKeyDown={onKey}
              onBlur={onCommitRename}
              className="w-full border border-primary bg-bg px-1 py-0.5 font-mono text-fg text-xs focus:outline-none"
            />
          ) : (
            <>
              <div className={`truncate text-sm ${active ? "text-primary" : "text-fg"}`}>
                {c.pinned && <span className="mr-1 text-primary">★</span>}
                {c.title || "New conversation"}
              </div>
              <div className="truncate text-fg-dim text-[11px]">{lastMessagePreview(c)}</div>
              <div className="mt-0.5 font-mono text-[9px] text-fg-dim">
                {relativeTime(c.updated_at)}
                {c.branched_from ? " · branched" : ""}
              </div>
            </>
          )}
        </button>
        {!renaming && (
          <div className="flex shrink-0 flex-col items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              aria-label={c.pinned ? "Unpin" : "Pin"}
              title={c.pinned ? "Unpin" : "Pin"}
              onClick={onTogglePin}
              className="text-fg-dim hover:text-primary"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill={c.pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden
              >
                <path d="M6 1.5l1.4 3 3.1.4-2.3 2.1.7 3-2.9-1.6-2.9 1.6.7-3-2.3-2.1 3.1-.4z" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Rename"
              title="Rename"
              onClick={onStartRename}
              className="text-fg-dim hover:text-fg"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden
              >
                <path d="M8.5 1.5l2 2-6 6H2.5v-2z" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Export JSON"
              title="Export JSON"
              onClick={onExport}
              className="text-fg-dim hover:text-fg"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden
              >
                <path d="M6 1.5v7M3 5.5L6 8.5l3-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 10.5h8" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Delete"
              title="Delete"
              onClick={onDelete}
              className="text-fg-dim hover:text-error"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                aria-hidden
              >
                <path
                  d="M2.5 3.5h7M5 3v-1h2v1M3.5 3.5l.5 7h4l.5-7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
