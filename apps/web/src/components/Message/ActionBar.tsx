// Per-assistant-message action bar: copy, regenerate, branch.
// Edit is on the *user* message above (handled in UserMessage.tsx).
// Hidden while the assistant is still streaming.

type Props = {
  text: string;
  onRegenerate?: () => void;
  onBranch?: () => void;
  hidden?: boolean;
};

export function ActionBar({ text, onRegenerate, onBranch, hidden = false }: Props) {
  if (hidden) return null;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers — silently no-op; we can surface a toast in
      // checkpoint 14 if this becomes a real concern.
    }
  };

  return (
    <div className="mt-2 flex items-center gap-3 font-mono text-fg-dim text-[11px]">
      <button
        type="button"
        onClick={onCopy}
        className="hover:text-primary"
        title="Copy markdown to clipboard"
      >
        copy
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="hover:text-primary"
          title="Re-run from the previous user message"
        >
          regenerate
        </button>
      )}
      {onBranch && (
        <button
          type="button"
          onClick={onBranch}
          className="hover:text-primary"
          title="Branch the conversation from this point"
        >
          branch
        </button>
      )}
    </div>
  );
}
