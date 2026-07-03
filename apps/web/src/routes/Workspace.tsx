// /workspace — three-pane Scelo IDE workspace with multi-tab editor.
//
//   ┌───────────┬────────────────────────────────┐
//   │ FileTree  │ Tabs  ▸ EditorPanel            │
//   │           │                                │
//   │           ├────────────────────────────────┤
//   │           │ TerminalPanel                  │
//   └───────────┴────────────────────────────────┘
//
// All state + effects (palette assembly, outline fetch, LSP root,
// shortcuts, persisted tabs) live in `useWorkspaceShell`. The hook
// returns a small set of namespaces (`shell.tabs`, `shell.workspace`,
// `shell.editor`, `shell.palettes`) so JSX call sites stay tidy.

import { Link, Navigate } from "react-router-dom";
import { SwarmNavLink } from "../components/SwarmStatus";
import AIPanel from "../components/workspace/AIPanel";
import CommandPalette from "../components/workspace/CommandPalette";
import EditorPanel from "../components/workspace/EditorPanel";
import FileBrowser from "../components/workspace/FileBrowser";
import OutlinePanel, { breadcrumbFor } from "../components/workspace/OutlinePanel";
import ProblemsPanel from "../components/workspace/ProblemsPanel";
import QuickOpen from "../components/workspace/QuickOpen";
import SearchPanel from "../components/workspace/SearchPanel";
import SourceControlPanel from "../components/workspace/SourceControlPanel";
import StatusBar from "../components/workspace/StatusBar";
import SymbolPalette from "../components/workspace/SymbolPalette";
import TerminalPanel from "../components/workspace/TerminalPanel";
import TestsPanel from "../components/workspace/TestsPanel";
import ToastTray from "../components/workspace/ToastTray";
import { isDesktopIDE } from "../lib/sceloIDE";
import { type SidebarTab, useWorkspaceShell } from "../lib/useWorkspaceShell";

