// Tiny bus for "toggle the viewer on the active editor." Keystrokes
// + the command palette emit through this; EditorPanel subscribes.
// Decouples global shortcuts (owned by useWorkspaceShell) from the
// editor's local viewer state.

type Listener = () => void;

const listeners = new Set<Listener>();

export function emitToggleViewer(): void {
  for (const fn of listeners) fn();
}

export function subscribeToggleViewer(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
