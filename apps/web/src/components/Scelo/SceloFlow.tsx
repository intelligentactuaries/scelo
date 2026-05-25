// Macro layer of the Scelo brain: soft data → tools → hard data.
// The drill-down (per-node sub-flows) lands in a follow-up — this is the
// outermost view a user lands on.

import { useTheme } from "@/lib/theme";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  type Edge,
  MarkerType,
  type Node,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { ExportButton } from "./ExportScreen";
import { FlowControls } from "./FlowControls";
import { SceloNode, type SceloNodeData } from "./SceloNode";
import { useScelo } from "./sceloContext";

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
      <div className="min-h-0 flex-1">
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
      <div className="flex shrink-0 items-center gap-2 border-b border-primary/40 bg-primary/[0.05] px-3 py-1.5">
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
        <ExportButton stage="macro" variant="primary" label="export · whole pipeline" />
        <button
          type="button"
          onClick={endProject}
          title="end project · returns to quick exploration"
          className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-error hover:text-error"
        >
          end project
        </button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3 py-1.5">
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
            className="rounded border border-primary/60 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
          >
            create
          </button>
          <button
            type="button"
            onClick={() => {
              setNamePromptOpen(false);
              setDraftName("");
            }}
            className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-fg-dim"
          >
            cancel
          </button>
        </>
      ) : (
        <>
          <ExportButton stage="macro" variant="primary" label="export · whole pipeline" />
          <button
            type="button"
            onClick={() => setNamePromptOpen(true)}
            title="give this session a name to enable conversation memory"
            className="rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20"
          >
            + start project
          </button>
        </>
      )}
    </div>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
