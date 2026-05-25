// "Apply this text to the active editor" pub/sub. The AI panel emits
// when the user clicks the Apply button under a fenced code block;
// EditorPanel subscribes and performs the edit — replacing the
// current selection, or inserting at the caret when nothing is
// selected. Save is NOT triggered; the user reviews + saves
// themselves.
//
// Scoped to "the active editor" because there's only ever one Monaco
// instance in /workspace. If we ever support split editors this
// becomes a per-editor channel.

import { emitToast } from "./toastBus";

export interface ApplyRequest {
  /** Workspace-relative path the suggestion targets. The editor
   *  ignores the request when its active path doesn't match, and
   *  toasts a friendly warning so the user understands why nothing
   *  happened. */
  targetPath: string;
  /** The raw text to put into the editor — the AI panel strips the
   *  ``` fence + language tag before emitting. */
  text: string;
}

type Listener = (req: ApplyRequest) => void;

const listeners = new Set<Listener>();

export function applyToEditor(req: ApplyRequest): void {
  if (listeners.size === 0) {
    // No editor mounted to receive it. Surface a toast rather than
    // silently dropping so the user knows the click did something.
    emitToast("No editor is open to receive the suggestion.", "info");
    return;
  }
  for (const fn of listeners) fn(req);
}

export function subscribeApplyToEditor(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
