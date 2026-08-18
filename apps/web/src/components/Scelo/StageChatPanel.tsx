// Persistent right-side chat panel for the three workstations. Replaces
// the previous "collapsed bottom strip + expand-to-modal" pattern with a
// permanent column on the far right of the screen, sized slightly wider
// than the other right-side asides so the chat reads as the headline
// affordance rather than an afterthought.
//
// Each workstation passes its own `chatId` (the suffix appended to the
// project memory key) and stage context, so the per-stage conversations
// stay independent — the user can have one thread about cleaning their
// dataset open in /soft and another about model selection open in
// /tools without them bleeding into each other.

import { useEffect, useRef, useState } from "react";
import { ChatHistoryButton } from "./ChatHistoryOverlay";
import { ChatInputPill } from "./ChatInputPill";
import { ResizablePanel } from "./ResizablePanel";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import type { Dataset } from "./SoftDataWorkstation";
import { nextPaint } from "./UploadIndicator";
import { CHAT_DRAFT_EVENT } from "./actuarialTableUi";
import { useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

export type ChatAction = {
  /** Stable key — also the React key and the busy-state discriminator. */
  id: string;
  /** Chip label. Keep it to two or three words. */
  label: string;
  /** Tooltip / `title` text. Say what it will do, including anything destructive. */
  hint?: string;
  /** Text recorded as the user turn when pressed. */
  prompt: string;
  /** Resolved string becomes the assistant reply. May be async. */
  run: () => string | Promise<string>;
  /** Non-null disables the chip and becomes its tooltip. */
  disabledReason?: string | null;
};

export function StageChatPanel({
  stageContext,
  placeholder,
  chatId,
  title,
  badge,
  dataset = null,
  onLocalCommand,
  onAssistantFinal,
  actions,
}: {
  stageContext: string;
  placeholder: string;
  /** Stable identifier for the conversation thread (e.g. "soft-stage"). */
  chatId: string;
  /** Header title — short, one line. */
  title: string;
  /** Stage-accent badge text (e.g. "SOFT · CHAT"). */
  badge: string;
  /** Used by chat-embedded `viz` blocks to read column metas. */
  dataset?: Dataset | null;
  /**
   * Optional deterministic intent handler, run before a message is sent to
   * the orchestrator. Return an assistant reply string to handle the message
   * locally (no backend round-trip); return null to fall through to the
   * normal streamed chat. Used so requests like "clean my data" work even
   * when the chat backend is unreachable.
   */
  onLocalCommand?: (text: string, assistantHistory?: string[]) => string | null;
  /** Post-process a completed assistant reply (see useNodeChat). */
  onAssistantFinal?: (text: string) => string | undefined;
  /**
   * One-press actions rendered as a row of chips directly above the input.
   * For work that is tedious to ask for in prose and has exactly one sensible
   * execution (e.g. "auto-clean this dataset until it stops changing").
   * Pressing one records `prompt` as the user turn and `run()`'s resolved
   * string as the reply, so the transcript is indistinguishable from having
   * typed the request.
   */
  actions?: ChatAction[];
}) {
  const { chatMemoryPrefix, project } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:${chatId}` : undefined;
  const { messages, isStreaming, send, sendLocal, stop } = useNodeChat(stageContext, {
    memoryKey,
    onAssistantFinal,
    logLabel: `${chatId.replace(/-/g, " · ")}`,
    logProject: project?.name,
  });
  const [draft, setDraft] = useState("");
  const inputHostRef = useRef<HTMLDivElement | null>(null);

  // A suggestion elsewhere on the page ("send prompt to chat" on a table
  // idea) can drop text into THIS panel's input by chatId — the user then
  // edits and sends it like anything they typed. Focus follows so the
  // hand-off is visible.
  useEffect(() => {
    const onSeed = (ev: Event) => {
      const detail = (ev as CustomEvent<{ chatId: string; text: string }>).detail;
      if (!detail || detail.chatId !== chatId) return;
      setDraft(detail.text);
      window.requestAnimationFrame(() => {
        inputHostRef.current?.querySelector("textarea")?.focus();
      });
    };
    window.addEventListener(CHAT_DRAFT_EVENT, onSeed);
    return () => window.removeEventListener(CHAT_DRAFT_EVENT, onSeed);
  }, [chatId]);
  /** id of the action currently running, or null. Actions are serialised:
   *  one at a time, and never while a reply is streaming. */
  const [runningAction, setRunningAction] = useState<string | null>(null);
  /** True while a TYPED local command is executing. Same reason as the
   *  action chips' busy state: the deterministic handlers are synchronous
   *  and CPU-bound (auto-clean, augment, whole-column rewrites), so without
   *  a painted indicator the panel looks dead until they finish. */
  const [runningLocal, setRunningLocal] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message + busy changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, runningLocal]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming || runningLocal) return;
    setDraft("");
    if (!onLocalCommand) {
      void send(text);
      return;
    }
    // Deterministic intents (e.g. "clean my data") are answered locally and
    // never hit the orchestrator — so they work offline. They are NOT
    // instant, though: paint the busy pip first (nextPaint), then run, the
    // same contract the action chips follow.
    setRunningLocal(true);
    void (async () => {
      try {
        await nextPaint();
        const localReply = onLocalCommand(
          text,
          messages.filter((m) => m.role === "assistant").map((m) => m.content),
        );
        if (localReply != null) {
          sendLocal(text, localReply);
        } else {
          void send(text);
        }
      } finally {
        setRunningLocal(false);
      }
    })();
  };

  const runAction = async (action: ChatAction) => {
    if (runningAction || isStreaming || action.disabledReason) return;
    setRunningAction(action.id);
    try {
      // Yield one frame before doing the work: these handlers are synchronous
      // and CPU-bound (a full-dataset clean is several profiling passes), so
      // without this the busy state would never paint and the chip would look
      // dead until the whole run finished.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      sendLocal(action.prompt, await action.run());
    } catch (err) {
      sendLocal(
        action.prompt,
        `That didn't complete — ${err instanceof Error ? err.message : String(err)}.\n\nYour data is unchanged.`,
      );
    } finally {
      setRunningAction(null);
    }
  };

  return (
    <ResizablePanel side="right" defaultWidth={384} minWidth={280} badge={badge}>
      <header className="shrink-0 border-b border-border px-4 py-3 pl-8">
        <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
          <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
          <span>{badge}</span>
          {(isStreaming || runningLocal) && (
            <span
              aria-hidden
              className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-2"
              title={isStreaming ? "streaming" : "working"}
            />
          )}
          {/* Shared by all three stage chats, so the audit view is reachable
              from wherever the user happens to be chatting. */}
          <span className="ml-auto">
            <ChatHistoryButton />
          </span>
        </div>
        <h2 className="mt-1 truncate text-sm text-fg">{title}</h2>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-fg-dim">
            Ask Scelo about this stage — column types, model picks, run results, anything you'd want
            a second pair of eyes on.
            <br />
            <span className="mt-1 inline-block font-mono text-[10px] text-fg-dim/70">
              Enter to send · Shift+Enter for newline
            </span>
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m, idx) => {
              const isUser = m.role === "user";
              const isLast = idx === messages.length - 1;
              // Only the *last* assistant message can be actively streaming —
              // the blinking caret appears there, not on earlier replies.
              const streamingThis = !isUser && isLast && isStreaming;
              return (
                // User turns get a faint accent-2 wash + thin stripe so the
                // eye can separate "me" from "scelo" without reading the
                // label. Scelo's turns stay transparent — keeps the chat
                // feeling like a normal reading column.
                <li
                  key={m.id}
                  className={`-mx-2 flex flex-col gap-1 rounded-lg px-2 py-1.5 ${
                    isUser
                      ? "border-l-2 border-accent-2/40 bg-accent-2/[0.05]"
                      : "border-l-2 border-transparent"
                  }`}
                >
                  <span
                    className={`font-mono text-[9px] uppercase tracking-wider ${
                      isUser ? "text-accent-2" : "text-primary"
                    }`}
                  >
                    {isUser ? "you" : "scelo"}
                  </span>
                  {isUser ? (
                    <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">
                      {m.content}
                    </div>
                  ) : m.content ? (
                    <SceloChatMarkdown streaming={streamingThis} dataset={dataset}>
                      {m.content}
                    </SceloChatMarkdown>
                  ) : streamingThis ? (
                    <span className="text-fg-dim">…</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {runningLocal && (
          <output
            aria-live="polite"
            className="mt-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
          >
            <span
              aria-hidden
              className="ia-pip ia-load-pip"
              style={{ background: "rgb(var(--rgb-primary))" }}
            />
            working…
          </output>
        )}
      </div>

      <div ref={inputHostRef} className="shrink-0 border-t border-border bg-bg-1 px-3 py-2">
        {actions && actions.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {actions.map((action) => {
              const busy = runningAction === action.id;
              const blocked =
                Boolean(action.disabledReason) || isStreaming || runningAction !== null;
              return (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => void runAction(action)}
                  disabled={blocked}
                  title={action.disabledReason ?? action.hint}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute transition hover:border-primary hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-fg-mute"
                >
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      busy ? "animate-pulse bg-primary" : "bg-fg-dim"
                    }`}
                  />
                  {busy ? "working…" : action.label}
                </button>
              );
            })}
          </div>
        )}
        <ChatInputPill
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          isStreaming={isStreaming}
          placeholder={placeholder}
          rows={2}
          size="sm"
        />
      </div>
    </ResizablePanel>
  );
}
