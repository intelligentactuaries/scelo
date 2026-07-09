// useWorkspaceShell — controller for the /workspace route.
//
// Routes/Workspace.tsx is the layout owner (header strip, three-pane
// grid, palette overlays). This hook owns everything else:
//   * open tabs + active tab state + persistence
//   * sidebar selection
//   * caret line, outline tree, active buffer
//   * pendingJump deep-link plumbing
//   * Cmd/Ctrl-P / -T / -Shift-P keyboard shortcuts + modal state
//   * documentSymbol fetch (on-open + debounced periodic refresh)
//   * LSP setRoot on workspace change
//   * palette command registry (with symbol entries for the active file)
//
// Returning a single big object is intentional: the consumer is exactly
// one component, and the alternative — many separate hooks each with
// their own ceremony — would push more code into the route component.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaletteCommand } from "../components/workspace/CommandPalette";
import type { OutlineNode } from "../components/workspace/OutlinePanel";
import { emitAiPrompt, subscribeOpenAiPanel } from "./aiPanelBus";
import { resetDiagnostics } from "./diagnosticsBus";
import { getEditorSelection } from "./editorSelectionBus";
import { emitToggleViewer } from "./editorViewerBus";
import { ensureGitPolling, refreshGit, resetGitStatus } from "./gitBus";
import { clearAllDrafts } from "./inputDrafts";
import { getLspClient } from "./lspClient";
import { isDesktopIDE } from "./sceloIDE";
// swarmBus events are no longer consumed here (/swarm is a dedicated
// route); urlFor is only used to advertise the swarm address in the
// palette so the shown port can't drift from the one SwarmPanel probes.
import { urlFor } from "./swarmBus";
import { enqueueTerminalCommand, shellQuote } from "./terminalBus";
import { emitToast } from "./toastBus";

export type SidebarTab =
  | "files"
  | "search"
  | "outline"
  | "git"
  | "problems"
  | "tests"
  | "swarm"
  // The IDE-wide global workspace: the small set of nameable, causally-validated
  // facts currently in play across the pipeline (surfaced as "facts").
  | "workspace";

export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 600;

export const AI_PANEL_WIDTH_DEFAULT = 360;
export const AI_PANEL_WIDTH_MIN = 240;
export const AI_PANEL_WIDTH_MAX = 700;

export interface PendingJump {
  path: string;
  line: number;
}

