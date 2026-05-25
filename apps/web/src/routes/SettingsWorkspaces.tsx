// /settings/workspaces — multi-workspace registry.
//
// The IDE remembers every workspace dir the user has opened (atomic-rename
// JSON file under userData). This page lists them, lets the user switch
// (reloads the renderer pointed at the new dir) or remove (registry entry
// only — never touches the dir itself).

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isDesktopIDE, type WorkspaceRecord } from "../lib/sceloIDE";
import { emitToast } from "../lib/toastBus";

export default function SettingsWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    if (!isDesktopIDE()) return;
    const [reg, active] = await Promise.all([
      window.scelo!.workspace.registry(),
      window.scelo!.workspace.get(),
    ]);
    setWorkspaces(reg.workspaces);
    setActiveId(active.id);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!isDesktopIDE()) {
    return (
      <div className="mx-auto max-w-3xl p-8 font-sans text-fg">
        <h1 className="mb-2 text-xl font-medium">Workspaces</h1>
        <p className="text-fg-mute">Only meaningful inside Scelo IDE.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded border border-border bg-bg-2 px-3 py-1.5 text-sm hover:border-fg"
        >
          ← back
        </Link>
      </div>
    );
  }

  const onAdd = async () => {
    const r = await window.scelo!.workspace.pick();
    if (r.id) {
      await reload();
      navigate("/workspace");
    }
  };

  const onSwitch = async (id: string) => {
    const r = await window.scelo!.workspace.switch(id);
    if (r.ok) {
      navigate("/workspace");
    } else {
      // Most likely cause: the workspace dir was deleted on disk
      // since we last saw it. main.ts also drops the entry from
      // the registry; reload picks that up.
      emitToast(`Switch failed: ${r.error ?? "unknown"}`, "error");
      await reload();
    }
  };

  const onRemove = async (id: string) => {
    await window.scelo!.workspace.remove(id);
    await reload();
    emitToast(`Workspace removed from list.`, "info");
  };

  return (
    <div className="mx-auto max-w-3xl p-8 font-sans text-fg">
      <header className="mb-6">
        <div className="text-xs uppercase tracking-wider text-fg-mute">
          settings · workspaces
        </div>
        <h1 className="text-2xl font-medium">Workspaces</h1>
        <p className="mt-1 text-sm text-fg-mute">
          Every directory you've opened in Scelo IDE. Open tabs persist
          per-workspace, so switching back to one drops you exactly where
          you were.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {workspaces.length === 0 && (
          <li className="rounded-md border border-border bg-bg-2 p-4 text-sm text-fg-mute">
            No workspaces yet.
          </li>
        )}
        {workspaces.map((w) => {
          const isActive = w.id === activeId;
          return (
            <li
              key={w.id}
              className={`flex items-baseline justify-between rounded-md border p-3 ${
                isActive ? "border-fg bg-bg" : "border-border bg-bg-2"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-fg">{w.path}</div>
                <div className="text-[10px] text-fg-mute">
                  id {w.id} · last opened {new Date(w.lastActive).toLocaleString()}
                </div>
              </div>
              <div className="ml-3 flex items-center gap-2">
                {isActive ? (
                  <Link
                    to="/workspace"
                    className="ia-btn ia-btn-sm ia-btn-primary"
                  >
                    open
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => onSwitch(w.id)}
                    className="ia-btn ia-btn-sm ia-btn-secondary"
                  >
                    switch
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(w.id)}
                  className="ia-btn ia-btn-sm ia-btn-danger"
                  title="remove from list (does not delete the dir)"
                >
                  remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="ia-btn ia-btn-md ia-btn-primary"
        >
          + add workspace…
        </button>
        <Link
          to="/"
          className="ia-btn ia-btn-md ia-btn-secondary"
        >
          ← back to chat
        </Link>
      </div>
    </div>
  );
}
