// In-workspace AI side panel. A slim chat that lives to the right of
// the editor and reuses the same useChatStream / conversationStore
// infrastructure as /chat — each workspace gets its own persisted
// conversation, scoped by a stable id derived from the path.
//
// The panel deliberately does NOT reuse <ChatInput>: that component
// owns its own draft + attachments + slash-command UI, and we need a
// controlled input so external sources (Cmd-L "send selection",
// future templated commands) can pre-fill the box.
//
// What this panel does:
//   * Renders the same message components as /chat for consistency
//   * Owns the input draft so aiPanelBus prompts can populate it
//   * Surfaces an "Apply to file" button under any fenced code block
//     whose language matches the active editor file (P28-3)

import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantMessage } from "../Message/AssistantMessage";
import { UserMessage } from "../Message/UserMessage";
import { subscribeAiPrompt } from "../../lib/aiPanelBus";
import { applyToEditor } from "../../lib/applyToEditorBus";
import { useChatStream } from "../../lib/chatStream";
import { useDraft } from "../../lib/inputDrafts";
import { conversationStore } from "../../lib/conversations";
import { getEditorSelection } from "../../lib/editorSelectionBus";
import { languageFor } from "../../lib/languageFor";

interface Props {
  workspacePath: string | null;
  activePath: string | null;
  activeBuffer: string;
}

const CONTEXT_HEAD_LINES = 40;

export default function AIPanel({ workspacePath, activePath, activeBuffer }: Props) {
  const conversationId = useMemo(
    () => `ws:${workspaceIdFor(workspacePath)}`,
    [workspacePath],
  );
  // Make sure the conversation exists in the store before useChatStream
  // tries to load it; gives us a chance to set a sensible title.
  useEffect(() => {
    const existing = conversationStore.get(conversationId);
    if (!existing) {
      const leaf = workspacePath
        ? workspacePath.split(/[\\/]/).filter(Boolean).slice(-1)[0]
        : "(no workspace)";
      conversationStore.upsert({
        id: conversationId,
        title: `Workspace: ${leaf}`,
        messages: [],
      });
    }
  }, [conversationId, workspacePath]);

  const { messages, isStreaming, activeAssistantId, send, stop, regenerate, edit } =
    useChatStream(conversationId);

  // Per-workspace draft persistence : keyed by the same conversation
  // id so each workspace remembers its own in-flight prompt and a
  // toggle of the AI panel doesn't lose what the user was typing.
  const [draft, setDraft] = useDraft(`ai-panel.${conversationId}`);
  const [attachContext, setAttachContext] = useState<boolean>(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // External prompts (Cmd-L send selection, future templated cmds).
  useEffect(
    () =>
      subscribeAiPrompt((p) => {
        if (p.autoSend) {
          void send(p.text, []);
          setDraft("");
        } else {
          setDraft((prev) => (prev ? `${prev}\n\n${p.text}` : p.text));
          requestAnimationFrame(() => taRef.current?.focus());
        }
      }),
    [send],
  );

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isStreaming]);

  const activeLang = languageFor(activePath);

  const onSubmit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    const composed = attachContext ? prependContext(text, activePath, activeBuffer) : text;
    void send(composed, []);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          ai · workspace
        </span>
        <div className="flex items-baseline gap-2 truncate">
          <label
            className="flex items-center gap-1 text-[10px] text-fg-mute hover:text-fg"
            title={
              attachContext
                ? "Sending file context (selection, or first 40 lines) with every message."
                : "Sending bare messages. The LLM won't see the file unless you paste it."
            }
          >
            <input
              type="checkbox"
              checked={attachContext}
              onChange={(e) => setAttachContext(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            attach context
          </label>
          <span
            className="truncate font-mono text-[10px] text-fg-mute"
            title={activePath ?? "no active file"}
          >
            {activePath ? activePath.split("/").pop() : "—"}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <p className="text-[11px] text-fg-mute">
            Ask about the active file, paste a selection (Cmd-L), or just
            chat. Conversations are scoped to this workspace.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, idx) =>
              m.role === "user" ? (
                <UserMessage
                  key={m.id}
                  message={m}
                  onEdit={(text) => {
                    void edit(m.id, text);
                  }}
                />
              ) : (
                <div key={m.id}>
                  <AssistantMessage
                    message={m}
                    isStreaming={isStreaming && m.id === activeAssistantId}
                    onRegenerate={
                      idx === messages.length - 1
                        ? () => {
                            void regenerate();
                          }
                        : undefined
                    }
                  />
                  <ApplyAffordance
                    message={m}
                    activeLang={activeLang}
                    activePath={activePath}
                  />
                </div>
              ),
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-bg-1 p-2">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={3}
          placeholder="Ask Scelo (Enter to send, Shift-Enter for newline)"
          className="w-full resize-y rounded border border-border bg-bg p-2 text-xs text-fg focus:border-primary focus:outline-none"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-fg-mute">
          <span>
            {isStreaming ? (
              <button
                type="button"
                onClick={stop}
                className="ia-btn ia-btn-sm ia-btn-danger"
              >
                stop
              </button>
            ) : (
              <span>conversation: workspace-scoped, persisted locally</span>
            )}
          </span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!draft.trim() || isStreaming}
            className="ia-btn ia-btn-sm ia-btn-primary"
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}

