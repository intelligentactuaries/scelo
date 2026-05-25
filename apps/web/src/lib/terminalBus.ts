// Pub/sub for "please run this in the terminal" requests. Decouples
// the palette / shortcuts (top of the shell) from TerminalPanel
// (bottom of the shell). The terminal subscribes once on mount and
// writes whatever it gets straight to its stdin — keystrokes,
// effectively, so the underlying shell handles word-splitting,
// readline, and Ctrl-C the same way as a typed command.
//
// Same shape as toastBus / gitBus / lspBus. No React deps on emit.

type Listener = (cmd: string) => void;

const listeners = new Set<Listener>();

export function enqueueTerminalCommand(cmd: string): void {
  for (const fn of listeners) fn(cmd);
}

export function subscribeTerminal(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Escape a path so it can be safely interpolated into a double-quoted
 *  bash / zsh / cmd argument. Conservative: only escapes the chars
 *  that change meaning inside double quotes. */
export function shellQuote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}
