// Shared modal palette shell used by QuickOpen (Cmd+P, file lookup),
// SymbolPalette (Cmd+T, workspace/symbol), and CommandPalette
// (Cmd+Shift+P, IDE commands). The three caller components diverged
// slightly over Phases 15 / 16 / 18; the visual + keyboard contract
// is identical, so the shell lives here once and the callers focus on
// their data source + selection action.
//
// Caller responsibilities:
//   * Supply already-filtered `items` (we don't fuzzy-rank here —
//     each caller has a different ranking, e.g. SymbolPalette's
//     ranking is server-side).
//   * Render each item (label / detail / icon — wholly opaque to us).
//   * Receive onSelect when the user picks one, and onClose when they
//     cancel.
//   * Optionally listen for query changes (async data sources like
//     SymbolPalette refetch on the way in).
//
// We own:
//   * Modal backdrop + dismissal on outside-click.
//   * Focused input + controlled `query` state.
//   * Arrow-key navigation, Enter, Escape.
//   * Active row highlight (mouse hover or keyboard).
//   * 80-item render cap so the list stays instant on huge inputs.

import { useCallback, useEffect, useRef, useState } from "react";

export interface PaletteProps<T> {
  /** Items to display. The caller is responsible for filtering /
   *  ranking against the current query before passing this in. */
  items: T[];
  /** Stable id per item — used for React key + active-row tracking. */
  getKey: (item: T) => string;
  /** Render an item row. `isActive` is true for the keyboard-highlighted
   *  row so callers can apply their own active style if needed (the
   *  shell already adds the background tint). */
  renderItem: (item: T, isActive: boolean) => React.ReactNode;
  /** Fired on Enter / mouse click on the active row. */
  onSelect: (item: T) => void | Promise<void>;
  /** Fired on Escape, outside-click, or after onSelect completes. */
  onClose: () => void;

  /** Input placeholder text. */
  placeholder?: string;
  /** ARIA label for the dialog. */
  ariaLabel?: string;
  /** Optional initial query (e.g. when the caller is restoring search history). */
  initialQuery?: string;
  /** Called on every query change so async data sources can refetch. */
  onQueryChange?: (query: string) => void;
  /** Optional summary line shown beneath the input (e.g. "5 of 1200 files"). */
  summary?: React.ReactNode;
  /** Optional secondary header row above the input (e.g. recent-search chips). */
  headerExtra?: React.ReactNode;
}

const MAX_RENDERED = 80;

export default function Palette<T>({
  items,
  getKey,
  renderItem,
  onSelect,
  onClose,
  placeholder = "Type to search…",
  ariaLabel = "Palette",
  initialQuery = "",
  onQueryChange,
  summary,
  headerExtra,
}: PaletteProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const visible = items.slice(0, MAX_RENDERED);

  useEffect(() => {
    // Keep the active index in range as the visible set shrinks /
    // grows beneath us (e.g. fast typing rejects matches).
    setActive(0);
  }, [visible.length]);

  const commit = useCallback(
    async (idx: number) => {
      const item = visible[idx];
      if (!item) return;
      // Close before running so a command that opens another modal
      // doesn't race with this one tearing down.
      onClose();
      await Promise.resolve(onSelect(item));
    },
    [visible, onClose, onSelect],
  );

  const onKey: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, visible.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
  };

  const onChange = (next: string) => {
    setQuery(next);
    onQueryChange?.(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}
      onKeyDown={onKey}
      role="presentation"
    >
      <div
        className="w-[min(640px,90vw)] rounded-md border border-border bg-bg-2 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={ariaLabel}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-t-md border-b border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none"
        />
        {headerExtra && <div className="border-b border-border">{headerExtra}</div>}
        <ul className="max-h-[60vh] overflow-auto">
          {visible.length === 0 ? (
            <li className="px-3 py-2 text-xs text-fg-mute">no matches</li>
          ) : (
            visible.map((item, i) => (
              <li
                key={getKey(item)}
                onClick={() => commit(i)}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer border-b border-border/30 px-3 py-1 text-xs ${
                  i === active ? "bg-bg text-fg" : "text-fg-mute"
                }`}
              >
                {renderItem(item, i === active)}
              </li>
            ))
          )}
        </ul>
        <div className="rounded-b-md border-t border-border px-3 py-1 text-[10px] text-fg-mute">
          {summary ?? `${visible.length} item${visible.length === 1 ? "" : "s"}`}
          <span className="ml-3">↑↓ navigate · ↵ select · esc close</span>
        </div>
      </div>
    </div>
  );
}