export default function Workspace() {
  const shell = useWorkspaceShell();
  const { tabs, workspace, editor, palettes } = shell;

  // First-run handoff: in the desktop IDE with no workspace, send the
  // user to /welcome (recent workspaces, sample scaffolds, configure
  // AI) instead of the silent grey pane the editor would otherwise
  // show. Swarm is its own /swarm route now, so we don't need to
  // skip-the-redirect for it.
  if (isDesktopIDE() && workspace.path === null) {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <ToastTray />
      <header className="flex items-baseline justify-between border-b border-border bg-bg-2 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="text-xs uppercase tracking-wider text-fg-mute">
            scelo ide · workspace
          </span>
          {!isDesktopIDE() && (
            <span className="rounded border border-dissent/40 bg-dissent/10 px-2 py-0.5 text-[10px] text-dissent">
              browser preview — full workspace requires Scelo IDE
            </span>
          )}
        </div>
        <nav className="flex items-center gap-1">
          <Link to="/welcome" className="ia-btn ia-btn-sm ia-btn-ghost">
            welcome
          </Link>
          <Link to="/dashboards/scelo" className="ia-btn ia-btn-sm ia-btn-ghost">
            scelo
          </Link>
          <SwarmNavLink />
          <Link to="/settings/ai" className="ia-btn ia-btn-sm ia-btn-ghost">
            settings
          </Link>
          {!isDesktopIDE() && (
            <Link to="/" className="ia-btn ia-btn-sm ia-btn-ghost">
              chat (browser)
            </Link>
          )}
        </nav>
      </header>

      <div
        className="grid flex-1 min-h-0"
        style={{
          gridTemplateColumns: workspace.aiPanelVisible
            ? `${workspace.sidebarWidth}px 4px 1fr 4px ${workspace.aiPanelWidth}px`
            : `${workspace.sidebarWidth}px 4px 1fr`,
        }}
      >
        <aside
          className="grid min-h-0 overflow-hidden border-r border-border"
          style={{ gridTemplateRows: "auto 1fr" }}
        >
          <div className="flex border-b border-border bg-bg-2">
            {(["files", "search", "outline", "git", "problems", "tests"] as SidebarTab[]).map(
              (t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => workspace.setSidebarTab(t)}
                  className={`flex-1 px-2 py-1 text-[10px] uppercase tracking-wider ${
                    workspace.sidebarTab === t
                      ? "border-b border-fg text-fg"
                      : "text-fg-mute hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ),
            )}
          </div>
          {workspace.sidebarTab === "files" && (
            <FileBrowser
              onOpen={tabs.openFile}
              activePath={tabs.active}
              onWorkspaceChange={workspace.setPath}
            />
          )}
          {workspace.sidebarTab === "search" && (
            <SearchPanel
              workspacePath={workspace.path}
              onOpen={(path, line) => {
                tabs.openFile(path);
                editor.setPendingJump({ path, line });
              }}
            />
          )}
          {workspace.sidebarTab === "outline" && (
            <OutlinePanel
              activeFile={tabs.active}
              onOpenAtLine={(path, line) => {
                if (tabs.active !== path) tabs.openFile(path);
                editor.setPendingJump({ path, line });
              }}
              caretLine={editor.caretLine}
              onOutlineChange={editor.setOutline}
              externalOutline={editor.outline}
            />
          )}
          {workspace.sidebarTab === "git" && <SourceControlPanel onOpen={tabs.openFile} />}
          {workspace.sidebarTab === "problems" && (
            <ProblemsPanel
              onOpenAtLine={(path, line) => {
                tabs.openFile(path);
                editor.setPendingJump({ path, line });
              }}
            />
          )}
          {workspace.sidebarTab === "tests" && <TestsPanel workspacePath={workspace.path} />}
        </aside>

        <SidebarResizer width={workspace.sidebarWidth} onChange={workspace.setSidebarWidth} />

        {palettes.quickOpen && (
          <QuickOpen
            workspacePath={workspace.path}
            onOpen={tabs.openFile}
            onClose={() => palettes.setQuickOpen(false)}
          />
        )}

        {palettes.symbol && (
          <SymbolPalette
            workspacePath={workspace.path}
            onOpenAtLine={(path, line) => {
              tabs.openFile(path);
              editor.setPendingJump({ path, line });
            }}
            onClose={() => palettes.setSymbol(false)}
          />
        )}

        {palettes.command && (
          <CommandPalette commands={palettes.commands} onClose={() => palettes.setCommand(false)} />
        )}

        <div
          className="grid min-h-0"
          style={{
            // Terminal row is 280px when visible, 0 when hidden — we
            // keep the row + the TerminalPanel mounted (display:none
            // on the section) so xterm + the shell process survive a
            // toggle. That's what makes "terminal in background"
            // actually mean "long-running processes keep running".
            gridTemplateRows: workspace.terminalVisible ? "auto 1fr 280px" : "auto 1fr 0",
          }}
        >
          {tabs.open.length > 0 && (
            <div className="flex items-stretch overflow-x-auto border-b border-border bg-bg-2">
              {tabs.open.map((path) => (
                <TabChip
                  key={path}
                  path={path}
                  isActive={tabs.active === path}
                  onActivate={() => tabs.setActive(path)}
                  onClose={() => tabs.closeTab(path)}
                />
              ))}
            </div>
          )}

          <section className="min-h-0 overflow-hidden">
            <EditorPanel
              path={tabs.active}
              jumpToLine={
                editor.pendingJump && editor.pendingJump.path === tabs.active
                  ? editor.pendingJump.line
                  : null
              }
              onJumpHandled={() => editor.setPendingJump(null)}
              breadcrumb={
                editor.caretLine != null ? breadcrumbFor(editor.outline, editor.caretLine) : []
              }
              onCaretChange={editor.setCaretLine}
              onBufferChange={editor.setActiveBuffer}
            />
          </section>
          <section
            className="min-h-0 overflow-hidden border-t border-border"
            style={{ display: workspace.terminalVisible ? undefined : "none" }}
            aria-hidden={!workspace.terminalVisible}
          >
            <TerminalPanel cwd={workspace.path} />
          </section>
        </div>
        {workspace.aiPanelVisible && (
          <>
            <AIPanelResizer width={workspace.aiPanelWidth} onChange={workspace.setAiPanelWidth} />
            <aside className="min-h-0 overflow-hidden border-l border-border">
              <AIPanel
                workspacePath={workspace.path}
                activePath={tabs.active}
                activeBuffer={editor.activeBuffer}
              />
            </aside>
          </>
        )}
      </div>
      <StatusBar
        workspacePath={workspace.path}
        activePath={tabs.active}
        caretLine={editor.caretLine}
        activeBuffer={editor.activeBuffer}
        terminalVisible={workspace.terminalVisible}
        onToggleTerminal={() => workspace.setTerminalVisible(!workspace.terminalVisible)}
      />
    </div>
  );
}

/** Thin vertical drag handle between the sidebar and the editor grid.
 *  On mousedown we capture pointer events at window scope so the drag
 *  survives the cursor leaving the 4-px handle width — without this
 *  the resize visibly snaps every time the user nudges too far. */
function SidebarResizer({
  width,
  onChange,
}: {
  width: number;
  onChange: (w: number) => void;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => onChange(startWidth + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div
      onMouseDown={onMouseDown}
      className="cursor-col-resize bg-border hover:bg-fg/40"
      title="Drag to resize sidebar"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

// FirstRunSplash removed in P25-2; /welcome now hosts the equivalent
// (and richer) onboarding UI.

/** Mirror of SidebarResizer, but for the right-side AI panel: drag
 *  inverts (clientX decreasing → width increasing). Same pattern of
 *  capturing pointer events at window scope so the drag survives the
 *  cursor leaving the 4-px handle. */
function AIPanelResizer({
  width,
  onChange,
}: {
  width: number;
  onChange: (w: number) => void;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => onChange(startWidth - (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div
      onMouseDown={onMouseDown}
      className="cursor-col-resize bg-border hover:bg-fg/40"
      title="Drag to resize the AI panel"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

function TabChip({
  path,
  isActive,
  onActivate,
  onClose,
}: {
  path: string;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const name = path.split("/").pop() || path;
  return (
    <div
      className={`group flex items-baseline gap-2 border-r border-border px-3 py-1 ${
        isActive ? "bg-bg" : "bg-bg-2 hover:bg-bg"
      }`}
    >
      <button
        type="button"
        onClick={onActivate}
        className="font-mono text-[11px] text-fg"
        title={path}
      >
        {name}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="text-[11px] text-fg-mute opacity-0 hover:text-fg group-hover:opacity-100"
        aria-label={`Close ${name}`}
        title="Close tab"
      >
        ×
      </button>
    </div>
  );
}