function ApplyAffordance({
  message,
  activeLang,
  activePath,
}: {
  message: { parts?: Array<{ kind: string; text?: string }> };
  activeLang: string | undefined;
  activePath: string | null;
}) {
  // One button per matching fenced block, with a short preview for
  // disambiguation. The LLM often emits a "wrong" first attempt then
  // a corrected second — picking the right one is the user's call.
  const blocks = useMemo(
    () => matchingCodeBlocks(message, activeLang),
    [message, activeLang],
  );
  if (blocks.length === 0 || !activePath) return null;
  return (
    <div className="mt-1 flex flex-col items-end gap-1 text-[10px]">
      {blocks.map((block, i) => (
        <button
          key={i}
          type="button"
          onClick={() => applyToEditor({ targetPath: activePath, text: block.body })}
          className="ia-btn ia-btn-sm ia-btn-secondary max-w-full justify-start text-left"
          title={`Replace selection (or insert at caret) in ${activePath}\n\n${block.body.slice(0, 240)}${block.body.length > 240 ? "…" : ""}`}
        >
          <span className="text-fg-mute">apply</span>{" "}
          <span>block {i + 1}/{blocks.length}</span>
          <span className="text-fg-dim">·</span>
          <span className="text-fg-mute">{block.lines}L</span>
          <span className="text-fg-dim">·</span>
          <span className="truncate font-mono">{block.preview}</span>
        </button>
      ))}
    </div>
  );
}

interface CodeBlock {
  body: string;
  lines: number;
  /** First non-blank line, truncated, for the button caption. */
  preview: string;
}

function matchingCodeBlocks(
  message: { parts?: Array<{ kind: string; text?: string }> },
  lang: string | undefined,
): CodeBlock[] {
  if (!lang) return [];
  const text = (message.parts ?? [])
    .filter((p) => p.kind === "message" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
  if (!text) return [];
  const re = /```([\w+-]*)\n([\s\S]*?)```/g;
  const out: CodeBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const blockLang = (m[1] || "").toLowerCase();
    if (!matchesLang(blockLang, lang)) continue;
    const body = m[2];
    const allLines = body.split("\n");
    const firstNonBlank = allLines.find((l) => l.trim().length > 0) ?? "";
    out.push({
      body,
      lines: allLines.length,
      preview:
        firstNonBlank.length > 48
          ? `${firstNonBlank.slice(0, 47)}…`
          : firstNonBlank,
    });
  }
  return out;
}

function matchesLang(blockLang: string, activeLang: string): boolean {
  if (!blockLang) return false;
  if (blockLang === activeLang) return true;
  // Common LLM aliases.
  const aliases: Record<string, string[]> = {
    python: ["py", "python3"],
    r: ["rscript"],
    typescript: ["ts"],
    javascript: ["js"],
    shell: ["bash", "sh", "zsh"],
  };
  return (aliases[activeLang] ?? []).includes(blockLang);
}

/** Compose the user message: if the active editor has a selection, ship
 *  it verbatim; otherwise ship the first N lines of the buffer so the
 *  LLM has *something* to anchor against. Marked with a header line
 *  the user can see — never invisible. Returns the raw text unchanged
 *  when there's no file open. */
function prependContext(
  text: string,
  activePath: string | null,
  activeBuffer: string,
): string {
  if (!activePath) return text;
  const lang = languageFor(activePath) ?? "";
  const sel = getEditorSelection();
  let snippet: string;
  let kind: string;
  if (sel && sel.text.trim() && sel.path === activePath) {
    snippet = sel.text;
    kind = "selection";
  } else if (activeBuffer.trim()) {
    const lines = activeBuffer.split("\n");
    snippet =
      lines.length <= CONTEXT_HEAD_LINES
        ? activeBuffer
        : `${lines.slice(0, CONTEXT_HEAD_LINES).join("\n")}\n// ...truncated at line ${CONTEXT_HEAD_LINES}, file is ${lines.length} lines.`;
    kind = `first ${Math.min(lines.length, CONTEXT_HEAD_LINES)} lines`;
  } else {
    return text;
  }
  return [
    `**Workspace context** (${activePath}, ${kind}):`,
    "",
    "```" + lang,
    snippet,
    "```",
    "",
    text,
  ].join("\n");
}

/** Workspace-scoped conversation id — sha1 of the path, first 12 hex.
 *  Mirrors main.ts `_wsIdFor` but stays in the renderer (Web Crypto). */
function workspaceIdFor(path: string | null): string {
  if (!path) return "none";
  // Synchronous fallback : a tiny djb2 hash so the id is stable across
  // mounts without an async crypto roundtrip on every render. We don't
  // need cryptographic strength — just collision-resistance vs. other
  // workspaces on the same install.
  let h = 5381;
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h) ^ path.charCodeAt(i);
    h |= 0;
  }
  // 32-bit hash → 8-hex; pad path length too so two workspaces with the
  // same hash but different lengths still differ.
  return `${(h >>> 0).toString(16).padStart(8, "0")}-${path.length.toString(16)}`;
}
