// Tools drill-in. Layout:
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │ ← macro · tools · workstation                  [identify] [regen]   │
//   ├─────────────────────────────────────────────────────────────────────┤
//   │ working with: claims_sample · 64 rows · 10 cols    domain: reserving│
//   ├──────────────────────────────────────────────────┬──────────────────┤
//   │                                                  │ model details   │
//   │   React Flow canvas — hub-and-spoke              │                 │
//   │                                                  │ rationale       │
//   │       [Mack]                                     │ description     │
//   │          \                                       │ toggle / remove │
//   │   [CL] ──[DATASET HUB]── [BF]                    │ + add from cat. │
//   │          /                                       │                 │
//   │       [Bootstrap]                                │                 │
//   │                                                  │                 │
//   ├──────────────────────────────────────────────────┴──────────────────┤
//   │ Scelo · tools chatbar (dataset + picks in context)                  │
//   └─────────────────────────────────────────────────────────────────────┘
//
// The hub displays the dataset shape and identified domain. Model nodes are
// arranged in a circle around the hub. Each model node is toggleable; the
// edge to the hub is animated when the model is selected.

import ReactECharts from "echarts-for-react";
import { BoxplotChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  Background,
  type Connection,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowInstance,
  useEdges,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { useTheme } from "@/lib/theme";
import { ChatInputPill } from "./ChatInputPill";
import { ExportButton } from "./ExportScreen";
import { FlowControls } from "./FlowControls";
import { RemovableEdge } from "./RemovableEdge";
import { ResizablePanel } from "./ResizablePanel";
import {
  type ColumnMeta,
  type Dataset,
  formatNumber,
  summariseDataset,
} from "./SoftDataWorkstation";
import { StageChatPanel } from "./StageChatPanel";
import {
  type CatalogModel,
  FAMILY_COLOR_DARK,
  FAMILY_COLOR_LIGHT,
  MODEL_BY_ID,
  MODEL_CATALOG,
  type ModelFamily,
} from "./modelCatalog";
import { type DataSignature, dataSignature, fetchModelPicks, heuristicPick } from "./modelPicker";
import { type SelectedModel, useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

// ECharts is tree-shakable — only register the pieces this workstation needs.
// `echarts.use` is idempotent so re-registering across workstations is safe.
echarts.use([TooltipComponent, GridComponent, BoxplotChart, ScatterChart, CanvasRenderer]);

// ── React Flow node definitions ──────────────────────────────────────────────

// Compact, collapsible chatbot rendered inside each canvas node. Each instance
// owns its own thread (via useNodeChat) so the hub's "suggest the mix" thread
// stays separate from any individual model's "why pick me" thread.
function NodeChatbotPanel({
  stageContext,
  placeholder,
  accentColor,
  chatId,
}: {
  stageContext: string;
  placeholder: string;
  accentColor?: string;
  // Stable identifier for this chat instance — combined with the active
  // project id (if any) to form the memoryKey. Memory is off when no project.
  chatId: string;
}) {
  const { chatMemoryPrefix } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:${chatId}` : undefined;
  const { messages, isStreaming, send, stop } = useNodeChat(stageContext, { memoryKey });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    void send(text);
  };

  const focusRing = accentColor ?? "rgb(var(--rgb-primary))";

  return (
    <div
      className="mt-2 flex flex-col gap-2 border-t border-border/70 pt-2"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="nodrag nowheel scrollbar-none max-h-28 overflow-auto rounded-xl bg-bg/60 p-2 text-[10px] leading-snug"
        >
          {messages.map((m) => (
            <div key={m.id} className="mb-1 last:mb-0">
              <span
                className="mr-1 font-mono text-[8px] uppercase tracking-[0.15em] text-fg-dim"
                style={m.role === "assistant" ? { color: focusRing } : undefined}
              >
                {m.role === "user" ? "you" : "scelo"}
              </span>
              <span className="whitespace-pre-wrap text-fg">
                {m.content || (m.role === "assistant" && isStreaming ? "…" : "")}
              </span>
            </div>
          ))}
        </div>
      )}
      <ChatInputPill
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        onStop={stop}
        isStreaming={isStreaming}
        placeholder={placeholder}
        rows={1}
        size="xs"
      />
    </div>
  );
}

type HubNodeData = {
  dataset: Dataset;
  domain: ModelFamily | null;
  selectedCount: number;
  // Number of handle slots to render on each side. Should equal the total
  // node count in the canvas (hub + selected models) so as soon as a new
  // model joins, every existing node grows a new port pair to receive or
  // send an edge from/to it.
  slotCount: number;
  chatContext: string;
  chatPlaceholder: string;
};

// Front-and-back handle pack with one slot pair per node in the canvas.
// `count` is the total number of nodes currently in play (hub + selected
// models). Each node renders `count` slot pairs distributed evenly down
// the LEFT side (back / incoming) and the RIGHT side (front / outgoing),
// so as soon as a second model joins the canvas every existing node
// grows a second port on each side — ready to be wired by the actuary
// without crowding the first port.
//
// Each "slot" is actually a target + source handle co-located at the
// same y-offset; React Flow distinguishes them by stable id, the user
// sees one dot per slot.
//
// Naming: `s-<side>-<i>` for source, `t-<side>-<i>` for target.
function MultiHandles({
  nodeId,
  color,
  count,
}: {
  nodeId: string;
  color: string;
  count: number;
}) {
  // Subscribe to the live edge list so each handle can fill itself when
  // an edge is attached to it (and hollow out when the edge is removed).
  // The visual treatment is per-side, per-slot: a single dot is shown
  // on each side for each slot index, and that dot turns solid if any
  // edge — source or target, drawn or default — uses either of the
  // co-located handles at that slot.
  const edges = useEdges();
  const n = Math.max(1, count);
  const slots = Array.from({ length: n }, (_, i) => i);
  return (
    <>
      {slots.map((i) => {
        // Centre each slot in its share of the side. For n=1 the slot
        // lives at 50% (midline); for n=2 they're at 25% and 75%; etc.
        const top = `${((i + 0.5) / n) * 100}%`;
        const leftConnected = edges.some(
          (e) =>
            (e.target === nodeId && e.targetHandle === `t-left-${i}`) ||
            (e.source === nodeId && e.sourceHandle === `s-left-${i}`),
        );
        const rightConnected = edges.some(
          (e) =>
            (e.target === nodeId && e.targetHandle === `t-right-${i}`) ||
            (e.source === nodeId && e.sourceHandle === `s-right-${i}`),
        );
        // Hollow when nothing is plugged in (canvas bg fills the disc,
        // family-coloured ring around it); solid family colour once a
        // wire lands. The ring stays the same colour either way so the
        // family identity reads at a glance.
        const sideStyle = (connected: boolean) => ({
          top,
          width: 8,
          height: 8,
          opacity: 0.7,
          background: connected ? color : "rgb(var(--rgb-bg))",
          border: `1.5px solid ${color}`,
        });
        const leftStyle = sideStyle(leftConnected);
        const rightStyle = sideStyle(rightConnected);
        return (
          <Fragment key={i}>
            <Handle id={`t-left-${i}`} type="target" position={Position.Left} style={leftStyle} />
            <Handle id={`s-left-${i}`} type="source" position={Position.Left} style={leftStyle} />
            <Handle
              id={`t-right-${i}`}
              type="target"
              position={Position.Right}
              style={rightStyle}
            />
            <Handle
              id={`s-right-${i}`}
              type="source"
              position={Position.Right}
              style={rightStyle}
            />
          </Fragment>
        );
      })}
    </>
  );
}

function HubNode({ id, data }: NodeProps<HubNodeData>) {
  const [chatOpen, setChatOpen] = useState(false);
  return (
    <div
      className="glass-card w-[260px] rounded-lg p-3"
      style={{
        // Primary tint on the hub so the family-coloured spokes read as
        // converging on it. Inline border wins over the .glass-card hairline.
        borderColor: "rgb(var(--rgb-primary))",
        borderWidth: 2,
      }}
    >
      <MultiHandles nodeId={id} color="rgb(var(--rgb-primary))" count={data.slotCount} />
      <div className="font-mono text-[10px] uppercase tracking-wider text-primary">dataset hub</div>
      <div className="mt-0.5 truncate text-sm text-fg">{data.dataset.name}</div>
      <div className="mt-1 font-mono text-[11px] text-fg-mute">
        {data.dataset.rows.length} rows · {data.dataset.columns.length} cols
      </div>
      {data.domain && (
        <div className="mt-2 inline-block rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary">
          {data.domain}
        </div>
      )}
      <div className="mt-2 text-[11px] text-fg-dim">
        {data.selectedCount} model{data.selectedCount === 1 ? "" : "s"} attached
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setChatOpen((o) => !o);
        }}
        className="nodrag mt-2 inline-flex w-full items-center justify-between rounded border border-border bg-bg-2 px-1.5 py-1 font-mono text-[9px] uppercase tracking-wider text-fg-mute hover:border-primary hover:text-primary"
      >
        <span>{chatOpen ? "hide" : "ask"} scelo · hub</span>
        <span>{chatOpen ? "▾" : "▸"}</span>
      </button>
      {chatOpen && (
        <NodeChatbotPanel
          stageContext={data.chatContext}
          placeholder={data.chatPlaceholder}
          chatId="tools-hub"
        />
      )}
    </div>
  );
}

type ToolNodeData = {
  model: CatalogModel;
  selected: boolean;
  rationale?: string;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  // Swap from the current model id to a new model id — implementation
  // adds the new model and removes the old one in one render so the
  // user's canvas position survives the substitution.
  onReplace: (currentId: string, nextId: string) => void;
  isFocused: boolean;
  // Same as HubNodeData.slotCount — total node count in the canvas. Every
  // model node mirrors the hub's slot count so any pair of nodes has
  // matching back/front ports for hand-drawing edges.
  slotCount: number;
  chatContext: string;
  chatPlaceholder: string;
};

function ToolNode({ id, data }: NodeProps<ToolNodeData>) {
  const { resolved } = useTheme();
  const palette = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const color = palette[data.model.family];
  const dim = !data.selected;
  const [chatOpen, setChatOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);

  // Catalog grouped by family for the swap-picker. The current model is
  // skipped from its own family list — swapping to yourself is a no-op
  // and would just clutter the menu.
  const swapCandidates = useMemo(() => {
    const groups = new Map<ModelFamily, CatalogModel[]>();
    for (const m of MODEL_CATALOG) {
      if (m.id === data.model.id) continue;
      const arr = groups.get(m.family) ?? [];
      arr.push(m);
      groups.set(m.family, arr);
    }
    return Array.from(groups.entries());
  }, [data.model.id]);

  return (
    <div
      className={`glass-card w-[220px] rounded-md p-2 transition ${
        data.isFocused ? "ring-2 ring-primary" : ""
      }`}
      style={{
        // Family colour is data-bearing — inline `borderColor` wins over
        // the `.glass-card` 1px hairline so the model family stays legible.
        borderColor: color,
        borderWidth: 1,
        opacity: dim ? 0.55 : 1,
      }}
    >
      <MultiHandles nodeId={id} color={color} count={data.slotCount} />
      <div className="flex items-start justify-between gap-1">
        <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color }}>
          {data.model.family}
        </div>
        <div className="flex items-center gap-1">
          {/* swap — opens an inline menu of other catalog models */}
          <button
            type="button"
            aria-label="Replace this model"
            title="replace with another model"
            onClick={(e) => {
              e.stopPropagation();
              setSwapOpen((o) => !o);
            }}
            className={`nodrag flex h-4 w-4 items-center justify-center rounded border font-mono text-[10px] leading-none ${
              swapOpen
                ? "border-primary text-primary"
                : "border-border text-fg-dim hover:border-fg-dim hover:text-fg-mute"
            }`}
          >
            ↻
          </button>
          {/* enable/disable toggle — tinted with the node's family colour
              when selected so the switch reads as part of the node, not as
              a generic primary-green control. */}
          <button
            type="button"
            aria-label={data.selected ? "Disable model" : "Enable model"}
            title={data.selected ? "click to disable" : "click to enable"}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle(data.model.id);
            }}
            className={`nodrag h-3.5 w-7 rounded-full border ${
              data.selected ? "" : "border-border bg-bg-2"
            }`}
            style={
              data.selected
                ? { borderColor: color, background: `${color}4d` /* ~30% alpha */ }
                : undefined
            }
          >
            <span
              className={`block h-3 w-3 rounded-full transition-transform ${
                data.selected ? "translate-x-3" : "translate-x-0 bg-fg-dim"
              }`}
              style={data.selected ? { background: color } : undefined}
            />
          </button>
          {/* remove — drops the node off the canvas */}
          <button
            type="button"
            aria-label="Remove this model from the canvas"
            title="remove (or press Backspace with this node selected)"
            onClick={(e) => {
              e.stopPropagation();
              data.onRemove(data.model.id);
            }}
            className="nodrag flex h-4 w-4 items-center justify-center rounded-full border border-border bg-bg text-fg-dim hover:border-error hover:text-error"
          >
            ×
          </button>
        </div>
      </div>
      <div className="mt-0.5 text-xs text-fg">{data.model.name}</div>
      <p className="mt-1 line-clamp-2 text-[10px] text-fg-mute">
        {data.rationale ?? data.model.description}
      </p>

      {swapOpen && (
        <div
          className="nodrag nowheel mt-1.5 max-h-44 overflow-auto rounded-xl border border-border bg-bg-1 p-1.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-fg-dim">
            replace with…
          </div>
          {swapCandidates.map(([family, models]) => (
            <div key={family} className="mb-1.5 last:mb-0">
              <div className="font-mono text-[8px] uppercase tracking-wider text-fg-dim">
                {family}
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {models.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSwapOpen(false);
                        data.onReplace(data.model.id, m.id);
                      }}
                      className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-fg-mute hover:bg-bg-2 hover:text-fg"
                    >
                      {m.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setChatOpen((o) => !o);
        }}
        className="nodrag mt-1.5 inline-flex w-full items-center justify-between rounded border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-mute hover:text-fg"
        style={{
          borderColor: chatOpen ? color : undefined,
          color: chatOpen ? color : undefined,
        }}
      >
        <span>{chatOpen ? "hide" : "ask"} scelo</span>
        <span>{chatOpen ? "▾" : "▸"}</span>
      </button>
      {chatOpen && (
        <NodeChatbotPanel
          stageContext={data.chatContext}
          placeholder={data.chatPlaceholder}
          accentColor={color}
          chatId={`tools-model:${data.model.id}`}
        />
      )}
    </div>
  );
}

const NODE_TYPES = { hub: HubNode, tool: ToolNode };
// All edges in this workstation use the removable type — gives every
// connection a click-to-disconnect × at its midpoint.
const EDGE_TYPES = { removable: RemovableEdge };

// Hub + tool node dimensions (px). Kept here so the layout math centres each
// node exactly on its slot — half-width / half-height offsets turn a "place
// node centre at (x, y)" instruction into the top-left position React Flow
// actually expects.
const HUB_W = 260;
const HUB_H = 150;
const TOOL_W = 220;
const TOOL_H = 100;

// Lay model nodes out in a vertical column to the right of the hub. The
// column is centred on the hub's vertical midline so the spread feels
// balanced regardless of how many models are attached.
//
//    [ HUB ]   [ model 1 ]
//              [ model 2 ]
//              [ model 3 ]
//
// Returns the *centre* of each tool node — callers offset by -W/2 / -H/2 to
// get the top-left position.
function columnLayout(n: number): Array<{ x: number; y: number }> {
  if (n === 0) return [];
  const horizontalGap = 160;
  const verticalGap = TOOL_H + 40;
  const colX = HUB_W / 2 + horizontalGap + TOOL_W / 2;
  const totalHeight = (n - 1) * verticalGap;
  const startY = -totalHeight / 2;
  return Array.from({ length: n }, (_, i) => ({
    x: colX,
    y: startY + i * verticalGap,
  }));
}

// ── chatbar ──────────────────────────────────────────────────────────────────

function buildToolsStageContext(args: {
  dataset: Dataset | null;
  domain: ModelFamily | null;
  selected: SelectedModel[];
  summary: string | null;
}): string {
  const { dataset, domain, selected, summary } = args;
  const lines = [
    "You are Scelo at the TOOLS stage of the pipeline.",
    "The user is inside the tools workstation, picking statistical / actuarial models for their dataset.",
    "Help them understand the model picks, swap models, and prepare for the Hard Data stage.",
    "Stay focused on model choice / methodology — do not pre-empt the final outputs or re-collect raw data.",
    "",
  ];
  if (!dataset) {
    lines.push("CURRENT STATE: no dataset loaded yet — direct the user to load one in Soft Data.");
    return lines.join("\n");
  }
  lines.push(
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
  );
  lines.push(`COLUMNS: ${dataset.columns.join(", ")}.`);
  lines.push(`IDENTIFIED DOMAIN: ${domain ?? "unknown"}.`);
  if (selected.length === 0) {
    lines.push("SELECTED MODELS: none yet.");
  } else {
    lines.push("SELECTED MODELS (id · family · source · rationale):");
    for (const m of selected) {
      const cm = MODEL_BY_ID.get(m.id);
      if (!cm) continue;
      const r = m.rationale ?? cm.description;
      lines.push(
        `  • ${cm.id} · ${cm.family} · ${m.source}${m.enabled ? "" : " (disabled)"} · ${r}`,
      );
    }
  }
  if (summary) lines.push(`PICK SUMMARY: ${summary}`);
  return lines.join("\n");
}

// Hub-node chat: scoped to the dataset itself + the overall model mix. The
// user should be able to ask "is this the right domain?", "what models am I
// missing?", "rebalance the mix" — questions that span all the spokes.
function buildHubChatContext(args: {
  dataset: Dataset;
  domain: ModelFamily | null;
  selected: SelectedModel[];
  summary: string | null;
}): string {
  const { dataset, domain, selected, summary } = args;
  const lines = [
    "You are Scelo speaking FROM THE DATASET HUB node of the Tools workstation.",
    "Your scope is the dataset as a whole and the overall model mix attached to this hub.",
    "Recommend additions, removals, or rebalancing; sanity-check the identified domain; flag gaps.",
    "Stay at the hub level — defer model-internals questions to the individual model spokes.",
    "",
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
    `COLUMNS: ${dataset.columns.join(", ")}.`,
    `IDENTIFIED DOMAIN: ${domain ?? "unknown"}.`,
  ];
  if (selected.length === 0) {
    lines.push("ATTACHED MODELS: none yet — suggest a starter mix grounded in the columns above.");
  } else {
    lines.push("ATTACHED MODELS (id · family · source · enabled · rationale):");
    for (const m of selected) {
      const cm = MODEL_BY_ID.get(m.id);
      if (!cm) continue;
      lines.push(
        `  • ${cm.id} · ${cm.family} · ${m.source} · ${m.enabled ? "on" : "off"} · ${m.rationale ?? cm.description}`,
      );
    }
  }
  if (summary) lines.push(`PICK SUMMARY: ${summary}`);
  return lines.join("\n");
}

// Per-model chat: spotlight on one model, but with the dataset + peer picks
// kept in context so the model can reason about alternatives ("swap me for
// Bornhuetter–Ferguson because the triangle is sparse") rather than answering
// in a vacuum.
function buildModelChatContext(args: {
  dataset: Dataset;
  domain: ModelFamily | null;
  selected: SelectedModel[];
  focus: SelectedModel;
  focusModel: CatalogModel;
}): string {
  const { dataset, domain, selected, focus, focusModel } = args;
  const peers = selected.filter((s) => s.id !== focus.id);
  const lines = [
    `You are Scelo speaking FROM THE \`${focusModel.name}\` MODEL NODE of the Tools workstation.`,
    "Your scope is THIS model only: when it fits, when it doesn't, what to swap it for, and what to watch out for on this dataset.",
    "Recommend keep / swap / disable, and suggest parameter or diagnostic choices.",
    "Defer hub-level mix questions back to the dataset hub node.",
    "",
    `MODEL: ${focusModel.id} · ${focusModel.family}`,
    `MODEL DESCRIPTION: ${focusModel.description}`,
    `APPLICABLE TO: ${focusModel.applicableTo.join(", ")}`,
    `SOURCE: ${focus.source}${focus.enabled ? "" : " (currently disabled)"}`,
    `RATIONALE FOR THIS PICK: ${focus.rationale ?? focusModel.description}`,
    "",
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
    `COLUMNS: ${dataset.columns.join(", ")}.`,
    `IDENTIFIED DOMAIN: ${domain ?? "unknown"}.`,
  ];
  if (peers.length > 0) {
    lines.push("PEER MODELS ATTACHED TO THE SAME HUB:");
    for (const p of peers) {
      const pm = MODEL_BY_ID.get(p.id);
      if (!pm) continue;
      lines.push(`  • ${pm.id} · ${pm.family} · ${p.enabled ? "on" : "off"}`);
    }
  } else {
    lines.push("PEER MODELS: none — this is the only model attached.");
  }
  return lines.join("\n");
}

// ── left-panel: dataset stats + key column distribution ─────────────────────

// Keywords that suggest a column is "the dependent variable" we want to plot.
// Ordered most-specific first so the heuristic prefers domain-relevant signals
// (e.g. `paid` for reserving, `deaths` for mortality) over generic catch-alls
// like `amount` or `value`.
const KEY_COLUMN_KEYWORDS = [
  "paid",
  "incurred",
  "loss",
  "claim_amount",
  "claim",
  "deaths",
  "exposure",
  "severity",
  "frequency",
  "premium",
  "reserve",
  "ibnr",
  "amount",
  "value",
  "cost",
];

function isLikelyId(meta: ColumnMeta): boolean {
  if (meta.type !== "number") return false;
  const nonNull = meta.count - meta.missing;
  if (nonNull > 0 && meta.unique === nonNull) return true;
  const lower = meta.name.toLowerCase();
  if (lower === "id" || lower.endsWith("_id") || lower === "row" || lower === "index") {
    return true;
  }
  return false;
}

function pickKeyColumn(metas: ColumnMeta[]): ColumnMeta | null {
  const numeric = metas.filter((m) => m.type === "number" && !isLikelyId(m));
  if (numeric.length === 0) return null;
  // 1. keyword match — domain-relevant column wins
  for (const kw of KEY_COLUMN_KEYWORDS) {
    const hit = numeric.find((c) => c.name.toLowerCase().includes(kw));
    if (hit) return hit;
  }
  // 2. fall back to the column with the largest range — most variation to plot
  let best = numeric[0];
  let bestRange = (best.max ?? 0) - (best.min ?? 0);
  for (const m of numeric) {
    const range = (m.max ?? 0) - (m.min ?? 0);
    if (range > bestRange) {
      best = m;
      bestRange = range;
    }
  }
  return best;
}

// Horizontal Tukey boxplot + outlier scatter. Reads all the percentiles
// directly from ColumnMeta (already computed in `summariseDataset`) and
// overlays a small mean marker for a sense of skew.
function KeyColumnChart({
  meta,
  primary,
  accent,
  textDim,
  textMute,
  grid,
}: {
  meta: ColumnMeta;
  primary: string;
  accent: string;
  textDim: string;
  textMute: string;
  grid: string;
}) {
  const option = useMemo(() => {
    if (
      meta.q1 === undefined ||
      meta.q3 === undefined ||
      meta.median === undefined ||
      meta.boxLo === undefined ||
      meta.boxHi === undefined
    ) {
      return null;
    }
    const lo = meta.boxLo;
    const q1 = meta.q1;
    const median = meta.median;
    const q3 = meta.q3;
    const hi = meta.boxHi;
    const outliers = meta.outliers ?? [];
    // Iterate instead of spreading — outliers count scales with N and would
    // otherwise blow the call stack on a real `.parquet` upload.
    let xMin = lo;
    let xMax = hi;
    for (const v of outliers) {
      if (v < xMin) xMin = v;
      if (v > xMax) xMax = v;
    }
    if (meta.mean !== undefined) {
      if (meta.mean < xMin) xMin = meta.mean;
      if (meta.mean > xMax) xMax = meta.mean;
    }
    const pad = (xMax - xMin) * 0.06 || 1;

    return {
      animation: false,
      grid: { left: 8, right: 8, top: 14, bottom: 22, containLabel: true },
      tooltip: {
        trigger: "item",
        backgroundColor: "rgb(var(--rgb-bg-1))",
        borderColor: "rgb(var(--rgb-border))",
        textStyle: { color: "rgb(var(--rgb-fg))", fontSize: 10 },
        formatter: (params: { seriesName?: string; data?: unknown }) => {
          if (params.seriesName === "outliers") {
            const v = Array.isArray(params.data) ? Number(params.data[0]) : Number(params.data);
            return `<b>outlier</b><br/>${formatNumber(v)}`;
          }
          if (params.seriesName === "mean") {
            const v = Array.isArray(params.data) ? Number(params.data[0]) : Number(params.data);
            return `<b>mean</b><br/>${formatNumber(v)}`;
          }
          return [
            `<b>${meta.name}</b>`,
            `max  ${formatNumber(hi)}`,
            `Q3   ${formatNumber(q3)}`,
            `med  ${formatNumber(median)}`,
            `Q1   ${formatNumber(q1)}`,
            `min  ${formatNumber(lo)}`,
            `<span style="opacity:0.6">n=${meta.count - meta.missing}, outliers=${outliers.length}</span>`,
          ].join("<br/>");
        },
      },
      xAxis: {
        type: "value",
        min: xMin - pad,
        max: xMax + pad,
        axisLabel: {
          fontSize: 9,
          color: textDim,
          hideOverlap: true,
          formatter: (v: number) => formatNumber(v),
        },
        axisLine: { lineStyle: { color: grid } },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: grid, type: "dashed", opacity: 0.5 } },
      },
      yAxis: {
        type: "category",
        data: [""],
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          type: "boxplot",
          data: [[lo, q1, median, q3, hi]],
          itemStyle: {
            color: "transparent",
            borderColor: primary,
            borderWidth: 1.25,
          },
          boxWidth: ["55%", "70%"],
        },
        {
          name: "outliers",
          type: "scatter",
          data: outliers.map((v) => [v, 0]),
          symbolSize: 5,
          itemStyle: { color: accent, opacity: 0.85 },
        },
        ...(meta.mean !== undefined
          ? [
              {
                name: "mean",
                type: "scatter" as const,
                data: [[meta.mean, 0]],
                symbol: "diamond" as const,
                symbolSize: 8,
                itemStyle: { color: textMute, borderColor: primary, borderWidth: 1 },
              },
            ]
          : []),
      ],
    };
  }, [meta, primary, accent, textDim, textMute, grid]);

  if (!option) {
    return (
      <p className="py-3 text-center text-[11px] text-fg-dim">
        Not enough variation to draw a distribution.
      </p>
    );
  }

  return (
    <ReactECharts
      option={option}
      notMerge
      lazyUpdate
      style={{ height: 120, width: "100%" }}
      opts={{ renderer: "canvas" }}
    />
  );
}

