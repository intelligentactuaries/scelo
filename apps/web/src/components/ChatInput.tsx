// Bottom-of-thread input bar. Auto-resizing textarea, Enter to send,
// Shift+Enter for newline, attachment pills shown above the textarea
// when files have been classified, send/stop button driven by the
// parent's `isStreaming` state.

import { FilePill } from "@/components/Message/FilePill";
import type { AttachedFile } from "@/lib/conversations";
import { useDraft } from "@/lib/inputDrafts";
import { type SlashCommand, suggest } from "@/lib/slashCommands";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onSend: (text: string, attachments: AttachedFile[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  // Called when the user picks a file. The parent uploads + classifies
  // and is responsible for adding the result to `pendingAttachments`.
  onPickFile?: (file: File) => void;
  pendingAttachments?: AttachedFile[];
  onRemoveAttachment?: (index: number) => void;
  isClassifying?: boolean;
  placeholder?: string;
  /** When set, the draft text persists under
   *  `ia.draft.chat-input.<draftKey>` so navigating away doesn't
   *  cost a half-typed prompt. Omit to keep the legacy in-memory
   *  behaviour (eg one-shot demos). */
  draftKey?: string;
};

const MAX_ROWS = 10;
const ROW_PX = 22;

export function ChatInput({
  onSend,
  onStop,
  isStreaming = false,
  onPickFile,
  pendingAttachments = [],
  onRemoveAttachment,
  isClassifying = false,
  placeholder,
  draftKey,
}: Props) {
  // Branch the input state : persisted via useDraft when caller
  // passes a draftKey, plain useState otherwise. Hooks must be
  // called unconditionally so we wire both and pick at the binding
  // step. Cost is one extra useState; trivial.
  const [persistedDraft, setPersistedDraft] = useDraft(
    `chat-input.${draftKey ?? "anon"}`,
  );
  const [transientDraft, setTransientDraft] = useState("");
  const draft = draftKey ? persistedDraft : transientDraft;
  const setDraft = draftKey ? setPersistedDraft : setTransientDraft;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const suggestions: SlashCommand[] = useMemo(() => suggest(draft), [draft]);
  const showSuggestions = suggestions.length > 0 && draft.startsWith("/") && !draft.includes("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft` is the explicit reactive trigger; the textarea ref is stable.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = MAX_ROWS * ROW_PX;
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const submit = () => {
    const text = draft.trim();
    if (isStreaming) return;
    if (!text && pendingAttachments.length === 0) return;
    onSend(text, pendingAttachments);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const acceptSuggestion = (cmd: SlashCommand) => {
    setDraft(`${cmd.name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  return (
    <div className="border-t border-border bg-bg-1 px-4 py-3">
      <div className="mx-auto max-w-[720px] space-y-2">
        {showSuggestions && (
          <ul className="overflow-hidden rounded border border-border bg-bg-2 font-mono text-xs">
            {suggestions.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => acceptSuggestion(c)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-bg-1"
                >
                  <span className="text-primary">{c.name}</span>
                  <span className="text-fg-dim">{c.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {(pendingAttachments.length > 0 || isClassifying) && (
          <div className="flex flex-wrap items-center gap-2">
            {pendingAttachments.map((f, i) => (
              <FilePill
                key={f.saved_path}
                file={f}
                onRemove={onRemoveAttachment ? () => onRemoveAttachment(i) : undefined}
              />
            ))}
            {isClassifying && (
              <span className="font-mono text-fg-dim text-xs italic">classifying…</span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded border border-border bg-bg-2 p-2 focus-within:border-primary">
          <button
            type="button"
            aria-label="Attach file"
            disabled={!onPickFile}
            onClick={() => fileRef.current?.click()}
            className="px-2 py-1 text-fg-mute text-xl hover:text-primary disabled:opacity-30"
            title={onPickFile ? "Attach file" : "Attachments not enabled in this view"}
          >
            ⎙
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f && onPickFile) onPickFile(f);
              e.currentTarget.value = "";
            }}
          />
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              placeholder ?? "message the orchestrator… (Enter to send, Shift+Enter for newline)"
            }
            rows={1}
            className="flex-1 resize-none bg-transparent text-fg text-sm outline-none placeholder:text-fg-dim"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="border border-error bg-error/10 px-3 py-1 font-mono text-error text-xs hover:bg-error/20"
              aria-label="Stop streaming"
            >
              ▪ stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0 && pendingAttachments.length === 0}
              className="border border-primary bg-primary/10 px-3 py-1 font-mono text-primary text-xs hover:bg-primary/20 disabled:opacity-30"
            >
              send
            </button>
          )}
        </div>
        <div className="flex items-center justify-between font-mono text-fg-dim text-[10px]">
          <span>Enter sends · Shift+Enter newline</span>
          <span>{draft.length > 0 ? `${draft.length} chars` : ""}</span>
        </div>
      </div>
    </div>
  );
}
