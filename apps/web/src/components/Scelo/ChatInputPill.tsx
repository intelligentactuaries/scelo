// Single visually-unified chat input. Used by every chat surface in Scelo —
// macro-view node chats, workstation stage chatbars, the per-column popover,
// the per-model detail dashboard, etc. — so every textarea + send affordance
// in the product reads identically: one rounded pill, no visible scrollbars,
// a return-key send button at the bottom-right, focus-within border.
//
// Sizing is controlled by the `size` prop: "xs" is the compact macro-node
// shape, "sm" is the roomier workstation shape.

import { EnterKey } from "@/components/Arrow";
import { type KeyboardEvent, type RefObject, useRef } from "react";

export type ChatInputPillSize = "xs" | "sm";

export function ChatInputPill({
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  isStreaming,
  placeholder,
  rows = 2,
  size = "sm",
  streamingHint = "thinking…",
  textareaRef,
  autoFocus = false,
  className,
  disabled = false,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  placeholder: string;
  rows?: number;
  size?: ChatInputPillSize;
  /** Bottom-left hint shown while a stream is in flight. Defaults to "thinking…". */
  streamingHint?: string;
  textareaRef?: RefObject<HTMLTextAreaElement>;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  // Track our own textarea ref unless the caller supplied one — covers both
  // "I just want a chat input" usage and "I need to focus it programmatically".
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? ownRef;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const dims =
    size === "xs"
      ? {
          textArea: "text-[10px] leading-relaxed",
          hint: "text-[8px]",
          sendBtn: "h-6 w-6",
          stopBtn: "text-[8px]",
          icon: 14,
          containerPad: "px-3 pb-1.5 pt-2",
          radius: "rounded-2xl",
          radiusBtn: "rounded-full",
        }
      : {
          textArea: "text-[12px] leading-relaxed",
          hint: "text-[9px]",
          sendBtn: "h-7 w-7",
          stopBtn: "text-[9px]",
          icon: 15,
          containerPad: "px-3.5 pb-2 pt-2.5",
          radius: "rounded-2xl",
          radiusBtn: "rounded-full",
        };

  return (
    <div
      className={`${dims.radius} border border-border bg-bg/60 ${dims.containerPad} transition focus-within:border-fg-dim focus-within:bg-bg ${className ?? ""}`}
    >
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        // biome-ignore lint/a11y/noAutofocus: autofocus is opt-in via the prop and only used inside modals that were just opened by the user.
        autoFocus={autoFocus}
        className={`nodrag nowheel scrollbar-none block w-full resize-none border-0 bg-transparent p-0 font-mono ${dims.textArea} text-fg placeholder:italic placeholder:text-fg-dim focus:outline-none focus:ring-0`}
      />
      <div className="mt-1 flex items-center justify-between">
        {/* Empty at rest: the return-key button says how to send. */}
        <span className={`font-mono ${dims.hint} tracking-wider text-fg-dim`}>
          {isStreaming ? streamingHint : null}
        </span>
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="stop"
            className={`nodrag rounded-full px-2 py-0.5 font-mono ${dims.stopBtn} uppercase tracking-[0.15em] text-fg-dim hover:text-error`}
          >
            stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!draft.trim() || disabled}
            aria-label="send"
            title="Send (Enter)"
            // Stays a visible key at rest (dimmer, not faded out), and
            // brightens once there is something to send.
            className={`nodrag flex ${dims.sendBtn} ${dims.radiusBtn} items-center justify-center bg-fg/10 text-fg transition hover:bg-primary/15 hover:text-primary disabled:cursor-not-allowed disabled:bg-fg/5 disabled:text-fg-mute`}
          >
            <EnterKey size={dims.icon} />
          </button>
        )}
      </div>
    </div>
  );
}
