// Git status pub/sub. One canonical `GitStatus` snapshot lives here;
// readers (StatusBar, FileBrowser decorations, SourceControlPanel)
// subscribe and re-render when it changes. Writers call `refreshGit()`
// after any user action that mutates the repo (stage, unstage,
// commit, file save). A 30 s tick catches external git operations
// (terminal commits, `git pull` from outside the IDE) without forcing
// users to refresh manually.
//
// Mirrors the toastBus / lspBus pattern: emit side has no React deps.

import { isDesktopIDE, type GitStatus } from "./sceloIDE";

type Listener = (s: GitStatus | null) => void;

const EMPTY: GitStatus | null = null;

let current: GitStatus | null = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function getGitStatus(): GitStatus | null {
  return current;
}

export function subscribeGit(fn: Listener): () => void {
  listeners.add(fn);
  fn(current); // replay snapshot
  return () => {
    listeners.delete(fn);
  };
}

function emit(s: GitStatus | null): void {
  current = s;
  for (const fn of listeners) fn(s);
}

export async function refreshGit(): Promise<void> {
  if (!isDesktopIDE()) {
    emit(null);
    return;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const s = await window.scelo!.git.status();
      emit(s);
    } catch (e) {
      // Leave the previous snapshot in place; surface error in next refresh.
      console.warn("gitBus: status failed", e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Start the 30 s background tick. Idempotent; safe to call from
 *  multiple subscribers' useEffect. */
export function ensureGitPolling(): void {
  if (pollTimer != null) return;
  pollTimer = setInterval(() => {
    void refreshGit();
  }, 30_000);
}

export function stopGitPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Drop the cached snapshot. Called by useWorkspaceShell when the
 *  workspace path changes so a stale repo's status doesn't bleed into
 *  the next workspace's first render. */
export function resetGitStatus(): void {
  emit(null);
}