// Each stat tile carries a small left bar + tinted border + tinted label in
// its accent colour. Class strings are static so Tailwind's JIT picks them up.
const TILE_ACCENTS = {
  primary: { wrap: "border-primary/60", bar: "bg-primary", label: "text-primary" },
  "accent-2": { wrap: "border-accent-2/60", bar: "bg-accent-2", label: "text-accent-2" },
  "accent-3": { wrap: "border-accent-3/60", bar: "bg-accent-3", label: "text-accent-3" },
  warn: { wrap: "border-warn/60", bar: "bg-warn", label: "text-warn" },
  error: { wrap: "border-error/60", bar: "bg-error", label: "text-error" },
} as const;
type TileAccent = keyof typeof TILE_ACCENTS;

function StatTile({
  label,
  value,
  accent,
  inlineColor,
}: {
  label: string;
  value: string | number;
  accent?: TileAccent;
  // For dynamic colours (e.g. the identified family palette) we override the
  // border / label with an inline style instead of a Tailwind class.
  inlineColor?: string;
}) {
  const tone = accent ? TILE_ACCENTS[accent] : null;
  const wrapCls = tone ? tone.wrap : "border-border";
  const barCls = tone ? tone.bar : "bg-border";
  const labelCls = tone ? tone.label : "text-fg-dim";
  return (
    <div
      className={`relative overflow-hidden rounded border ${wrapCls} bg-bg px-2 py-1.5 pl-2.5`}
      style={inlineColor ? { borderColor: inlineColor } : undefined}
    >
      <span
        className={`absolute inset-y-0 left-0 w-[3px] ${barCls}`}
        style={inlineColor ? { backgroundColor: inlineColor } : undefined}
      />
      <div
        className={`font-mono text-[9px] uppercase tracking-wider ${labelCls}`}
        style={inlineColor ? { color: inlineColor } : undefined}
      >
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-[12px] text-fg">{value}</div>
    </div>
  );
}

