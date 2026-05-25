// User-side message. Edit-on-hover: clicking "edit" replaces the message
// body with a textarea that, on save, drops every message after this one
// and re-runs the orchestrator with the edited text.

import type { ConversationMessage } from "@/lib/conversations";
import { type KeyboardEvent, useState } from "react";
import { FilePill } from "./FilePill";

type Props = {
  message: ConversationMessage;
  onEdit?: (newText: string) => void;
};

export function UserMessage({ message, onEdit }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const cancel = () => {
    setDraft(message.content);
    setEditing(false);
  };
  const save = () => {
    const next = draft.trim();
    if (!next || next === message.content) {
      cancel();
      return;
    }
    onEdit?.(next);
    setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <article className="group flex gap-3">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-2 font-mono text-fg-mute text-xs"
        aria-hidden
      >
        you
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-mono text-fg-dim text-xs">
          <span>You</span>
          {!editing && onEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="opacity-0 transition group-hover:opacity-100 hover:text-primary"
              title="Edit and re-run from here"
            >
              edit
            </button>
          )}
        </div>
        {editing ? (
          <div className="mt-1 space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              rows={Math.max(2, draft.split("\n").length)}
              className="w-full resize-y rounded border border-primary bg-bg-2 p-2 text-fg text-sm outline-none"
            />
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <button
                type="button"
                onClick={save}
                className="border border-primary bg-primary/10 px-2 py-0.5 text-primary hover:bg-primary/20"
              >
                save
              </button>
              <button type="button" onClick={cancel} className="text-fg-dim hover:text-fg">
                cancel
              </button>
              <span className="ml-auto text-fg-dim">
                Saving discards every message after this one.
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-1 whitespace-pre-wrap text-fg text-sm">{message.content}</div>
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((a) => (
                  <FilePill key={a.saved_path} file={a} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}
