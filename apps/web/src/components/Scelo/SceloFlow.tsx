// Macro layer of the Scelo brain: soft data → tools → hard data.
// The drill-down (per-node sub-flows) lands in a follow-up — this is the
// outermost view a user lands on.

import { useTheme } from "@/lib/theme";
import { type ChangeEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  type Edge,
  MarkerType,
  type Node,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { Link } from "react-router-dom";
import { ExportButton } from "./ExportScreen";
import { FlowControls } from "./FlowControls";
import { SceloNode, type SceloNodeData, SceloNodeHeights } from "./SceloNode";
import { nextPaint } from "./UploadIndicator";
import { downloadSce, parseSce } from "./projectFile";
import { clearSceloSession, useScelo } from "./sceloContext";

const nodeTypes = { scelo: SceloNode };

const NODES: Node<SceloNodeData>[] = [
  {
    id: "soft",
    type: "scelo",
    position: { x: 0, y: 0 },
    data: {
      stage: "soft",
      title: "Upload data",
      subtitle: "What we cannot see, or cannot easily decide on.",
    },
  },
  {
    id: "tools",
    type: "scelo",
    position: { x: 380, y: 0 },
    data: {
      stage: "tools",
      title: "Select models",
      subtitle: "Statistical & actuarial tools that turn soft into hard.",
    },
  },
  {
    id: "hard",
    type: "scelo",
    position: { x: 760, y: 0 },
    data: {
      stage: "hard",
      title: "Outcome",
      subtitle: "Processed, board-pack-ready numbers.",
    },
  },
];

function makeEdges(stroke: string): Edge[] {
  // One-way left-to-right. Tools is the only node connected on both sides.
  const marker = { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 };
  return [
    {
      id: "soft->tools",
      source: "soft",
      target: "tools",
      label: "intake",
      markerEnd: marker,
      style: { stroke, strokeWidth: 1.5 },
      labelStyle: { fill: stroke, fontFamily: "'SN Pro', 'Inter', sans-serif", fontSize: 10 },
      labelBgStyle: { fill: "rgb(var(--rgb-bg-1))" },
    },
    {
      id: "tools->hard",
      source: "tools",
      target: "hard",
      label: "compute",
      markerEnd: marker,
      style: { stroke, strokeWidth: 1.5 },
      labelStyle: { fill: stroke, fontFamily: "'SN Pro', 'Inter', sans-serif", fontSize: 10 },
      labelBgStyle: { fill: "rgb(var(--rgb-bg-1))" },
    },
  ];
}

export function SceloFlow({ className }: { className?: string }) {
  const { resolved } = useTheme();
  // Palette aligned with the cream/charcoal app theme. Hex strings (not
  // CSS vars) so React Flow's SVG inline-style render is bulletproof
  // across browsers. Edge label backgrounds use the CSS var --rgb-bg-1
  // directly (see makeEdges) so they track theme switches without a re-mount.
  const palette =
    resolved === "light"
      ? {
          panelBg: "#f2eee2",
          panelBorder: "#cdc7b8",
          edge: "#8a8476",
        }
      : {
          panelBg: "#221e1a",
          panelBorder: "#423a31",
          edge: "#746c60",
        };

  const computedEdges = useMemo(() => makeEdges(palette.edge), [palette.edge]);

  // Controlled state — without `onNodesChange` React Flow has no callback
  // for drag updates and the node snaps back to its prop position on every
  // render. `useNodesState` provides exactly that wiring.
  const [nodes, , onNodesChange] = useNodesState(NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(computedEdges);

  // Edges depend on the theme palette — re-sync when it switches.
  useEffect(() => {
    setEdges(computedEdges);
  }, [computedEdges, setEdges]);

  return (
    <div className={`${className ?? ""} flex flex-col`}>
      <ProjectBar />
      {/* data-intro: the launch intro reveals the bar, then the canvas. */}
      <div data-intro="2" className="min-h-0 flex-1">
        <SceloNodeHeights>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.4}
            maxZoom={1.6}
            nodesConnectable={false}
            nodesDraggable={true}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
          >
            <FlowControls />
          </ReactFlow>
        </SceloNodeHeights>
      </div>
    </div>
  );
}

// Mode banner at the top of the macro view. Switches between two states:
//
//   • explore (default) — a "quick exploration" strip with a primary-styled
//     `Start project` button that reveals an inline name input. Submitting
//     the name flips mode to `project` and the conversation memory in every
//     chatbar across Scelo lights up.
//   • project           — shows the project name + "started X ago" and an
//     `End project` button. Ending project returns to explore mode (chat
//     memory is preserved in localStorage in case the user re-creates the
//     project later, but new chats won't see it because the project id is
//     freshly generated).
// Save / open the whole session as a .sce file. Rendered in both project and
// explore modes next to the export button. Save is disabled with nothing
// loaded; open replaces the current session (after a confirm if one exists).
function ProjectFileActions() {
  const { dataset, project, snapshotSession, restoreSession } = useScelo();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which file action is in flight. Serialising / parsing a session with a
  // full dataset in it is a several-second synchronous JSON pass — the only
  // feedback used to be the "saved …" flash AFTER the freeze ended.
  const [busy, setBusy] = useState<"save" | "open" | null>(null);

  const flash = (kind: "ok" | "err", text: string) => {
    setNote({ kind, text });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), kind === "ok" ? 3500 : 6000);
  };

  const onSave = async () => {
    if (busy) return;
    setBusy("save");
    // Paint the busy label before the synchronous stringify blocks the tab.
    await nextPaint();
    try {
      const { filename } = downloadSce(snapshotSession(), project, dataset?.name ?? null);
      flash("ok", `saved ${filename}`);
    } catch (e) {
      flash("err", `save failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onOpen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = ""; // allow re-picking the same file
    if (!file || busy) return;
    if (dataset && !window.confirm("Open this project? It will replace your current session.")) {
      return;
    }
    setBusy("open");
    try {
      const text = await file.text();
      // The parse + restore are synchronous from here — make sure the
      // "opening…" label has painted before they block.
      await nextPaint();
      const { session, project: proj } = parseSce(text);
      restoreSession(session, proj);
      flash("ok", `opened ${file.name}${proj ? ` · ${proj.name}` : ""}`);
    } catch (err) {
      flash("err", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {note && (
        <span
          className={`max-w-[40ch] truncate font-mono text-[10px] ${
            note.kind === "ok" ? "text-primary" : "text-error"
          }`}
          title={note.text}
        >
          {note.text}
        </span>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".sce,application/vnd.scelo.project+json,application/json"
        className="hidden"
        onChange={onOpen}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy !== null}
        title="Open a saved .sce project file (replaces the current session)"
        className="ia-tool-btn py-0.5 text-[10px] uppercase tracking-wider disabled:cursor-wait"
      >
        {busy === "open" && (
          <span
            aria-hidden
            className="ia-pip ia-load-pip"
            style={{ background: "rgb(var(--rgb-primary))" }}
          />
        )}
        {busy === "open" ? "opening…" : "open .sce"}
      </button>
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={!dataset || busy !== null}
        title={
          dataset
            ? "Save the whole session (data, filters, model picks, runs) to a .sce project file"
            : "Load a dataset first — there's nothing to save yet"
        }
        className="ia-tool-btn py-0.5 text-[10px] uppercase tracking-wider"
      >
        {busy === "save" && (
          <span
            aria-hidden
            className="ia-pip ia-load-pip"
            style={{ background: "rgb(var(--rgb-primary))" }}
          />
        )}
        {busy === "save" ? "saving…" : "save .sce"}
      </button>
    </>
  );
}

function ProjectBar() {
  const { mode, project, startProject, endProject } = useScelo();
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (namePromptOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [namePromptOpen]);

  const submitName = () => {
    const n = draftName.trim();
    if (!n) return;
    startProject(n);
    setDraftName("");
    setNamePromptOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitName();
    } else if (e.key === "Escape") {
      setNamePromptOpen(false);
      setDraftName("");
    }
  };

  if (mode === "project" && project) {
    return (
      <div
        data-intro="1"
        className="flex shrink-0 items-center gap-2 border-b border-primary/40 px-3 py-1.5"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
          title="project mode"
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary">project</span>
        <span className="truncate font-mono text-xs text-fg">{project.name}</span>
        <span className="font-mono text-[10px] text-fg-dim">
          · started {formatRelative(project.createdAt)}
        </span>
        <span className="font-mono text-[10px] text-fg-dim">· chats persist</span>
        <div className="flex-1" />
        <WorkspaceLink />
        <ProjectFileActions />
        <ExportButton stage="macro" variant="primary" label="export · whole pipeline" />
        <button
          type="button"
          onClick={endProject}
          title="end project · returns to quick exploration"
          className="ia-tool-btn ia-tool-btn-danger py-0.5 text-[10px] uppercase tracking-wider"
        >
          end project
        </button>
        <ResetSessionButton />
      </div>
    );
  }

  return (
    <div
      data-intro="1"
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-fg-dim" />
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        quick exploration
      </span>
      <span className="font-mono text-[10px] text-fg-dim">
        · chats won't persist across reloads
      </span>
      <div className="flex-1" />
      {namePromptOpen ? (
        <>
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={onKey}
            placeholder="project name…"
            className="w-48 rounded border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-fg placeholder:text-fg-dim focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            onClick={submitName}
            disabled={!draftName.trim()}
            className="ia-tool-btn ia-tool-btn-cta py-0.5 text-[10px] uppercase tracking-wider"
          >
            create
          </button>
          <button
            type="button"
            onClick={() => {
              setNamePromptOpen(false);
              setDraftName("");
            }}
            className="ia-tool-btn py-0.5 text-[10px] uppercase tracking-wider"
          >
            cancel
          </button>
        </>
      ) : (
        <>
          <WorkspaceLink />
          <ProjectFileActions />
          <ExportButton stage="macro" variant="primary" label="export · whole pipeline" />
          <button
            type="button"
            onClick={() => setNamePromptOpen(true)}
            title="give this session a name to enable conversation memory"
            className="ia-tool-btn ia-tool-btn-cta py-0.5 text-[10px] uppercase tracking-wider"
          >
            + start project
          </button>
          <ResetSessionButton />
        </>
      )}
    </div>
  );
}

// The workspace (files, editor, terminal), one click from the pipeline.
function WorkspaceLink() {
  return (
    <Link
      to="/workspace"
      title="Open the workspace: files, editor and terminal"
      className="ia-tool-btn py-0.5 text-[10px] uppercase tracking-wider"
    >
      workspace
    </Link>
  );
}

/** Wipe the working session. It otherwise auto-persists everything (dataset,
 *  filters, model picks, runs, derived columns, events) across navigation
 *  and reloads; this is the only thing that drops it, so it confirms inline. */
function ResetSessionButton() {
  const {
    setDataset,
    setFilters,
    setSelectedModels,
    setDomain,
    setPickSummary,
    setRuns,
    setDerivedColumns,
    setTransformLog,
    clearEvents,
  } = useScelo();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Wipe dataset, filters, model picks, runs, derived columns, and the activity log."
        className="ia-tool-btn ia-tool-btn-danger py-0.5 text-[10px] uppercase tracking-wider"
      >
        reset session
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <span className="px-1 font-mono text-[10px] text-fg">wipe all scelo work?</span>
      <button
        type="button"
        onClick={() => {
          setDataset(null);
          setFilters([]);
          setSelectedModels([]);
          setDomain(null);
          setPickSummary(null);
          setRuns({});
          setDerivedColumns({});
          setTransformLog(new Set());
          clearEvents();
          clearSceloSession();
          setConfirming(false);
        }}
        className="ia-tool-btn ia-tool-btn-danger py-0.5 text-[10px] uppercase tracking-wider"
      >
        yes, reset
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="ia-tool-btn py-0.5 text-[10px] uppercase tracking-wider"
      >
        cancel
      </button>
    </span>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