function LeftStatsPanel({
  dataset,
  metas,
  domain,
  selectedCount,
}: {
  dataset: Dataset | null;
  metas: ColumnMeta[];
  domain: ModelFamily | null;
  selectedCount: number;
}) {
  const { resolved } = useTheme();
  const primary = resolved === "light" ? "#009669" : "#00d68f";
  const accent = resolved === "light" ? "#c97900" : "#ffb454";
  const textDim = resolved === "light" ? "#8a8a86" : "#6a6a66";
  const textMute = resolved === "light" ? "#5a5a56" : "#9a9a96";
  const grid = resolved === "light" ? "#e6e4df" : "#2a2a2a";
  const familyColor = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;

  const summary = useMemo(() => {
    if (!dataset) return null;
    const numericCount = metas.filter((m) => m.type === "number").length;
    const stringCount = metas.filter((m) => m.type === "string").length;
    const dateCount = metas.filter((m) => m.type === "date").length;
    const cells = dataset.rows.length * dataset.columns.length;
    const missingCells = metas.reduce((acc, m) => acc + m.missing, 0);
    const missingPct = cells > 0 ? (missingCells / cells) * 100 : 0;
    return { numericCount, stringCount, dateCount, missingPct };
  }, [dataset, metas]);

  const keyColumn = useMemo(() => pickKeyColumn(metas), [metas]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        dataset stats
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {!dataset || !summary ? (
          <p className="px-1 py-4 text-center text-[11px] text-fg-dim">
            Load a dataset in Soft Data to see stats here.
          </p>
        ) : (
          <>
            {/* container 1: snapshot tiles */}
            <section className="rounded border border-border bg-bg-1 p-2">
              <header className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                snapshot
              </header>
              <div className="grid grid-cols-2 gap-1.5">
                <StatTile
                  label="rows"
                  value={dataset.rows.length.toLocaleString()}
                  accent="primary"
                />
                <StatTile label="columns" value={dataset.columns.length} accent="primary" />
                <StatTile label="numeric" value={summary.numericCount} accent="accent-2" />
                <StatTile label="categorical" value={summary.stringCount} accent="accent-3" />
                {summary.dateCount > 0 && (
                  <StatTile label="dates" value={summary.dateCount} accent="warn" />
                )}
                <StatTile
                  label="missing"
                  value={`${summary.missingPct.toFixed(summary.missingPct < 1 ? 2 : 1)}%`}
                  accent={
                    summary.missingPct > 5 ? "error" : summary.missingPct > 1 ? "warn" : "primary"
                  }
                />
                <StatTile
                  label="domain"
                  value={domain ?? "—"}
                  inlineColor={domain ? familyColor[domain] : undefined}
                />
                <StatTile label="models" value={selectedCount} accent="primary" />
              </div>
            </section>

            {/* container 2: key column distribution */}
            <section className="rounded border border-border bg-bg-1 p-2">
              <header className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  key column
                </span>
                {keyColumn && (
                  <span
                    className="truncate font-mono text-[10px] text-primary"
                    title={keyColumn.name}
                  >
                    {keyColumn.name}
                  </span>
                )}
              </header>
              {keyColumn ? (
                <>
                  <KeyColumnChart
                    meta={keyColumn}
                    primary={primary}
                    accent={accent}
                    textDim={textDim}
                    textMute={textMute}
                    grid={grid}
                  />
                  <dl className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px]">
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">mean</dt>
                      <dd className="text-fg">
                        {keyColumn.mean !== undefined ? formatNumber(keyColumn.mean) : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">median</dt>
                      <dd className="text-fg">
                        {keyColumn.median !== undefined ? formatNumber(keyColumn.median) : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">min</dt>
                      <dd className="text-fg">
                        {keyColumn.min !== undefined ? formatNumber(keyColumn.min) : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">max</dt>
                      <dd className="text-fg">
                        {keyColumn.max !== undefined ? formatNumber(keyColumn.max) : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">missing</dt>
                      <dd className="text-fg">{keyColumn.missing}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-dim">unique</dt>
                      <dd className="text-fg">{keyColumn.unique}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="py-3 text-center text-[11px] text-fg-dim">
                  No numeric column to plot.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ── right-panel: model details ───────────────────────────────────────────────

function ModelDetailsPanel({
  focused,
  selected,
  onToggle,
  onRemove,
  onAdd,
  catalogModelsByFamily,
}: {
  focused: CatalogModel | null;
  selected: SelectedModel[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  catalogModelsByFamily: Map<ModelFamily, CatalogModel[]>;
}) {
  const { resolved } = useTheme();
  const palette = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;

  const focusedSelection = focused ? selected.find((m) => m.id === focused.id) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        model details
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {focused ? (
          <div className="flex flex-col gap-3">
            <div>
              <div
                className="font-mono text-[9px] uppercase tracking-wider"
                style={{ color: palette[focused.family] }}
              >
                {focused.family}
              </div>
              <h2 className="text-sm text-fg">{focused.name}</h2>
              <p className="mt-1 text-[11px] text-fg-mute">{focused.description}</p>
            </div>

            {focusedSelection?.rationale && (
              <div className="rounded border border-border bg-bg p-2">
                <div className="mb-0.5 font-mono text-[9px] uppercase text-fg-dim">
                  {focusedSelection.source === "ai" ? "ai rationale" : "user pick"}
                </div>
                <p className="text-[11px] text-fg-mute">{focusedSelection.rationale}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-1">
              {focused.applicableTo.map((tag) => (
                <span
                  key={tag}
                  className="rounded border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-mute"
                >
                  #{tag}
                </span>
              ))}
            </div>

            <div className="flex gap-2">
              {focusedSelection ? (
                <>
                  <button
                    type="button"
                    onClick={() => onToggle(focused.id)}
                    className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] text-fg-mute hover:border-primary hover:text-primary"
                  >
                    {focusedSelection.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(focused.id)}
                    className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] text-fg-mute hover:border-error hover:text-error"
                  >
                    remove
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onAdd(focused.id)}
                  className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] text-fg-mute hover:border-primary hover:text-primary"
                >
                  + attach to hub
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-fg-dim">
            Click a model node on the canvas, or pick one from the catalog below to attach it to the
            hub.
          </p>
        )}

        <div className="mt-6">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            catalog
          </div>
          <div className="flex flex-col gap-3">
            {Array.from(catalogModelsByFamily.entries()).map(([family, models]) => (
              <div key={family}>
                <div
                  className="mb-1 font-mono text-[10px] uppercase tracking-wider"
                  style={{ color: palette[family] }}
                >
                  {family}
                </div>
                <ul className="space-y-0.5">
                  {models.map((m) => {
                    const isSelected = selected.some((s) => s.id === m.id);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => (isSelected ? onRemove(m.id) : onAdd(m.id))}
                          className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left font-mono text-[10px] transition ${
                            isSelected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-transparent text-fg-mute hover:border-border hover:bg-bg-2"
                          }`}
                        >
                          <span className="truncate">{m.name}</span>
                          <span className="shrink-0 text-[9px] text-fg-dim">
                            {isSelected ? "−" : "+"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── main workstation ─────────────────────────────────────────────────────────

export function ToolsWorkstation() {
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const {
    dataset,
    selectedModels,
    setSelectedModels,
    domain,
    setDomain,
    pickSummary,
    setPickSummary,
    logEvent,
  } = useScelo();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [regenSeed, setRegenSeed] = useState(0);
  const previousIdsRef = useRef<string[]>([]);

  // Column metas — used both for the LLM prompt and the heuristic. We
  // summarise here against the raw dataset (not the filtered slice) because
  // model selection is about the dataset's intrinsic shape, not the user's
  // current filter view.
  const columnMetas = useMemo<ColumnMeta[]>(() => {
    if (!dataset) return [];
    return summariseDataset(dataset);
  }, [dataset]);

  const signature: DataSignature | null = useMemo(
    () => (dataset ? dataSignature(dataset, columnMetas) : null),
    [dataset, columnMetas],
  );

  const identify = useCallback(
    (variant: number) => {
      if (!dataset) return;
      const ac = new AbortController();
      setStatus("loading");
      fetchModelPicks({
        dataset,
        metas: columnMetas,
        variant,
        previousIds: previousIdsRef.current,
        signal: ac.signal,
      })
        .then((res) => {
          if (ac.signal.aborted) return;
          setDomain(res.domain);
          setPickSummary(res.summary);
          const picks: SelectedModel[] = res.selected.map((s) => ({
            id: s.id,
            enabled: true,
            source: "ai",
            rationale: s.rationale,
          }));
          setSelectedModels(picks);
          previousIdsRef.current = picks.map((p) => p.id);
          setStatus("ready");
          logEvent({
            stage: "tools",
            kind: "models.aiPick",
            payload: {
              domain: res.domain,
              summary: res.summary,
              source: "ai",
              models: res.selected.map((s) => ({ id: s.id, rationale: s.rationale })),
            },
          });
        })
        .catch(() => {
          if (ac.signal.aborted || !signature) return;
          const fallback = heuristicPick(signature);
          setDomain(fallback.domain);
          setPickSummary(fallback.summary);
          const picks: SelectedModel[] = fallback.selected.map((s) => ({
            id: s.id,
            enabled: true,
            source: "ai",
            rationale: s.rationale,
          }));
          setSelectedModels(picks);
          previousIdsRef.current = picks.map((p) => p.id);
          setStatus("fallback");
          logEvent({
            stage: "tools",
            kind: "models.aiPick",
            payload: {
              domain: fallback.domain,
              summary: fallback.summary,
              source: "fallback",
              models: fallback.selected.map((s) => ({ id: s.id, rationale: s.rationale })),
            },
          });
        });
      return ac;
    },
    [dataset, columnMetas, signature, setDomain, setSelectedModels, setPickSummary, logEvent],
  );

  // Initial identification on mount (or when the dataset changes). Aborts
  // on unmount / dataset swap so we don't race.
  // biome-ignore lint/correctness/useExhaustiveDependencies: regenSeed triggers re-identify; we don't want to refire on selectedModels edits.
  useEffect(() => {
    if (!dataset || selectedModels.length > 0) return;
    const ac = identify(0);
    return () => ac?.abort();
  }, [dataset, identify]);

  // Manual regenerate — bumps the variant counter so the LLM gets the
  // "previous picks were X, pick a different mix" nudge.
  const regenerate = useCallback(() => {
    setRegenSeed((s) => s + 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to regenSeed; dataset/identify already trigger the first-mount effect above.
  useEffect(() => {
    if (regenSeed === 0 || !dataset) return;
    const ac = identify(regenSeed);
    return () => ac?.abort();
  }, [regenSeed]);

  // Toggle / add / remove ────────────────────────────────────────────────────
  const onToggle = useCallback(
    (id: string) => {
      setSelectedModels((prev) => {
        const target = prev.find((m) => m.id === id);
        const nextEnabled = target ? !target.enabled : true;
        logEvent({
          stage: "tools",
          kind: "model.toggle",
          payload: { id, enabled: nextEnabled },
        });
        return prev.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m));
      });
    },
    [setSelectedModels, logEvent],
  );
  const onRemove = useCallback(
    (id: string) => {
      logEvent({ stage: "tools", kind: "model.remove", payload: { id } });
      setSelectedModels((prev) => prev.filter((m) => m.id !== id));
    },
    [setSelectedModels, logEvent],
  );
  const onAdd = useCallback(
    (id: string) => {
      const model = MODEL_BY_ID.get(id);
      if (!model) return;
      setSelectedModels((prev) => {
        if (prev.some((m) => m.id === id)) return prev;
        return [...prev, { id, enabled: true, source: "user", rationale: model.description }];
      });
      logEvent({ stage: "tools", kind: "model.add", payload: { id } });
    },
    [setSelectedModels, logEvent],
  );
  // Swap one model for another in-place. Replaces the entry at the same
  // index so React Flow recycles the canvas position and downstream
  // ordering (default-edge slot indices, etc.) stays stable.
  const onReplace = useCallback(
    (currentId: string, nextId: string) => {
      if (currentId === nextId) return;
      const next = MODEL_BY_ID.get(nextId);
      if (!next) return;
      setSelectedModels((prev) => {
        const idx = prev.findIndex((m) => m.id === currentId);
        if (idx < 0) return prev;
        // If the replacement is already in the selection, just drop the
        // current one to avoid duplicates.
        if (prev.some((m) => m.id === nextId)) return prev.filter((m) => m.id !== currentId);
        const copy = [...prev];
        copy[idx] = {
          id: nextId,
          enabled: true,
          source: "user",
          rationale: next.description,
        };
        return copy;
      });
      // Audit both halves of the swap so the export script log reflects it.
      logEvent({ stage: "tools", kind: "model.remove", payload: { id: currentId } });
      logEvent({ stage: "tools", kind: "model.add", payload: { id: nextId } });
    },
    [setSelectedModels, logEvent],
  );

  // Catalog grouped by family for the right panel.
  const catalogByFamily = useMemo(() => {
    const m = new Map<ModelFamily, CatalogModel[]>();
    for (const model of MODEL_CATALOG) {
      const arr = m.get(model.family) ?? [];
      arr.push(model);
      m.set(model.family, arr);
    }
    return m;
  }, []);

  // React Flow nodes + edges ─────────────────────────────────────────────────
  const palette = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const edgeColor = resolved === "light" ? "#bdbdb8" : "#3a3a3a";
  // Reads the model-family colour for a given model id. Used to colour
  // edges by what the edge is *carrying* — hub spokes are tinted by the
  // destination model's family (each spoke "feeds" that family) and
  // cross-model workflow edges by the source's family (data leaves that
  // pipeline). Falls back to the dim disabled colour for an unknown id.
  const colorFor = useCallback(
    (modelId: string): string => {
      const fam = MODEL_BY_ID.get(modelId)?.family;
      return fam ? palette[fam] : edgeColor;
    },
    [palette, edgeColor],
  );

  const enabledCount = selectedModels.filter((m) => m.enabled).length;

  // Derived "desired" nodes/edges from the current model picks. The real
  // React Flow state is held in `nodes`/`edges` below — we sync the desired
  // shape in but preserve any positions the user has dragged to.
  const desiredNodes: Node[] = useMemo(() => {
    if (!dataset) return [];
    const layout = columnLayout(selectedModels.length);
    // slotCount = hub + every selected model. Every node carries the same
    // count so each one has matching front/back ports for any pair the
    // actuary might want to wire.
    const slotCount = selectedModels.length + 1;
    const hub: Node<HubNodeData> = {
      id: "hub",
      type: "hub",
      position: { x: -HUB_W / 2, y: -HUB_H / 2 },
      data: {
        dataset,
        domain,
        selectedCount: enabledCount,
        slotCount,
        chatContext: buildHubChatContext({
          dataset,
          domain: domain as ModelFamily | null,
          selected: selectedModels,
          summary: pickSummary,
        }),
        chatPlaceholder:
          selectedModels.length === 0
            ? "suggest a starter model mix…"
            : "rebalance the mix, flag gaps…",
      },
      draggable: true,
      selectable: false,
    };
    const tools: Node<ToolNodeData>[] = selectedModels.map((sm, i) => {
      const model = MODEL_BY_ID.get(sm.id);
      if (!model) {
        return null as unknown as Node<ToolNodeData>;
      }
      return {
        id: `model-${sm.id}`,
        type: "tool",
        position: { x: layout[i].x - TOOL_W / 2, y: layout[i].y - TOOL_H / 2 },
        data: {
          model,
          selected: sm.enabled,
          rationale: sm.rationale,
          onToggle,
          onRemove,
          onReplace,
          isFocused: focusedId === sm.id,
          slotCount,
          chatContext: buildModelChatContext({
            dataset,
            domain: domain as ModelFamily | null,
            selected: selectedModels,
            focus: sm,
            focusModel: model,
          }),
          chatPlaceholder: `ask about ${model.name}…`,
        },
        draggable: true,
      };
    });
    return [hub, ...tools.filter(Boolean)];
  }, [
    dataset,
    selectedModels,
    domain,
    enabledCount,
    onToggle,
    onRemove,
    onReplace,
    focusedId,
    pickSummary,
  ]);

  // Default edge graph. Two layers:
  //   1. Hub → model data-feed edges (one per selected model).
  //   2. Model → model "actuarial workflow" edges that wire common
  //      sequencing patterns within each domain so the canvas reads as a
  //      plausible starting pipeline rather than a star of independent
  //      models. The user can re-wire freely afterwards — both the hub
  //      and the model nodes expose source + target handles on all four
  //      sides, so any permutation of connections is possible.
  //
  // Workflow pairs are listed `(from, to)` with a label that captures the
  // actuarial relationship. If neither end of a pair is selected, the
  // edge is skipped silently.
  const desiredEdges: Edge[] = useMemo(() => {
    const enabledIds = new Set(selectedModels.filter((m) => m.enabled).map((m) => m.id));
    const out: Edge[] = [];

    // ── 1. Hub → model spokes ─────────────────────────────────────────
    // Each spoke gets its own slot on the hub's right side (so the edges
    // fan out cleanly down the side of the hub) and lands on the target
    // model's left slot 0 — by convention every model dedicates left
    // slot 0 to the hub data feed. Spoke is tinted by the destination
    // model's family — a reserving spoke is green, a climate spoke is
    // amber, a pricing spoke is violet, etc. Disabled spokes fall back
    // to the dim border colour.
    for (const [i, sm] of selectedModels.entries()) {
      const model = MODEL_BY_ID.get(sm.id);
      if (!model) continue;
      const color = sm.enabled ? colorFor(sm.id) : edgeColor;
      out.push({
        id: `e-hub-${sm.id}`,
        type: "removable",
        source: "hub",
        sourceHandle: `s-right-${i}`,
        target: `model-${sm.id}`,
        targetHandle: "t-left-0",
        animated: sm.enabled,
        style: {
          stroke: color,
          strokeWidth: sm.enabled ? 1.5 : 1,
          opacity: sm.enabled ? 1 : 0.5,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      });
    }

    // ── 2. Actuarial-workflow defaults ────────────────────────────────
    // (from, to, label). Each pair is only laid down if both endpoints
    // are in the user's current selection. Domains are mutually
    // exclusive in practice (the picker leans into one family), so this
    // table can list all families in one block without conflicting.
    const WORKFLOWS: Array<[string, string, string]> = [
      // reserving — point → variance → BF prior → bootstrap distribution
      ["chain-ladder", "mack", "+ variance"],
      ["chain-ladder", "bornhuetter-ferguson", "+ a-priori"],
      ["mack", "bootstrap-ibnr", "+ simulation"],
      // mortality — fit & compare, then price
      ["lee-carter", "cbd", "compare"],
      ["lee-carter", "lifecontingencies", "price annuities"],
      ["cbd", "lifecontingencies", "price annuities"],
      // pricing — frequency × severity, then a nonlinear baseline + explainer
      ["glm-frequency", "glm-severity", "× combine"],
      ["glm-severity", "gbm", "vs nonlinear"],
      ["gbm", "shap", "explain"],
      // climate — hazard footprints feed parametric trigger design
      ["climada", "parametric-design", "footprints → trigger"],
      // capital — SCR uses ESG scenarios
      ["esg", "scr-standard", "scenarios → SCR"],
    ];

    // Counter so each cross-model edge departing the same node lands on a
    // different slot, fanning the workflow arrows out down the source's
    // right side and across the target's left side instead of stacking
    // them all on slot 0.
    const sourceSlotUsed = new Map<string, number>();
    const targetSlotUsed = new Map<string, number>();
    for (const [from, to, label] of WORKFLOWS) {
      const bothSelected =
        selectedModels.some((m) => m.id === from) && selectedModels.some((m) => m.id === to);
      if (!bothSelected) continue;
      const live = enabledIds.has(from) && enabledIds.has(to);
      // Workflow edges are tinted by the SOURCE family — the data is
      // leaving that pipeline (e.g. chain-ladder → mack is a reserving
      // arrow, climada → parametric-design is a climate arrow). When the
      // edge crosses families (rare but possible in mixed selections),
      // the source colour wins; the destination's own colour shows on
      // any hub spoke arriving at the same node.
      const color = live ? colorFor(from) : edgeColor;
      // Skip slot 0 on each side — that's reserved for the hub feed on
      // every model node. Cross-model edges start at slot 1 and grow.
      const sSlot = (sourceSlotUsed.get(from) ?? 0) + 1;
      sourceSlotUsed.set(from, sSlot);
      const tSlot = (targetSlotUsed.get(to) ?? 0) + 1;
      targetSlotUsed.set(to, tSlot);
      out.push({
        id: `e-${from}->${to}`,
        type: "removable",
        source: `model-${from}`,
        sourceHandle: `s-right-${sSlot}`,
        target: `model-${to}`,
        targetHandle: `t-left-${tSlot}`,
        label,
        // `labelStyle.fill` is consumed by RemovableEdge and mapped to CSS
        // `color` for the HTML label span. The label's solid `bg-bg` backing
        // (added in RemovableEdge itself) handles the dashed-stroke masking,
        // so no `labelBgStyle` is needed here.
        labelStyle: { fill: color, fontFamily: "'SN Pro', 'Inter', sans-serif", fontSize: 9 },
        animated: live,
        style: {
          stroke: color,
          strokeDasharray: live ? undefined : "4 4",
          strokeWidth: live ? 1.4 : 1,
          opacity: live ? 0.9 : 0.45,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
      });
    }

    return out;
  }, [selectedModels, colorFor, edgeColor]);

  // Controlled React Flow state. `onNodesChange` is what makes nodes actually
  // draggable — without it React Flow has no callback for drag updates and
  // the node snaps back to its prop position on each render.
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // User-drawn edge handler. Mirrors the default-edge palette so a
  // hand-drawn arrow reads identically to the ones the auto-layout
  // generated: hub-sourced edges take the destination's family colour
  // (same rule as auto hub spokes); model→model edges take the source's
  // family colour (same rule as auto workflow arrows). Edges with no
  // resolvable family fall back to the dim border colour.
  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      const sourceModelId = params.source.replace(/^model-/, "");
      const targetModelId = params.target.replace(/^model-/, "");
      const color =
        params.source === "hub"
          ? colorFor(targetModelId) // tint by destination, like hub spokes
          : colorFor(sourceModelId); // tint by source, like workflow arrows
      setEdges((eds) => {
        const newEdge: Edge = {
          id: `user-${params.source}-${params.sourceHandle ?? "?"}-${params.target}-${params.targetHandle ?? "?"}-${Date.now()}`,
          type: "removable",
          source: params.source ?? "",
          sourceHandle: params.sourceHandle ?? null,
          target: params.target ?? "",
          targetHandle: params.targetHandle ?? null,
          animated: true,
          style: { stroke: color, strokeWidth: 1.5, opacity: 0.95 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
        };
        return [...eds, newEdge];
      });
    },
    [colorFor, setEdges],
  );

  // Sync the desired shape into state without clobbering user-dragged
  // positions: if a node already exists by id, keep its position; otherwise
  // accept the position from the layout.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n] as const));
      return desiredNodes.map((n) => {
        const existing = prevById.get(n.id);
        return existing ? { ...n, position: existing.position } : n;
      });
    });
  }, [desiredNodes, setNodes]);

  useEffect(() => {
    setEdges(desiredEdges);
  }, [desiredEdges, setEdges]);

  // React Flow's `fitView` prop only fires on the initial mount. Our nodes
  // arrive via the sync effect *after* mount, so without this the freshly
  // laid-out circle can fall partly off-screen, looking "scattered". We
  // capture the instance and explicitly fit once the spokes first appear.
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const hasFitRef = useRef(false);
  useEffect(() => {
    if (hasFitRef.current) return;
    // Wait until hub + at least one spoke are mounted so fitView has a real
    // bounding box to work with.
    if (nodes.length < 2) return;
    const inst = flowInstanceRef.current;
    if (!inst) return;
    hasFitRef.current = true;
    // Defer one frame so React Flow has measured node dimensions.
    requestAnimationFrame(() => {
      inst.fitView({ padding: 0.2, duration: 300 });
    });
  }, [nodes.length]);

  // Manual "re-layout" — snap all nodes back to the clean default circle and
  // refit the viewport. Useful after the user has dragged things around or
  // after regenerate gives a new model mix.
  const relayout = useCallback(() => {
    hasFitRef.current = false;
    setNodes(desiredNodes);
    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.2, duration: 300 });
    });
  }, [desiredNodes, setNodes]);

  // Chatbar context — refreshes whenever picks / dataset / domain change.
  const chatStageContext = useMemo(
    () =>
      buildToolsStageContext({
        dataset,
        domain: domain as ModelFamily | null,
        selected: selectedModels,
        summary: pickSummary,
      }),
    [dataset, domain, selectedModels, pickSummary],
  );
  const chatPlaceholder = useMemo(() => {
    if (!dataset) return "load a dataset in Soft Data first…";
    if (selectedModels.length === 0) return "ask scelo about model choice…";
    return `ask scelo about these ${enabledCount} model${enabledCount === 1 ? "" : "s"}…`;
  }, [dataset, selectedModels.length, enabledCount]);

  const focused = focusedId ? (MODEL_BY_ID.get(focusedId) ?? null) : null;

  return (
    <div className="flex h-full flex-col">
      {/* top toolbar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-2">
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo")}
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          ← macro view
        </button>
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo/soft")}
          title="Step back to Soft Data."
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          ← back: soft
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
            <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
            <span>tools</span>
          </div>
          <h1 className="truncate text-sm text-fg">workstation</h1>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedModels([]);
              setRegenSeed((s) => s + 1);
            }}
            disabled={!dataset || status === "loading"}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? "identifying…" : "identify models"}
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={!dataset || status === "loading"}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            regenerate
          </button>
          <button
            type="button"
            onClick={relayout}
            disabled={!dataset || selectedModels.length === 0}
            title="Snap nodes back to the default circle and refit the view."
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            re-layout
          </button>
          <ExportButton stage="tools" disabled={!dataset} />
          <div className="ml-1 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => navigate("/dashboards/scelo/hard")}
            disabled={!dataset}
            title={
              !dataset
                ? "Load a dataset first."
                : enabledCount === 0
                  ? "No enabled models — Hard Data will be empty, but you can still go."
                  : "Run the picks in Hard Data."
            }
            className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
          >
            next: hard →
          </button>
        </div>
      </header>

      {/* dataset banner */}
      {dataset ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            working with
          </span>
          <span className="font-mono text-xs text-fg">{dataset.name}</span>
          <span className="font-mono text-[10px] text-fg-dim">
            {dataset.rows.length} rows · {dataset.columns.length} cols
          </span>
          {domain && (
            <span
              className="ml-auto rounded border bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
              style={{
                color: palette[domain as ModelFamily],
                borderColor: palette[domain as ModelFamily],
              }}
            >
              {domain}
              {status === "fallback" && (
                <span className="ml-1 normal-case text-fg-dim">(local fallback)</span>
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3 py-1.5 text-[11px] text-fg-mute">
          No dataset loaded.{" "}
          <button
            type="button"
            onClick={() => navigate("/dashboards/scelo/soft")}
            className="text-primary hover:underline"
          >
            go to Soft Data →
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <ResizablePanel
          side="left"
          defaultWidth={256}
          badge="tools · stats"
          accentClass="text-primary"
        >
          <LeftStatsPanel
            dataset={dataset}
            metas={columnMetas}
            domain={domain as ModelFamily | null}
            selectedCount={enabledCount}
          />
        </ResizablePanel>
        <main className="min-w-0 flex-1">
          {dataset ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodesDelete={(deleted) => {
                // Keyboard-deleted model nodes (Backspace / Delete) need
                // to drop out of `selectedModels` too; the hub is not
                // deletable so we filter it out.
                for (const n of deleted) {
                  if (n.type !== "tool") continue;
                  const id = n.id.replace(/^model-/, "");
                  onRemove(id);
                }
              }}
              onInit={(inst) => {
                flowInstanceRef.current = inst;
              }}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={(_, node) => {
                if (node.type === "tool") {
                  const id = node.id.replace(/^model-/, "");
                  setFocusedId(id);
                }
              }}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.4}
              maxZoom={1.5}
              // Connectable — users can drag from any source handle to any
              // target handle to wire a custom edge. The eight-handle
              // layout per node (target + source on each side) means any
              // permutation of connections is reachable.
              nodesConnectable={true}
              // Backspace OR Delete removes a selected node / edge. React
              // Flow's default is "Backspace" alone; both keys is closer
              // to what most diagramming tools do.
              deleteKeyCode={["Backspace", "Delete"]}
              proOptions={{ hideAttribution: true }}
            >
              <Background color={resolved === "light" ? "#dcdad5" : "#1a1a1a"} gap={16} />
              <FlowControls />
            </ReactFlow>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div className="max-w-md">
                <p className="text-sm text-fg-mute">
                  Load a dataset in <span className="font-mono text-fg">Soft Data</span> and the
                  Tools workstation will identify candidate models for it.
                </p>
              </div>
            </div>
          )}
        </main>
        <ResizablePanel
          side="right"
          defaultWidth={288}
          badge="tools · model"
          accentClass="text-primary"
        >
          <ModelDetailsPanel
            focused={focused}
            selected={selectedModels}
            onToggle={onToggle}
            onRemove={onRemove}
            onAdd={onAdd}
            catalogModelsByFamily={catalogByFamily}
          />
        </ResizablePanel>
        {/* far right: persistent Scelo chat panel */}
        <StageChatPanel
          stageContext={chatStageContext}
          placeholder={chatPlaceholder}
          chatId="tools-stage"
          title={chatPlaceholder}
          badge="tools · chat"
          dataset={dataset}
        />
      </div>
    </div>
  );
}
