// toastBus — tiny pub/sub for transient UI notices.
//
// Any component in the IDE (file-tree, command-palette runner, terminal,
// LSP errors caught at the route level) can call `emitToast(text, kind)`
// and the single <ToastTray> mounted in /workspace will render + auto-
// dismiss it. Avoids prop-drilling a setToast callback through six
// layers when a deeply-nested click handler wants to flash a notice.
//
// Deliberately no React dependency in this module — the emit side is a
// pure function so non-component code (e.g. a fetch utility) can ping
// without import cycles.

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  /** Epoch ms when the toast was emitted. Subscribers use this to
   *  decide stacking order + auto-dismiss timing. */
  emittedAt: number;
}

type Listener = (toast: Toast) => void;

const _listeners = new Set<Listener>();
let _nextId = 1;

/** Subscribe to every future toast. Returns an unsubscribe fn. */
export function subscribeToasts(cb: Listener): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** Emit a transient notice. Returns the assigned id so the caller can
 *  pre-emptively dismiss it via `clearToast(id)` if needed (rare —
 *  most call sites fire-and-forget and let the 6 s auto-dismiss run). */
export function emitToast(text: string, kind: ToastKind = "info"): number {
  const t: Toast = { id: _nextId++, text, kind, emittedAt: Date.now() };
  for (const l of _listeners) l(t);
  return t.id;
}

/** Test/debug hook — only useful for assertions in unit tests. */
export function _resetToastBus(): void {
  _listeners.clear();
  _nextId = 1;
}
