// Custom processing/done labels rendered in place of "thinking…" / "done"
// across the chat UI. Mirror copies live in:
//   - apps/tui/ia_tui/ui_indicators.py
//   - apps/vscode/src/webview/uiIndicators.ts

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
