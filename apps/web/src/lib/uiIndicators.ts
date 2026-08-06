// Custom processing/done labels rendered in place of "thinking…" / "done"
// across the chat UI. (Stale mirror pointers removed: the old Python TUI's
// ui_indicators.py and the vscode webview copy no longer exist — the
// current scelo-tui repo has its own glyph spinner and does not use these
// word lists.)

export const PROCESSING_WORDS = [
  "stephenificating",
  "dowdeswelling",
  "nothaboing",
  "tweebuffelsmeteenskootmorsdoodgeskietfonteinary",
  "raeesatrying",
] as const;

export const DONE_WORDS = [
  "jurisiched",
  "marked",
  "ndebeled",
  "tweebuffelsmeteenskootmorsdoodgeskietfonteined",
  "ganeyed",
] as const;

export const ROTATION_MS = 1500;

export function pickDoneWord(): string {
  return DONE_WORDS[Math.floor(Math.random() * DONE_WORDS.length)];
}