// Host:port the swarm UI actually runs on, as shown in the palette's
// "Open Swarm" entry. Derived from swarmBus's canonical URL rather
// than hardcoded so the advertised port can't drift from the real one.
const SWARM_UI_HOST = urlFor({}).replace(/^https?:\/\//, "");

export interface WorkspaceShell {
  /** Open tabs + active tab + their mutators. */
  tabs: {
    open: string[];
    active: string | null;
    setActive: (path: string | null) => void;
    openFile: (path: string) => void;
    closeTab: (path: string) => void;
  };
  /** Active workspace path + sidebar layout. Persisted per-workspace. */
  workspace: {
    path: string | null;
    setPath: (path: string | null) => void;
    sidebarTab: SidebarTab;
    setSidebarTab: (tab: SidebarTab) => void;
    /** Sidebar width in px. Clamped to [180, 600] on render so a
     *  restored value can't produce a sidebar wider than the window. */
    sidebarWidth: number;
    setSidebarWidth: (width: number) => void;
    /** Whether the right-side AI panel is visible. Persisted. */
    aiPanelVisible: boolean;
    setAiPanelVisible: (open: boolean) => void;
    /** Width in px of the AI panel. Clamped to [240, 700]. */
    aiPanelWidth: number;
    setAiPanelWidth: (width: number) => void;
    /** Whether the bottom terminal panel is visible. Persisted. The
     *  session stays alive in the background when hidden, so long-
     *  running processes (dev servers, training jobs) keep going.
     *  Toggle via Ctrl-` (VS Code convention). */
    terminalVisible: boolean;
    setTerminalVisible: (open: boolean) => void;
  };
  /** Editor-driven state that other panels read (outline, breadcrumb,
   *  palette previews). */
  editor: {
    caretLine: number | null;
    setCaretLine: (line: number | null) => void;
    outline: OutlineNode[];
    setOutline: (nodes: OutlineNode[]) => void;
    activeBuffer: string;
    setActiveBuffer: (text: string) => void;
    pendingJump: PendingJump | null;
    setPendingJump: (jump: PendingJump | null) => void;
  };
  /** Cmd+P / Cmd+T / Cmd+Shift+P modal open-state + the command list
   *  the latter renders. */
  palettes: {
    quickOpen: boolean;
    setQuickOpen: (open: boolean) => void;
    symbol: boolean;
    setSymbol: (open: boolean) => void;
    command: boolean;
    setCommand: (open: boolean) => void;
    commands: PaletteCommand[];
  };
}

export function useWorkspaceShell(): WorkspaceShell {
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files");
  const [sidebarWidth, setSidebarWidthRaw] = useState<number>(SIDEBAR_WIDTH_DEFAULT);
  const setSidebarWidth = useCallback((w: number) => {
    setSidebarWidthRaw(Math.min(Math.max(w, SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MAX));
  }, []);
  const [aiPanelVisible, setAiPanelVisible] = useState<boolean>(false);
  const [aiPanelWidth, setAiPanelWidthRaw] = useState<number>(AI_PANEL_WIDTH_DEFAULT);
  // Terminal hidden by default : keeps shell sessions alive in the
  // background (see TerminalPanel render gate in Workspace.tsx — we
  // use display:none rather than unmount) but gives the editor /
  // dashboard area its full vertical space. Ctrl-` brings it up.
  const [terminalVisible, setTerminalVisible] = useState<boolean>(false);
  const setAiPanelWidth = useCallback((w: number) => {
    setAiPanelWidthRaw(Math.min(Math.max(w, AI_PANEL_WIDTH_MIN), AI_PANEL_WIDTH_MAX));
  }, []);
  // aiPanelBus.emitOpenAiPanel (from Cmd-Shift-A, Cmd-L, the palette,
  // and "Send selection") always SHOWS the panel; explicit toggle goes
  // through the palette / shortcut instead.
  useEffect(() => subscribeOpenAiPanel(() => setAiPanelVisible(true)), []);
  // The swarm is no longer a sidebar tab — it's a full-window /swarm
  // route. The workspace shell doesn't react to openInSwarm anymore;
  // HardDataWorkstation navigates straight to /swarm and the route
  // reads getLastSwarmRequest() on mount to point the iframe.
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [symbolPalette, setSymbolPalette] = useState(false);
  const [commandPalette, setCommandPalette] = useState(false);
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [activeBuffer, setActiveBuffer] = useState<string>("");
  // Memoisation key for the periodic documentSymbol refresh: a stable
  // 32-bit hash of "file path + buffer content + lang". When the
  // debounce timer fires and the key matches what we last fetched, we
  // skip the LSP round-trip. Resets on file switch (path changes →
  // hash changes naturally) so we always re-fetch fresh for a new file.
  const lastFetchedRef = useRef<{ key: string; at: number } | null>(null);
  const navigate = useNavigate();

  // ── Keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        runCurrentFileRef.current?.();
        return;
      }
      // Ctrl-` (Ctrl + backtick) : VS Code's terminal toggle.
      // No platform-flip to Cmd here — VS Code keeps Ctrl-` on macOS
      // too, so we match.
      if (e.key === "`" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setTerminalVisible((v) => !v);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey) {
        if (k === "p") {
          e.preventDefault();
          setCommandPalette(true);
        } else if (k === "v") {
          e.preventDefault();
          emitToggleViewer();
        } else if (k === "a") {
          e.preventDefault();
          setAiPanelVisible((v) => !v);
        }
        return;
      }
      if (k === "p") {
        e.preventDefault();
        setQuickOpen(true);
      } else if (k === "t") {
        e.preventDefault();
        setSymbolPalette(true);
      } else if (k === "l") {
        e.preventDefault();
        sendSelectionToAi();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // F5 fires from a global listener that doesn't see fresh state on
  // every render; route it through a ref so the *current* `activeTab`
  // is read at call time, not at handler bind time.
  const runCurrentFileRef = useRef<(() => void) | null>(null);

  // ── Tab persistence ───────────────────────────────────────────────
  // Hydration vs persistence: both effects depend on state that's
  // initialised to defaults. Without a guard, the persist effect fires
  // on mount with the defaults and overwrites the on-disk state BEFORE
  // hydration's stateGet reads it. The `hydratedRef` flag gates
  // stateSet until hydration has completed (or skipped because no IDE).
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!isDesktopIDE()) {
      hydratedRef.current = true;
      return;
    }
    (async () => {
      const cur = await window.scelo!.workspace.get();
      if (cur.id) {
        await window.scelo!.workspace.setForWindow(cur.id);
      }
      const s = await window.scelo!.workspace.stateGet();
      setOpenTabs(s.openTabs);
      setActiveTab(s.activeTab);
      if (s.sidebarTab) setSidebarTab(s.sidebarTab);
      if (typeof s.sidebarWidth === "number") setSidebarWidth(s.sidebarWidth);
      if (typeof s.aiPanelVisible === "boolean") setAiPanelVisible(s.aiPanelVisible);
      if (typeof s.aiPanelWidth === "number") setAiPanelWidth(s.aiPanelWidth);
      if (typeof s.terminalVisible === "boolean") setTerminalVisible(s.terminalVisible);
      hydratedRef.current = true;
    })();
  }, [setSidebarWidth, setAiPanelWidth]);

  useEffect(() => {
    if (!isDesktopIDE()) return;
    if (!hydratedRef.current) return;
    window.scelo!.workspace.stateSet({
      openTabs,
      activeTab,
      sidebarTab,
      sidebarWidth,
      aiPanelVisible,
      aiPanelWidth,
      terminalVisible,
    });
  }, [
    openTabs,
    activeTab,
    sidebarTab,
    sidebarWidth,
    aiPanelVisible,
    aiPanelWidth,
    terminalVisible,
  ]);

  // ── File-switch reset + initial documentSymbol fetch ─────────────
  useEffect(() => {
    setCaretLine(null);
    setOutline([]);
    setActiveBuffer("");
    lastFetchedRef.current = null; // new file ⇒ fresh memoisation
    if (!isDesktopIDE() || !activeTab) return;
    const lang = lspLangForPath(activeTab);
    if (!lang) return;
    let cancelled = false;
    const uri = `scelo://workspace/${activeTab.replace(/^\/+/, "")}`;
    getLspClient(lang)
      .request("textDocument/documentSymbol", { textDocument: { uri } })
      .then((result) => {
        if (cancelled) return;
        setOutline(parseSymbolsForWorkspace(result));
        lastFetchedRef.current = { key: outlineKey(activeTab, lang, ""), at: Date.now() };
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  // ── Periodic outline refresh (debounced 750 ms after last edit) ───
  //
  // Skipped when the (file, lang, buffer) triple has the same 32-bit
  // hash as the previous fetch. Cuts duplicate LSP calls when the user
  // pauses without typing (cursor moves don't change the buffer).
  useEffect(() => {
    if (!isDesktopIDE() || !activeTab) return;
    const lang = lspLangForPath(activeTab);
    if (!lang) return;
    const key = outlineKey(activeTab, lang, activeBuffer);
    if (lastFetchedRef.current?.key === key) return;
    const t = window.setTimeout(async () => {
      try {
        const uri = `scelo://workspace/${activeTab.replace(/^\/+/, "")}`;
        const result = await getLspClient(lang).request("textDocument/documentSymbol", {
          textDocument: { uri },
        });
        setOutline(parseSymbolsForWorkspace(result));
        lastFetchedRef.current = { key, at: Date.now() };
      } catch {
        // best-effort — on-open fetch is still the source of truth
      }
    }, 750);
    return () => window.clearTimeout(t);
  }, [activeTab, activeBuffer]);

  // ── LSP root tracking ─────────────────────────────────────────────
  useEffect(() => {
    if (!isDesktopIDE()) return;
    void getLspClient("python").setRoot(workspacePath);
    void getLspClient("r").setRoot(workspacePath);
  }, [workspacePath]);

  // ── Git status tracking ──────────────────────────────────────────
  // The gitBus owns the cached snapshot + the 30 s tick; we just kick
  // a refresh whenever the workspace changes, and discard the previous
  // workspace's snapshot so a stale repo doesn't render for a frame.
  useEffect(() => {
    if (!isDesktopIDE()) return;
    resetGitStatus();
    void refreshGit();
    ensureGitPolling();
  }, [workspacePath]);

  // ── Diagnostics carry-over ───────────────────────────────────────
  // Diagnostics are workspace-scoped; drop the previous workspace's
  // diagnostics on switch so the Problems panel doesn't keep showing
  // errors from a directory the user has left behind.
  useEffect(() => {
    resetDiagnostics();
  }, [workspacePath]);

  // F5 / "Run: Current File" — compose a shell command for the active
  // tab's extension and push it onto the terminalBus. The terminal
  // pane writes it to its long-lived shell, so the bundled python / R
  // (already on PATH) is what runs. Unsupported extensions get a
  // toast rather than silent failure.
  useEffect(() => {
    runCurrentFileRef.current = () => runCurrentFile(activeTab);
  }, [activeTab]);

  // ── Tab manipulators ──────────────────────────────────────────────
  const openFile = useCallback((path: string) => {
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setActiveTab(path);
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((tabs) => {
        const next = tabs.filter((t) => t !== path);
        if (activeTab === path) {
          setActiveTab(next[next.length - 1] ?? null);
        }
        return next;
      });
    },
    [activeTab],
  );

  // ── Palette commands ─────────────────────────────────────────────
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const bufferLines = activeBuffer ? activeBuffer.split("\n") : [];
    const symbolCmds: PaletteCommand[] = activeTab
      ? flattenOutline(outline).map((s) => {
          const previewLine = bufferLines[s.line] ?? "";
          const preview = previewLine.trim().slice(0, 80);
          return {
            id: `symbol.${activeTab}:${s.line}:${s.name}`,
            label: `Symbol: ${s.name}`,
            detail: preview
              ? `${preview}    · ${activeTab.split("/").pop() ?? activeTab}:${s.line + 1}`
              : `${activeTab.split("/").pop() ?? activeTab}:${s.line + 1}`,
            run: () => {
              if (!activeTab) return;
              setPendingJump({ path: activeTab, line: s.line + 1 });
            },
          };
        })
      : [];
    return [
      ...symbolCmds,
      {
        id: "file.openWorkspace",
        label: "File: Open Workspace…",
        detail: isMac() ? "⌘O" : "Ctrl+O",
        run: async () => {
          if (!isDesktopIDE()) return;
          const r = await window.scelo!.workspace.pick();
          if (r.path) setWorkspacePath(r.path);
        },
      },
      {
        id: "file.switchWorkspace",
        label: "Workspace: Switch Workspace…",
        detail: isMac() ? "⌘⇧O" : "Ctrl+Shift+O",
        run: () => navigate("/settings/workspaces"),
      },
      {
        id: "ai.providers",
        label: "AI: Open Providers Settings",
        run: () => navigate("/settings/ai"),
      },
      {
        id: "data.downloads",
        label: "Data: Open Downloads Settings",
        run: () => navigate("/settings/data"),
      },
      {
        id: "view.files",
        label: "View: Show File Tree",
        run: () => setSidebarTab("files"),
      },
      {
        id: "view.search",
        label: "View: Show Search",
        run: () => setSidebarTab("search"),
      },
      {
        id: "view.outline",
        label: "View: Show Outline",
        run: () => setSidebarTab("outline"),
      },
      {
        id: "view.git",
        label: "View: Show Source Control",
        run: () => setSidebarTab("git"),
      },
      {
        id: "view.problems",
        label: "View: Show Problems",
        run: () => setSidebarTab("problems"),
      },
      {
        id: "view.tests",
        label: "View: Show Tests",
        detail: "pytest + testthat discovery, run via the terminal",
        run: () => setSidebarTab("tests"),
      },
      {
        id: "view.workspace",
        label: "View: Show Workspace Facts",
        detail: "The global workspace: nameable, causally-validated facts in play",
        run: () => setSidebarTab("workspace"),
      },
      {
        id: "reset.drafts",
        label: "Reset: All IDE Drafts",
        detail: "Wipes AI panel, commit message, chat, and search drafts.",
        run: () => {
          const n = clearAllDrafts();
          emitToast(
            n === 0 ? "No drafts to clear." : `Cleared ${n} draft${n === 1 ? "" : "s"}.`,
            "info",
          );
        },
      },
      {
        id: "view.swarm",
        label: "Navigate: Open Swarm",
        detail: `Full-window council surface (${SWARM_UI_HOST})`,
        run: () => navigate("/swarm"),
      },
      {
        id: "view.terminal",
        label: "View: Toggle Terminal",
        detail: "Ctrl-` — session stays alive in the background when hidden",
        run: () => setTerminalVisible((v) => !v),
      },
      {
        id: "run.currentFile",
        label: "Run: Current File",
        detail: activeTab ? `${activeTab}  (F5)` : "no active file",
        run: () => runCurrentFile(activeTab),
      },
      {
        id: "view.toggleViewer",
        label: "View: Toggle Preview / Source",
        detail: "⌘⇧V — markdown preview, CSV table, notebook view",
        run: () => emitToggleViewer(),
      },
      {
        id: "ai.toggle",
        label: "AI: Toggle Workspace AI Panel",
        detail: "⌘⇧A — workspace-scoped chat with Apply-to-file",
        run: () => setAiPanelVisible((v) => !v),
      },
      {
        id: "ai.sendSelection",
        label: "AI: Send Selection to AI",
        detail: "⌘L — stages the current Monaco selection",
        run: () => sendSelectionToAi(),
      },
      {
        id: "navigate.scelo",
        label: "Navigate: Open Scelo Brain",
        run: () => navigate("/dashboards/scelo"),
      },
      {
        id: "navigate.runtimeCheck",
        label: "Navigate: Runtime Check",
        run: () => navigate("/runtime-check"),
      },
      {
        id: "help.welcome",
        label: "Help: Open Welcome Page",
        detail: "Recent workspaces, sample scaffolds, quick actions",
        run: () => navigate("/welcome"),
      },
      {
        id: "editor.formatDocument",
        label: "Editor: Format Document",
        detail: "via LSP",
        run: () => {
          // The editor's keybinding for "editor.action.formatDocument"
          // fires the LSP formatting flow we already register; surfaced
          // here for discoverability.
          if (typeof document !== "undefined") {
            const ev = new KeyboardEvent("keydown", {
              key: "F",
              code: "KeyF",
              shiftKey: true,
              altKey: true,
              bubbles: true,
            });
            document.activeElement?.dispatchEvent(ev);
          }
        },
      },
    ];
  }, [navigate, activeTab, outline, activeBuffer]);

  return {
    tabs: {
      open: openTabs,
      active: activeTab,
      setActive: setActiveTab,
      openFile,
      closeTab,
    },
    workspace: {
      path: workspacePath,
      setPath: setWorkspacePath,
      sidebarTab,
      setSidebarTab,
      sidebarWidth,
      setSidebarWidth,
      aiPanelVisible,
      setAiPanelVisible,
      aiPanelWidth,
      setAiPanelWidth,
      terminalVisible,
      setTerminalVisible,
    },
    editor: {
      caretLine,
      setCaretLine,
      outline,
      setOutline,
      activeBuffer,
      setActiveBuffer,
      pendingJump,
      setPendingJump,
    },
    palettes: {
      quickOpen,
      setQuickOpen,
      symbol: symbolPalette,
      setSymbol: setSymbolPalette,
      command: commandPalette,
      setCommand: setCommandPalette,
      commands: paletteCommands,
    },
  };
}

// ── helpers (kept private to the hook) ────────────────────────────

function lspLangForPath(p: string): "python" | "r" | null {
  const l = p.toLowerCase();
  if (l.endsWith(".py")) return "python";
  if (l.endsWith(".r")) return "r";
  return null;
}

/** Stage the current Monaco selection in the AI panel as a fenced
 *  code block, with the source file path as a header. The panel opens
 *  itself when the prompt event arrives (`emitAiPrompt` calls
 *  `emitOpenAiPanel` internally). Toast-and-noop when there's no
 *  selection so the keybinding feels responsive rather than mysterious. */
function sendSelectionToAi(): void {
  const sel = getEditorSelection();
  if (!sel || !sel.text.trim()) {
    emitToast("Select some text in the editor first (Cmd-L).", "info");
    return;
  }
  const lang = sel.language ?? "";
  const text = `From ${sel.path}:\n\n\`\`\`${lang}\n${sel.text}\n\`\`\`\n\n`;
  emitAiPrompt({ text, autoSend: false });
}

/** Compose a shell command that runs `relPath` with the right
 *  interpreter and push it onto the terminalBus. Unsupported
 *  extensions surface as a toast rather than silent failure. */
function runCurrentFile(relPath: string | null): void {
  if (!relPath) {
    emitToast("Open a file first.", "info");
    return;
  }
  const l = relPath.toLowerCase();
  let cmd: string | null = null;
  if (l.endsWith(".py")) {
    cmd = `python ${shellQuote(relPath)}`;
  } else if (l.endsWith(".r")) {
    cmd = `Rscript ${shellQuote(relPath)}`;
  }
  if (!cmd) {
    emitToast(
      `Run only supports .py and .R files; ${relPath.split("/").pop()} is neither.`,
      "info",
    );
    return;
  }
  enqueueTerminalCommand(cmd);
}

/** Stable 32-bit hash of `${path}|${lang}|${buffer}`. djb2 is fine here
 *  — we only need collision-resistance vs. consecutive identical
 *  fetches, not cryptographic strength. */
function outlineKey(path: string, lang: string, buffer: string): string {
  const s = `${path}|${lang}|${buffer}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h |= 0;
  }
  return `${path}|${lang}|${h.toString(36)}`;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (level: OutlineNode[]) => {
    for (const n of level) {
      out.push(n);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function parseSymbolsForWorkspace(result: unknown): OutlineNode[] {
  if (!Array.isArray(result)) return [];
  const first = result[0] as Record<string, unknown> | undefined;
  if (!first || !("range" in first)) return [];
  type Wire = {
    name: string;
    kind: number;
    detail?: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    selectionRange?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    children?: Wire[];
  };
  const walk = (d: Wire): OutlineNode => ({
    name: d.name,
    kind: d.kind,
    detail: d.detail,
    line: (d.selectionRange ?? d.range).start.line,
    range: { startLine: d.range.start.line, endLine: d.range.end.line },
    children: (d.children ?? []).map(walk),
  });
  return (result as Wire[]).map(walk);
}
