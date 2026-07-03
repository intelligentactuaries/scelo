// /welcome — the "first thing you see" view for Scelo IDE. Mounted
// when the IDE launches with no active workspace, and reachable from
// the command palette ("Help: Welcome") at any time.
//
// Three columns of content:
//   1. Primary actions     Open Folder · Switch Workspace · Configure AI
//   2. Recent workspaces   list from `window.scelo!.workspace.registry()`
//   3. Sample workspaces   tiles backed by SAMPLE_WORKSPACES + the
//                          create-from-template IPC (P25-3)
//
// Browser preview gracefully degrades: only the AI link and the Scelo
// dashboard link work; folder / template actions explain they need
// the desktop IDE.

import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SceloLogo } from "../components/Scelo/SceloLogo";
import { SwarmNavLink, useSwarmProbe } from "../components/SwarmStatus";
import ToastTray from "../components/workspace/ToastTray";
import { SAMPLE_WORKSPACES, type SampleWorkspaceSpec } from "../lib/sampleWorkspaces";
import { type WorkspaceRecord, isDesktopIDE } from "../lib/sceloIDE";
import { emitToast } from "../lib/toastBus";

export default function Welcome() {
  const desktop = isDesktopIDE();
  const navigate = useNavigate();
  const swarmProbe = useSwarmProbe();
  const [recents, setRecents] = useState<WorkspaceRecord[]>([]);
  const [busyTemplate, setBusyTemplate] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void window.scelo!.workspace.registry().then((r) => {
      if (cancelled) return;
      const sorted = [...r.workspaces].sort((a, b) => b.lastActive - a.lastActive);
      setRecents(sorted);
    });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const openFolder = async () => {
    if (!desktop) return;
    const r = await window.scelo!.workspace.pick();
    if (r.path && r.id) {
      await window.scelo!.workspace.setForWindow(r.id);
      navigate("/workspace");
    }
  };

  const switchTo = async (rec: WorkspaceRecord) => {
    if (!desktop) return;
    const r = await window.scelo!.workspace.setForWindow(rec.id);
    if (r.ok) navigate("/workspace");
    else emitToast(r.error ?? "Could not switch workspace", "error");
  };

  const createFromTemplate = async (spec: SampleWorkspaceSpec) => {
    if (!desktop) {
      emitToast("Sample templates require Scelo IDE.", "info");
      return;
    }
    setBusyTemplate(spec.id);
    try {
      const r = await window.scelo!.workspace.createFromTemplate(spec.id);
      if (r.ok && r.id) {
        emitToast(`Created ${spec.title} at ${r.path ?? ""}.`, "success");
        navigate("/workspace");
      } else if (!r.ok && r.error !== "cancelled") {
        emitToast(r.error ?? "Could not create sample workspace.", "error");
      }
    } finally {
      setBusyTemplate(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <ToastTray />
      <header className="border-b border-border bg-bg-2 px-6 py-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="flex items-center gap-3 font-display text-2xl text-fg">
              <SceloLogo className="h-10 w-10" />
              <span>Scelo</span>
            </h1>
            <p className="mt-1 text-sm text-fg-mute">
              {desktop
                ? "Open a workspace to start, or pick a sample to scaffold one."
                : "Browser preview, the full workspace requires the Scelo IDE download."}
            </p>
          </div>
          <nav className="flex items-center gap-1">
            {desktop ? (
              <Link to="/workspace" className="ia-btn ia-btn-sm ia-btn-ghost">
                workspace
              </Link>
            ) : (
              <Link to="/" className="ia-btn ia-btn-sm ia-btn-ghost">
                chat
              </Link>
            )}
            <Link to="/dashboards/scelo" className="ia-btn ia-btn-sm ia-btn-ghost">
              scelo
            </Link>
            <SwarmNavLink />
            <Link to="/settings/ai" className="ia-btn ia-btn-sm ia-btn-ghost">
              settings
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-10 lg:grid-cols-[1fr_1fr]">
        <section>
          <h2 className="font-display text-lg">Get started</h2>
          <div className="mt-3 grid gap-2">
            <PrimaryAction
              label="Open Folder…"
              hint={
                desktop
                  ? "Pick any directory; Scelo treats it as the workspace root."
                  : "Desktop only."
              }
              disabled={!desktop}
              onClick={openFolder}
            />
            <PrimaryAction
              label="Switch Workspace…"
              hint="All workspaces this install knows about."
              disabled={!desktop}
              onClick={() => navigate("/settings/workspaces")}
            />
            <PrimaryAction
              label="Configure AI Provider"
              hint="Ollama is the default; bring your own Claude / OpenAI / Gemini key."
              onClick={() => navigate("/settings/ai")}
            />
            <PrimaryAction
              label="Download a dataset"
              hint="IBTrACS, WHO life tables, NFIP claims, ChEMBL."
              onClick={() => navigate("/settings/data")}
            />
            <PrimaryAction
              label={
                <span className="inline-flex items-center gap-2">
                  Open the Swarm
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      swarmProbe === "up" ? "bg-primary" : "bg-fg-dim"
                    }`}
                  />
                  {swarmProbe === "up" && (
                    <span className="font-mono text-[10px] text-primary">live</span>
                  )}
                </span>
              }
              hint={
                swarmProbe === "up"
                  ? "The council deliberation UI — server is live on :3010."
                  : "Stratified-persona councils on your results. Server not detected on :3010 — the view shows how to start it."
              }
              onClick={() => navigate("/swarm")}
            />
          </div>

          <h2 className="mt-8 font-display text-lg">Recent workspaces</h2>
          {!desktop && <p className="mt-2 text-sm text-fg-mute">Available in Scelo IDE.</p>}
          {desktop && recents.length === 0 && (
            <p className="mt-2 text-sm text-fg-mute">
              You haven't opened a workspace yet. Pick one above or scaffold a sample on the right.
            </p>
          )}
          {desktop && recents.length > 0 && (
            <ul className="mt-3 space-y-1">
              {recents.slice(0, 8).map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => switchTo(w)}
                    className="flex w-full items-baseline justify-between gap-3 rounded border border-transparent px-2 py-1 text-left text-sm hover:border-border hover:bg-bg-2"
                  >
                    <span className="truncate text-fg">{pathLeaf(w.path)}</span>
                    <span className="shrink-0 truncate font-mono text-[11px] text-fg-mute">
                      {w.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="font-display text-lg">Sample workspaces</h2>
          <p className="mt-1 text-sm text-fg-mute">
            Each template scaffolds a small but runnable workspace, no placeholders, no TODO bodies.
            Pick one to copy it onto disk.
          </p>
          <div className="mt-3 grid gap-3">
            {SAMPLE_WORKSPACES.map((s) => (
              <article key={s.id} className="rounded border border-border bg-bg-2 p-4">
                <header className="flex items-baseline justify-between gap-2">
                  <h3 className="text-base text-fg">{s.title}</h3>
                  <button
                    type="button"
                    onClick={() => createFromTemplate(s)}
                    disabled={busyTemplate === s.id}
                    className="ia-btn ia-btn-md ia-btn-secondary"
                  >
                    {busyTemplate === s.id ? "Creating…" : "Create…"}
                  </button>
                </header>
                <p className="mt-1 text-sm text-fg-mute">{s.blurb}</p>
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-fg-mute">
                  {s.highlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
                {s.needsDatasets.length > 0 && (
                  <p className="mt-2 text-[11px] text-fg-mute">
                    Datasets used:{" "}
                    {s.needsDatasets.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <Link to="/settings/data" className="text-fg hover:underline">
                          {id}
                        </Link>
                      </span>
                    ))}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function PrimaryAction({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: ReactNode;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-1 rounded border border-border bg-transparent px-4 py-3 text-left transition hover:border-fg hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="text-sm font-medium text-fg">{label}</span>
      <span className="text-xs text-fg-mute">{hint}</span>
    </button>
  );
}

function pathLeaf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
