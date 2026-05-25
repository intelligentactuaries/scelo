// File browser sidebar for the Scelo IDE workspace.
//
// The active workspace is set via window.scelo.workspace.pick() (Electron
// open-dir dialog). The tree is lazy: directories load their children on
// first expand to keep large trees fast and the main IPC bounded.
//
// Files clicked emit onOpen(relPath) so the parent (WorkspaceLayout) can
// load them into the editor pane.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getGitStatus, subscribeGit } from "../../lib/gitBus";
import { isDesktopIDE, type FsListEntry, type GitStatus } from "../../lib/sceloIDE";
import { decorate as decorateGit } from "./SourceControlPanel";

interface Props {
  onOpen: (relPath: string) => void;
  activePath?: string | null;
  /** Notified when the user picks a new workspace dir. */
  onWorkspaceChange?: (path: string | null) => void;
}

type Node =
  | { kind: "file"; name: string; path: string; size: number }
  | {
      kind: "dir";
      name: string;
      path: string;
      expanded: boolean;
      loaded: boolean;
      children: Node[];
    };

export default function FileBrowser({ onOpen, activePath, onWorkspaceChange }: Props) {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [root, setRoot] = useState<Node[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(() => getGitStatus());
  useEffect(() => subscribeGit(setGit), []);

  /** Map workspace-relative path → single-char git decoration. Empty
   *  string when the file is unchanged. Memoised so the tree doesn't
   *  rebuild the map per row on every keystroke elsewhere. */
  const gitDecorations = useMemo(() => {
    const m = new Map<string, string>();
    if (!git || !git.isRepo) return m;
    for (const f of git.files) {
      const d = decorateGit(f);
      if (d) m.set(f.path, d);
    }
    return m;
  }, [git]);

  const loadRoot = useCallback(async () => {
    if (!isDesktopIDE()) return;
    const ws = await window.scelo!.workspace.get();
    setWorkspace(ws.path);
    onWorkspaceChange?.(ws.path);
    if (!ws.path) {
      setRoot([]);
      return;
    }
    const list = await window.scelo!.workspace.list();
    if (list.error) {
      setError(list.error);
      return;
    }
    setRoot(list.entries.map((e) => toNode(e, "")));
    setError(null);
  }, [onWorkspaceChange]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  const pickWorkspace = async () => {
    if (!isDesktopIDE()) return;
    const r = await window.scelo!.workspace.pick();
    if (r.path) {
      setWorkspace(r.path);
      onWorkspaceChange?.(r.path);
      await loadRoot();
    }
  };

  const toggle = async (path: string) => {
    const next = await mutateAt(root, path, async (n) => {
      if (n.kind !== "dir") return n;
      if (!n.loaded) {
        const list = await window.scelo!.workspace.list(path);
        const children = (list.entries ?? []).map((e) => toNode(e, path));
        return { ...n, expanded: true, loaded: true, children };
      }
      return { ...n, expanded: !n.expanded };
    });
    setRoot(next);
  };

  if (!isDesktopIDE()) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Workspace file browser is only available inside Scelo IDE.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-1">
        <span className="text-[10px] uppercase tracking-wider text-fg-mute">
          workspace
        </span>
        <button
          type="button"
          onClick={pickWorkspace}
          className="text-[10px] text-fg-mute hover:text-fg"
        >
          {workspace ? "change…" : "choose…"}
        </button>
      </div>
      {workspace ? (
        <div className="truncate border-b border-border px-3 py-1 font-mono text-[10px] text-fg-mute">
          {workspace}
        </div>
      ) : null}
      {error && (
        <div className="border-b border-adversarial/40 bg-adversarial/10 px-3 py-1 text-[10px] text-adversarial">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-auto p-1 text-sm">
        {!workspace ? (
          <div className="p-3 text-[11px] text-fg-mute">
            No workspace selected. Click <em>choose…</em> above to pick a folder
            on disk; files become editable inside Scelo IDE.
          </div>
        ) : root.length === 0 ? (
          <div className="p-3 text-[11px] text-fg-mute">empty workspace</div>
        ) : (
          <Tree
            nodes={root}
            depth={0}
            onToggle={toggle}
            onOpen={onOpen}
            activePath={activePath ?? null}
            gitDecorations={gitDecorations}
          />
        )}
      </div>
    </div>
  );
}

function Tree({
  nodes,
  depth,
  onToggle,
  onOpen,
  activePath,
  gitDecorations,
}: {
  nodes: Node[];
  depth: number;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  activePath: string | null;
  gitDecorations: Map<string, string>;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.kind === "dir" ? (
            <>
              <button
                type="button"
                onClick={() => onToggle(n.path)}
                className="flex w-full items-baseline gap-1 rounded px-2 py-0.5 text-left text-xs hover:bg-bg"
                style={{ paddingLeft: `${depth * 12 + 6}px` }}
              >
                <span className="w-3 text-fg-mute">{n.expanded ? "▾" : "▸"}</span>
                <span className="font-mono">{n.name}/</span>
              </button>
              {n.expanded && n.children.length > 0 && (
                <Tree
                  nodes={n.children}
                  depth={depth + 1}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  activePath={activePath}
                  gitDecorations={gitDecorations}
                />
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(n.path)}
              className={`flex w-full items-baseline gap-1 rounded px-2 py-0.5 text-left text-xs hover:bg-bg ${
                activePath === n.path ? "bg-bg" : ""
              }`}
              style={{ paddingLeft: `${depth * 12 + 18}px` }}
            >
              <span className="font-mono">{n.name}</span>
              {gitDecorations.get(n.path) && (
                <span
                  className="ml-auto font-mono text-[10px] text-warn"
                  title={`git: ${gitDecorations.get(n.path)}`}
                >
                  {gitDecorations.get(n.path)}
                </span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function toNode(e: FsListEntry, parentPath: string): Node {
  const path = parentPath ? `${parentPath}/${e.name}` : e.name;
  if (e.isDir) {
    return {
      kind: "dir",
      name: e.name,
      path,
      expanded: false,
      loaded: false,
      children: [],
    };
  }
  return { kind: "file", name: e.name, path, size: e.size };
}

async function mutateAt(
  nodes: Node[],
  path: string,
  fn: (n: Node) => Node | Promise<Node>,
): Promise<Node[]> {
  return Promise.all(
    nodes.map(async (n) => {
      if (n.path === path) return await fn(n);
      if (n.kind === "dir" && n.expanded) {
        return {
          ...n,
          children: await mutateAt(n.children, path, fn),
        };
      }
      return n;
    }),
  );
}
