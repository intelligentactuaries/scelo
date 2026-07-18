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
import { ChatInputPill } from "./ChatInputPill";
import { ResizablePanel } from "./ResizablePanel";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import type { Dataset } from "./SoftDataWorkstation";
import { useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

export function StageChatPanel({
  stageContext,
  placeholder,
  chatId,
  title,
  badge,
  dataset = null,
  onLocalCommand,
  onAssistantFinal,
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
  onLocalCommand?: (text: string) => string | null;
  /** Post-process a completed assistant reply (see useNodeChat). */
  onAssistantFinal?: (text: string) => string | undefined;
}) {
  const { chatMemoryPrefix } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:${chatId}` : undefined;
  const { messages, isStreaming, send, sendLocal, stop } = useNodeChat(stageContext, {
    memoryKey,
    onAssistantFinal,
  });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    // Deterministic intents (e.g. "clean my data") are answered locally and
    // never hit the orchestrator — so they work offline and respond instantly.
    const localReply = onLocalCommand?.(text);
    if (localReply != null) {
      sendLocal(text, localReply);
      return;
    }
    void send(text);
  };

  return (
    <ResizablePanel side="right" defaultWidth={384} minWidth={280} badge={badge}>
      <header className="shrink-0 border-b border-border px-4 py-3 pl-8">
        <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-2">
          <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
          <span>{badge}</span>
          {isStreaming && (
            <span
              aria-hidden
              className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-2"
              title="streaming"
            />
          )}
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
      </div>

      <div className="shrink-0 border-t border-border bg-bg-1 px-3 py-2">
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
