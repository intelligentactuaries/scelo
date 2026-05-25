// Source-control sidebar — minimal Git surface: branch line, staged
// vs unstaged groups, a commit-message box. Click a file to open it
// in the editor. Stage / unstage runs via the gitBus refresh so the
// FileBrowser decorations + StatusBar branch cell update in lockstep.
//
// What this panel deliberately does NOT do:
//   * Inline diff view  (deferred; would warrant its own panel)
//   * Push / pull       (the user has a terminal; we don't want to
//                        own the credential-helper UX yet)
//   * Branch switching  (same rationale: terminal is the right tool)

import { useEffect, useState } from "react";
import { emitToast } from "../../lib/toastBus";
import {
  ensureGitPolling,
  refreshGit,
  subscribeGit,
} from "../../lib/gitBus";
import { useDraft } from "../../lib/inputDrafts";
import { isDesktopIDE, type GitFile, type GitStatus } from "../../lib/sceloIDE";

interface Props {
  onOpen: (path: string) => void;
}

export default function SourceControlPanel({ onOpen }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  // Per-branch draft key : commit messages are scoped to a branch +
  // the workspace's git status set so switching branches doesn't
  // pull the previous branch's message into the input.
  const draftKey = `commit-message.${status?.branch ?? "default"}`;
  const [message, setMessage] = useDraft(draftKey);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = subscribeGit(setStatus);
    void refreshGit();
    ensureGitPolling();
    return unsub;
  }, []);

  if (!isDesktopIDE()) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Source control is only available inside Scelo IDE.
      </div>
    );
  }

  if (!status) {
    return <div className="p-3 text-xs text-fg-mute">Reading repo status…</div>;
  }

  if (!status.gitInstalled) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        <p>git is not on this machine's PATH.</p>
        <p className="mt-2">
          Install it and re-launch Scelo IDE. The rest of the workspace works
          without it; only this panel needs git.
        </p>
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        This workspace is not a git repository.{" "}
        <button
          type="button"
          className="text-fg underline-grow hover:text-fg"
          onClick={async () => {
            // No "init" IPC yet; tell the user how to bootstrap so they
            // don't feel stuck. The Welcome flow's sample scaffolds run
            // `git init` automatically.
            emitToast("Run `git init` in the terminal panel to start tracking.", "info");
          }}
        >
          how do I start tracking?
        </button>
      </div>
    );
  }

  const staged = status.files.filter((f) => f.index !== " " && f.index !== "?");
  const unstaged = status.files.filter(
    (f) => f.worktree !== " " || f.index === "?",
  );

  const stage = async (paths: string[]) => {
    setBusy(true);
    const r = await window.scelo!.git.stage(paths);
    if (!r.ok) emitToast(r.error ?? "git add failed", "error");
    await refreshGit();
    setBusy(false);
  };
  const unstage = async (paths: string[]) => {
    setBusy(true);
    const r = await window.scelo!.git.unstage(paths);
    if (!r.ok) emitToast(r.error ?? "git unstage failed", "error");
    await refreshGit();
    setBusy(false);
  };
  const stageAll = () => stage(unstaged.map((f) => f.path));
  const commit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    const r = await window.scelo!.git.commit(message.trim());
    if (r.ok) {
      emitToast(`Committed ${r.sha ?? ""} ${truncate(message.trim(), 60)}`.trim(), "success");
      setMessage("");
    } else {
      emitToast(r.error ?? "git commit failed", "error");
    }
    await refreshGit();
    setBusy(false);
  };

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          source control
        </span>
        <button
          type="button"
          onClick={() => void refreshGit()}
          className="text-[10px] text-fg-mute hover:text-fg"
          disabled={busy}
        >
          refresh
        </button>
      </div>
      <div className="border-b border-border px-3 py-2 text-xs">
        <div className="text-fg">
          {status.branch ?? "(detached)"}
          {status.upstream && (
            <span className="ml-2 text-fg-mute">
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </div>
        {status.upstream && (
          <div className="font-mono text-[10px] text-fg-mute">{status.upstream}</div>
        )}
      </div>

      <div className="border-b border-border px-3 py-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message (Ctrl/Cmd-Enter to commit)"
          rows={2}
          className="w-full resize-y rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-primary focus:outline-none"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-fg-mute">
          <span>
            {staged.length === 0
              ? "nothing staged"
              : `${staged.length} staged change${staged.length === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            onClick={commit}
            disabled={busy || staged.length === 0 || !message.trim()}
            className="ia-btn ia-btn-sm ia-btn-primary"
          >
            commit
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2 text-xs">
        <Section
          title="Staged"
          files={staged}
          onClickPath={onOpen}
          onAct={unstage}
          actLabel="−"
          actTitle="Unstage"
        />
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-mute">
            Changes
          </span>
          {unstaged.length > 0 && (
            <button
              type="button"
              onClick={stageAll}
              disabled={busy}
              className="text-[10px] text-fg-mute hover:text-fg"
            >
              stage all
            </button>
          )}
        </div>
        <FilesList
          files={unstaged}
          onClickPath={onOpen}
          onAct={(paths) => void stage(paths)}
          actLabel="+"
          actTitle="Stage"
        />
        {staged.length === 0 && unstaged.length === 0 && (
          <p className="mt-3 text-[11px] text-fg-mute">working tree clean</p>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  files,
  onClickPath,
  onAct,
  actLabel,
  actTitle,
}: {
  title: string;
  files: GitFile[];
  onClickPath: (p: string) => void;
  onAct: (paths: string[]) => void;
  actLabel: string;
  actTitle: string;
}) {
  if (files.length === 0) return null;
  return (
    <>
      <span className="text-[10px] uppercase tracking-wider text-fg-mute">
        {title}
      </span>
      <FilesList
        files={files}
        onClickPath={onClickPath}
        onAct={onAct}
        actLabel={actLabel}
        actTitle={actTitle}
      />
    </>
  );
}

function FilesList({
  files,
  onClickPath,
  onAct,
  actLabel,
  actTitle,
}: {
  files: GitFile[];
  onClickPath: (p: string) => void;
  onAct: (paths: string[]) => void;
  actLabel: string;
  actTitle: string;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {files.map((f) => (
        <li
          key={f.path}
          className="flex items-baseline justify-between gap-1 rounded px-1 py-0.5 hover:bg-bg"
        >
          <button
            type="button"
            onClick={() => onClickPath(f.path)}
            className="min-w-0 flex-1 text-left font-mono text-[11px] text-fg"
            title={f.path}
          >
            <span className="mr-2 w-3 text-fg-mute">{decorate(f)}</span>
            {f.path}
          </button>
          <button
            type="button"
            onClick={() => onAct([f.path])}
            title={actTitle}
            className="ia-btn ia-btn-sm ia-btn-ghost h-5 w-5 px-0"
          >
            {actLabel}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function decorate(f: GitFile): string {
  // The single char shown in the file tree gutter + the panel rows.
  // Worktree change wins when both index and worktree have status,
  // because that's what the user is "currently editing".
  if (f.index === "?") return "?";
  if (f.worktree !== " " && f.worktree !== ".") return f.worktree;
  if (f.index !== " " && f.index !== ".") return f.index;
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
