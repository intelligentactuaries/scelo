// Tools drill-in. Layout:
//
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │ ← macro · tools · workstation                  [identify] [regen]   │
//   ├─────────────────────────────────────────────────────────────────────┤
//   │ working with: claims_sample · 64 rows · 10 cols  pipeline  domain   │
//   ├──────────────────────────────────────────────────┬──────────────────┤
//   │                                                  │ model details   │
//   │   React Flow canvas — a Blueprint graph          │                 │
//   │                                                  │ inputs / outputs│
//   │  [DATASET HUB]            [Lee–Carter]           │ rationale       │
//   │   mortality table ●──┬──● mortality  proj. ◆──┐  │ toggle / remove │
//   │                      │                        │  │ catalog, ranked │
//   │                      └──● mortality     [Life Contingencies]      │
//   │                           [CBD]         ◆ mortality                │
//   │                                                  │                 │
//   ├──────────────────────────────────────────────────┴──────────────────┤
//   │ Scelo · tools chatbar (dataset + picks in context)                  │
//   └─────────────────────────────────────────────────────────────────────┘
//
// The canvas reads like an Unreal Blueprint (the typed contract lives in
// modelPorts.ts): the dataset hub's output pins are the data roles it can
// actually feed (claims triangle, mortality table, …); every model shows
// only the pins it really has — inputs on the left, outputs on the right,
// round for data, diamond for another model's result — and a wire can only
// join pins whose types agree. Models flow left to right by pipeline depth.
// Drop a wire on empty canvas (or right-click) for the models that fit.

import ReactECharts from "echarts-for-react";
import { BoxplotChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  Background,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnectStartParams,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { Arrow } from "@/components/Arrow";
import { useTheme } from "@/lib/theme";
import {
  AddModelMenu,
  BlueprintConnectionLine,
  BlueprintContext,
  type MenuEntry,
  type MenuSection,
  PIN_ROW_H,
  PinHandle,
  type Theme,
  WireEdge,
  type WireEdgeData,
  portColorOf,
} from "./BlueprintCanvas";
import { ChatInputPill } from "./ChatInputPill";
import { ExportButton } from "./ExportScreen";
import { FlowControls } from "./FlowControls";
import { ResizablePanel } from "./ResizablePanel";
import { SciText } from "./SciText";
import { type ColumnMeta, type Dataset, formatNumber } from "./SoftDataWorkstation";
import { StageChatPanel } from "./StageChatPanel";
import { UploadIndicator } from "./UploadIndicator";
import { getColumnMetas } from "./columnMetaCache";
import { type DataRole, dataTypesOf, detectDataRoles } from "./dataRoles";
import {
  type CatalogModel,
  FAMILY_COLOR_DARK,
  FAMILY_COLOR_LIGHT,
  MODEL_BY_ID,
  MODEL_CATALOG,
  type ModelFamily,
} from "./modelCatalog";
import {
  type DataSignature,
  dataSignature,
  fetchModelPicks,
  finalizePick,
  heuristicPick,
} from "./modelPicker";
import {
  type DataPortType,
  HUB_NODE_ID,
  type InputPort,
  type OutputPort,
  PORT_TYPES,
  type PortType,
  checkConnection,
  connectWire,
  consumersOf,
  dataHandleId,
  describeAccepts,
  disconnectWire,
  inHandleId,
  inputFeeds,
  isDataType,
  modelIdOfNode,
  modelNodeId,
  outHandleId,
  parseHandleId,
  pipelineDepths,
  portsOf,
  producersOf,
  requiredProducers,
  resolveWire,
  unmetInputs,
  wireInto,
} from "./modelPorts";
import { modelApplicability } from "./modelRunner";
import {
  type ModelDirective,
  applyModelDirective,
  applyWireDirective,
  describeDirectiveReport,
  describeWireReport,
  modelDirectiveProtocol,
  parseModelDirective,
  parseStackCommand,
  replaceDirectiveBlock,
} from "./modelStackDirectives";
import type { ModelWire } from "./pipeline";
import { type SelectedModel, useScelo } from "./sceloContext";
import { useActuarialTableChat } from "./useActuarialTableChat";
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
  onAssistantFinal,
  onLocalCommand,
}: {
  stageContext: string;
  placeholder: string;
  accentColor?: string;
  // Stable identifier for this chat instance — combined with the active
  // project id (if any) to form the memoryKey. Memory is off when no project.
  chatId: string;
  /** Post-process a completed assistant reply (stack directives). */
  onAssistantFinal?: (text: string) => string | undefined;
  /** Deterministic intent handler, tried BEFORE the provider — receives the
   *  assistant history so "add all suggested" can resolve the suggestions. */
  onLocalCommand?: (text: string, assistantHistory?: string[]) => string | null;
}) {
  const { chatMemoryPrefix, project } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:${chatId}` : undefined;
  const { messages, isStreaming, send, sendLocal, stop } = useNodeChat(stageContext, {
    memoryKey,
    onAssistantFinal,
    logLabel: `tools · ${chatId.replace(/-/g, " · ")}`,
    logProject: project?.name,
  });
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
    const localReply = onLocalCommand?.(
      text,
      messages.filter((m) => m.role === "assistant").map((m) => m.content),
    );
    if (localReply != null) {
      sendLocal(text, localReply);
      return;
    }
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
          {messages.map((m, idx) => (
            <div
              key={m.id}
              className={`mb-1 last:mb-0 ${idx >= messages.length - 2 ? "ia-rise-in" : ""}`}
            >
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

/** How a model sits against the loaded data — drives the catalog marks, the
 *  swap and add menus, and whether a newly added node arrives switched on. */
type ModelFit =
  | { state: "ready" }
  | { state: "illustrative"; reason: string }
  | { state: "blocked"; reason: string };

const FIT_RANK: Record<ModelFit["state"], number> = { ready: 0, illustrative: 1, blocked: 2 };

type HubRoleRow = { role: DataRole; used: boolean };

type HubNodeData = {
  dataset: Dataset;
  domain: ModelFamily | null;
  selectedCount: number;
  /** Data roles drawn as output pins: every role an attached model reads,
   *  plus the rest while expanded (or while nothing is attached yet). */
  rows: HubRoleRow[];
  /** Roles the data offers that nothing attached reads — behind "▸ more". */
  hiddenCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** "Which models read this?" — opens the role's add menu. */
  onRoleMenu: (type: DataPortType, clientX: number, clientY: number) => void;
  chatContext: string;
  chatPlaceholder: string;
  /** Applies scelo-models directives from this chat's replies. */
  onStackDirective?: (text: string) => string | undefined;
  /** Deterministic stack commands, tried before the provider. */
  onLocalStackCommand?: (text: string, assistantHistory?: string[]) => string | null;
};

// The dataset as a Blueprint source node: no inputs, one output pin per
// data role the loaded file can actually feed, each with its evidence.
function HubNode({ data }: NodeProps<HubNodeData>) {
  const [chatOpen, setChatOpen] = useState(false);
  const { theme } = useContext(BlueprintContext);
  return (
    <div
      className="ia-node-in glass-card w-[270px] rounded-lg"
      style={{
        // Primary tint on the hub so the typed wires read as leaving it.
        // Inline border wins over the .glass-card hairline.
        borderColor: "rgb(var(--rgb-primary))",
        borderWidth: 2,
      }}
    >
      <div className="px-3 pt-2.5">
        <div className="font-mono text-[10px] uppercase tracking-wider text-primary">
          dataset hub
        </div>
        <div className="mt-0.5 truncate text-sm text-fg" title={data.dataset.name}>
          {data.dataset.name}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-mute">
            {data.dataset.rows.length} rows · {data.dataset.columns.length} cols
          </span>
          {data.domain && (
            <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
              {data.domain}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2 border-t border-border/70 pb-1 pt-1">
        <div className="px-3 pb-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
          feeds
        </div>
        {data.rows.length === 0 && data.hiddenCount === 0 && (
          <p className="px-3 pb-1 text-[10px] leading-snug text-fg-dim">
            Nothing here that a catalog model reads.
          </p>
        )}
        {data.rows.map(({ role, used }) => {
          const color = portColorOf(role.type, theme);
          const tip = [
            PORT_TYPES[role.type].description,
            `Columns: ${role.columns.join(", ")}`,
            ...(role.caveat ? [`⚠ ${role.caveat}`] : []),
            "Click for the models that read it, or drag a wire from the pin.",
          ].join("\n");
          return (
            <div
              key={role.type}
              className="relative flex items-center px-3"
              style={{ height: PIN_ROW_H }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  data.onRoleMenu(role.type, e.clientX, e.clientY);
                }}
                title={tip}
                className="nodrag flex min-w-0 flex-1 items-baseline gap-1.5 rounded pr-2 text-left hover:bg-bg-2/60"
              >
                <span className="shrink-0 text-[10.5px]" style={{ color }}>
                  {PORT_TYPES[role.type].label}
                </span>
                <span className="min-w-0 truncate font-mono text-[9px] text-fg-dim">
                  {role.evidence}
                </span>
                {role.caveat && <span className="shrink-0 text-[10px] text-warn">⚠</span>}
              </button>
              <PinHandle
                side="out"
                handleId={dataHandleId(role.type)}
                type={role.type}
                filled={used}
                title={tip}
              />
            </div>
          );
        })}
        {(data.hiddenCount > 0 || data.expanded) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              data.onToggleExpanded();
            }}
            className="nodrag mt-0.5 px-3 font-mono text-[9.5px] text-fg-dim hover:text-primary"
          >
            {data.expanded
              ? "▾ only what's in use"
              : `▸ ${data.hiddenCount} more this data can feed`}
          </button>
        )}
      </div>

      <div className="px-3 pb-2.5">
        <div className="text-[11px] text-fg-dim">
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
            onAssistantFinal={data.onStackDirective}
            onLocalCommand={data.onLocalStackCommand}
          />
        )}
      </div>
    </div>
  );
}

/** "Needs a mortality table (death rates …) — this dataset …" → "needs a
 *  mortality table": the cause alone, for a one-line badge. */
function shortCause(reason: string): string {
  const head = reason.split(/ \(| — |[.;]/)[0].trim();
  return head.charAt(0).toLowerCase() + head.slice(1);
}

type ToolInputPin = {
  port: InputPort;
  /** Pin colour: the type plugged in, else the pin's primary type. */
  type: PortType;
  filled: boolean;
  tone: "ok" | "default" | "fallback" | "missing";
  /** Beside the label, Blueprint-style: an unplugged pin's default, a
   *  fallback, or what is missing. */
  note?: string;
  /** One-click fix for a missing model input (add / plug in / switch on). */
  fix?: { label: string; run: () => void };
  /** A drag can START here: pins that take another model's result. */
  draggable: boolean;
  /** Full sentence — the pin's tooltip and the details panel's line. */
  detail: string;
};

type ToolOutputPin = { port: OutputPort; filled: boolean; detail: string };

type ToolNodeData = {
  model: CatalogModel;
  selected: boolean;
  rationale?: string;
  /** Why this model cannot run here — the data, or an input nothing feeds. */
  blocked?: string;
  inputs: ToolInputPin[];
  outputs: ToolOutputPin[];
  fitOf: (id: string) => ModelFit;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  // Swap from the current model id to a new model id — implementation
  // adds the new model and removes the old one in one render so the
  // user's canvas position survives the substitution.
  onReplace: (currentId: string, nextId: string) => void;
  isFocused: boolean;
  chatContext: string;
  chatPlaceholder: string;
  /** Applies scelo-models directives from this chat's replies. */
  onStackDirective?: (text: string) => string | undefined;
  /** Deterministic stack commands, tried before the provider. */
  onLocalStackCommand?: (text: string, assistantHistory?: string[]) => string | null;
};

const FIT_MARK: Record<ModelFit["state"], string> = { ready: "✓", illustrative: "~", blocked: "✗" };

function ToolNode({ data }: NodeProps<ToolNodeData>) {
  const { theme } = useContext(BlueprintContext);
  const palette = theme === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const color = palette[data.model.family];
  const dim = !data.selected;
  const [chatOpen, setChatOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);

  // Replacements: drop-ins that read the same inputs first, then the rest
  // by family — each ranked and marked by how it sits with this data.
  const { fitOf } = data;
  const swapSections = useMemo(() => {
    if (!swapOpen) return [];
    const mine = new Set(portsOf(data.model.id).inputs.flatMap((p) => p.accepts));
    const same: CatalogModel[] = [];
    const byFamily = new Map<ModelFamily, CatalogModel[]>();
    for (const m of MODEL_CATALOG) {
      if (m.id === data.model.id) continue;
      if (portsOf(m.id).inputs.some((p) => p.accepts.some((t) => mine.has(t)))) same.push(m);
      else byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m]);
    }
    const rank = (list: CatalogModel[]) =>
      list
        .map((m) => ({ m, fit: fitOf(m.id) }))
        .sort((a, b) => FIT_RANK[a.fit.state] - FIT_RANK[b.fit.state]);
    return [
      ...(same.length ? [{ title: "reads the same inputs", items: rank(same) }] : []),
      ...[...byFamily].map(([family, list]) => ({ title: family, items: rank(list) })),
    ];
  }, [swapOpen, data.model.id, fitOf]);

  const rows = Math.max(data.inputs.length, data.outputs.length);

  return (
    <div
      className={`ia-node-in glass-card w-[240px] rounded-md transition ${data.isFocused ? "ring-2 ring-primary" : ""}`}
      style={{
        // Family colour is data-bearing — inline `borderColor` wins over
        // the `.glass-card` 1px hairline so the model family stays legible.
        borderColor: color,
        borderWidth: 1,
        opacity: dim ? 0.55 : 1,
      }}
    >
      {/* header band — Blueprint nodes carry their kind in a tinted title bar */}
      <div
        className="rounded-t-md px-2 pb-1 pt-1.5"
        style={{ background: `linear-gradient(90deg, ${color}26, ${color}08 70%, transparent)` }}
      >
        <div className="flex items-start justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color }}>
              {data.model.family}
            </span>
            {data.model.illustrative && (
              <span
                className="rounded border border-border px-1 font-mono text-[8px] uppercase tracking-wider text-fg-dim"
                title={`Illustrative: ${data.model.illustrative}.`}
              >
                illustrative
              </span>
            )}
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
      </div>

      {/* pins — inputs left, outputs right, one row each; only the pins
          this model really has (see modelPorts.ts) */}
      {rows > 0 && (
        <div className="border-t py-1" style={{ borderColor: `${color}33` }}>
          {Array.from({ length: rows }, (_, i) => {
            const input = data.inputs[i];
            const output = data.outputs[i];
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional — row i pairs input i with output i.
                key={i}
                className="relative flex items-center justify-between gap-2 px-2.5"
                style={{ height: PIN_ROW_H }}
              >
                {input ? (
                  <span
                    className="flex min-w-0 items-baseline gap-1 text-[10.5px]"
                    title={input.detail}
                  >
                    <span
                      className="shrink-0"
                      style={{
                        color:
                          input.tone === "missing"
                            ? "rgb(var(--rgb-error))"
                            : portColorOf(input.type, theme),
                      }}
                    >
                      {input.port.label}
                    </span>
                    {/* The fix button says it all when there is one. */}
                    {input.note && !input.fix && (
                      <span
                        className={`min-w-0 truncate font-mono text-[9px] ${
                          input.tone === "missing"
                            ? "text-error"
                            : input.tone === "fallback"
                              ? "text-warn"
                              : "italic text-fg-dim"
                        }`}
                      >
                        · {input.note}
                      </span>
                    )}
                    {input.fix && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          input.fix?.run();
                        }}
                        className="nodrag shrink-0 rounded border border-primary/50 px-1 font-mono text-[9px] leading-[13px] text-primary hover:bg-primary/10"
                      >
                        {input.fix.label}
                      </button>
                    )}
                  </span>
                ) : (
                  <span />
                )}
                {output && (
                  <span
                    className="shrink-0 text-right text-[10.5px]"
                    style={{ color: portColorOf(output.port.type, theme) }}
                    title={output.detail}
                  >
                    {output.port.label}
                  </span>
                )}
                {input && (
                  <PinHandle
                    side="in"
                    handleId={inHandleId(input.port.id)}
                    type={input.type}
                    filled={input.filled}
                    missing={input.tone === "missing"}
                    connectableStart={input.draggable}
                    title={input.detail}
                  />
                )}
                {output && (
                  <PinHandle
                    side="out"
                    handleId={outHandleId(output.port.id)}
                    type={output.port.type}
                    filled={output.filled}
                    title={output.detail}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="px-2 pb-2">
        <p className="mt-1 line-clamp-2 text-[10px] text-fg-mute">
          <SciText>{data.rationale ?? data.model.description}</SciText>
        </p>
        {/* Say it HERE, before Hard: a model whose inputs are not in the data
            can only come back as "not applicable". One line, full reason on
            hover. */}
        {data.blocked && (
          <p className="mt-1 truncate text-[10px] text-warn" title={data.blocked}>
            ⚠ can't run: {shortCause(data.blocked)}
          </p>
        )}

        {swapOpen && (
          <div
            className="nodrag nowheel mt-1.5 max-h-52 overflow-auto rounded-xl border border-border bg-bg-1 p-1.5"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.15em] text-fg-dim">
              replace with…{" "}
              <span className="normal-case tracking-normal">✓ fits · ✗ can't run</span>
            </div>
            {swapSections.map((section) => (
              <div key={section.title} className="mb-1.5 last:mb-0">
                <div className="font-mono text-[8px] uppercase tracking-wider text-fg-dim">
                  {section.title}
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {section.items.map(({ m, fit }) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        disabled={fit.state === "blocked"}
                        title={fit.state === "ready" ? m.description : fit.reason}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSwapOpen(false);
                          data.onReplace(data.model.id, m.id);
                        }}
                        className="flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-fg-mute hover:bg-bg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      >
                        <span
                          className={`w-2 shrink-0 text-center ${
                            fit.state === "ready"
                              ? "text-primary"
                              : fit.state === "blocked"
                                ? "text-fg-dim"
                                : "text-fg-mute"
                          }`}
                        >
                          {FIT_MARK[fit.state]}
                        </span>
                        <span className="truncate">{m.name}</span>
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
            onAssistantFinal={data.onStackDirective}
            onLocalCommand={data.onLocalStackCommand}
          />
        )}
      </div>
    </div>
  );
}

const NODE_TYPES = { hub: HubNode, tool: ToolNode };
// Every wire in this workstation is a typed Blueprint wire; model → model
// wires carry a click-to-unplug × at their midpoint.
const EDGE_TYPES = { wire: WireEdge };

// Node widths (px) and the gaps of the left-to-right layout.
const HUB_W = 270;
const TOOL_W = 240;
const COL_GAP = 76;
const ROW_GAP = 26;

/** Height guesses for the first layout pass — React Flow's measurements
 *  replace them as soon as the nodes render. */
function estimateHubHeight(rows: number): number {
  return 160 + rows * PIN_ROW_H;
}
function estimateToolHeight(modelId: string, blocked: boolean): number {
  const p = portsOf(modelId);
  const rows = Math.max(p.inputs.length, p.outputs.length);
  return 56 + (rows > 0 ? rows * PIN_ROW_H + 9 : 0) + 30 + (blocked ? 16 : 0) + 30;
}

type XY = { x: number; y: number };

/** The nearest spot at or below `at` where a w × h node overlaps nothing. */
function freeSpot(
  at: XY,
  w: number,
  h: number,
  taken: Array<{ x: number; y: number; w: number; h: number }>,
): XY {
  const pad = 18;
  let y = at.y;
  for (let guard = 0; guard < 64; guard++) {
    const hit = taken.find(
      (r) =>
        at.x < r.x + r.w + pad && at.x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y,
    );
    if (!hit) break;
    y = hit.y + hit.h + pad;
  }
  return { x: at.x, y };
}

/**
 * Left-to-right Blueprint layout. The hub is column 0; each model sits one
 * column past its deepest wired source (pipelineDepths). The first model
 * column lines up in the order of the hub pins its models read, so the
 * hub's wires fan out without crossing, centred on the hub's midline;
 * further right, each model sits level with the average of its sources,
 * pushed down only as far as it takes not to overlap.
 */
function blueprintLayout(args: {
  ids: string[];
  wires: ModelWire[];
  heights: Map<string, number>;
  hubHeight: number;
  roleOrder: DataPortType[];
}): { hub: XY; models: Map<string, XY> } {
  const { ids, wires, heights, hubHeight, roleOrder } = args;
  const depth = pipelineDepths(ids, wires);
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }
  const h = (id: string) => heights.get(id) ?? 160;
  const roleRank = (id: string) => {
    let best = roleOrder.length;
    for (const p of portsOf(id).inputs) {
      for (const t of p.accepts) {
        const i = roleOrder.indexOf(t as DataPortType);
        if (i >= 0 && i < best) best = i;
      }
    }
    return best;
  };
  const centre = new Map<string, number>();
  const models = new Map<string, XY>();
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    const colIds = columns.get(col) ?? [];
    const x = HUB_W + COL_GAP + col * (TOOL_W + COL_GAP);
    if (col === 0) {
      colIds.sort((a, b) => roleRank(a) - roleRank(b) || ids.indexOf(a) - ids.indexOf(b));
      const total =
        colIds.reduce((s, id) => s + h(id), 0) + ROW_GAP * Math.max(0, colIds.length - 1);
      let y = -total / 2;
      for (const id of colIds) {
        models.set(id, { x, y });
        centre.set(id, y + h(id) / 2);
        y += h(id) + ROW_GAP;
      }
      continue;
    }
    const want = (id: string) => {
      const ys = wires
        .filter((w) => w.target === id && centre.has(w.source))
        .map((w) => centre.get(w.source) as number);
      return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
    };
    colIds.sort((a, b) => want(a) - want(b) || ids.indexOf(a) - ids.indexOf(b));
    let floor = Number.NEGATIVE_INFINITY;
    for (const id of colIds) {
      const y = Math.max(want(id) - h(id) / 2, floor);
      models.set(id, { x, y });
      centre.set(id, y + h(id) / 2);
      floor = y + h(id) + ROW_GAP;
    }
  }
  return { hub: { x: 0, y: -hubHeight / 2 }, models };
}

// ── chatbar ──────────────────────────────────────────────────────────────────

/** What the dataset hub's pins offer, for the chat contexts. */
function dataProvidesLines(roles: DataRole[]): string[] {
  if (roles.length === 0) return ["DATA PROVIDES: nothing any catalog model reads."];
  return [
    "DATA PROVIDES (the dataset hub's output pins — found by the same checks the models run):",
    ...roles.map(
      (r) =>
        `  • ${PORT_TYPES[r.type].label}: ${r.columns.slice(0, 6).join(", ")}${
          r.columns.length > 6 ? " …" : ""
        } (${r.evidence})${r.caveat ? ` — ${r.caveat}` : ""}`,
    ),
  ];
}

/** The canvas's model → model wires — the flows Hard executes. */
function wiresLines(wires: ModelWire[]): string[] {
  if (wires.length === 0) {
    return ["WIRES (model → model): none — every attached model reads the dataset directly."];
  }
  return [
    "WIRES (model → model; Hard runs sources first and hands their results on):",
    ...wires.map((w) => {
      const pair = resolveWire(w.source, w.target);
      return `  • ${w.source} → ${w.target}${pair ? ` (${pair.output.label} → ${pair.input.label})` : ""}`;
    }),
  ];
}

const CANVAS_RULES = [
  "CANVAS: a Blueprint-style graph. Each model shows only its real pins — inputs left, outputs right — and a wire joins an output to a compatible input (the user drags it, or you emit wire / unwire in the stack directive). The only model → model flows that exist: lee-carter or cbd → lifecontingencies (projected mortality priced as a cohort), glm-frequency → glm-severity (pure premium), gbm → shap (shap explains the wired GBM; without one it cannot run), esg → scr-standard (rate stress). Reserving methods take no model inputs: Mack and the bootstrap refit chain ladder themselves, and a chain-ladder prior would collapse Bornhuetter–Ferguson onto chain ladder.",
];

function buildToolsStageContext(args: {
  dataset: Dataset | null;
  domain: ModelFamily | null;
  selected: SelectedModel[];
  summary: string | null;
  roles: DataRole[];
  wires: ModelWire[];
}): string {
  const { dataset, domain, selected, summary, roles, wires } = args;
  const lines = [
    "You are Scelo at the TOOLS stage of the pipeline.",
    "The user is inside the tools workstation, picking statistical / actuarial models for their dataset.",
    "Help them understand the model picks, swap models, and prepare for the Hard Data stage.",
    "Stay focused on model choice / methodology — do not pre-empt the final outputs or re-collect raw data.",
    "",
    "## ANSWER SHAPE (strict)",
    "Reply in 1 to 4 short sentences. Lead with the verdict (keep / add / remove / swap and WHY), then the evidence from the dataset shape below. No preamble, no methodology lectures unless asked.",
    "When the user asks to change the stack (add / remove / swap / enable / disable a model), EMIT the stack directive from the PROTOCOL below — do not merely describe the change.",
    "When asked 'why these models', ground the answer in the SELECTED MODELS rationales and the column evidence — cite column names, row count, missingness. Never a generic 'these are industry standard'.",
    "When a model is a poor fit for the data shape, say so plainly and name the better catalog id.",
    "",
    "## OUTPUT CHARACTERS (strict)",
    "Plain ASCII punctuation only: straight quotes, plain hyphens, three dots. No smart quotes, em-dashes, or other typographic Unicode — they render as replacement glyphs here.",
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
  lines.push(...dataProvidesLines(roles));
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
  lines.push(...wiresLines(wires), ...CANVAS_RULES);
  if (summary) lines.push(`PICK SUMMARY: ${summary}`);
  lines.push(modelDirectiveProtocol());
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
  roles: DataRole[];
  wires: ModelWire[];
}): string {
  const { dataset, domain, selected, summary, roles, wires } = args;
  const lines = [
    "You are Scelo speaking FROM THE DATASET HUB node of the Tools workstation.",
    "Your scope is the dataset as a whole and the overall model mix attached to this hub.",
    "Recommend additions, removals, or rebalancing; sanity-check the identified domain; flag gaps.",
    "Stay at the hub level — defer model-internals questions to the individual model nodes.",
    "",
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
    `COLUMNS: ${dataset.columns.join(", ")}.`,
    `IDENTIFIED DOMAIN: ${domain ?? "unknown"}.`,
    ...dataProvidesLines(roles),
  ];
  if (selected.length === 0) {
    lines.push("ATTACHED MODELS: none yet — suggest a starter mix grounded in DATA PROVIDES.");
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
  lines.push(...wiresLines(wires), ...CANVAS_RULES);
  if (summary) lines.push(`PICK SUMMARY: ${summary}`);
  lines.push(modelDirectiveProtocol());
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
  pins: { inputs: ToolInputPin[]; outputs: ToolOutputPin[] };
}): string {
  const { dataset, domain, selected, focus, focusModel, pins } = args;
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
    ...(focusModel.illustrative
      ? [`ILLUSTRATIVE: its figures are ${focusModel.illustrative}.`]
      : []),
    `SOURCE: ${focus.source}${focus.enabled ? "" : " (currently disabled)"}`,
    `RATIONALE FOR THIS PICK: ${focus.rationale ?? focusModel.description}`,
    ...(pins.inputs.length > 0
      ? [
          "INPUT PINS (as wired on the canvas):",
          ...pins.inputs.map(
            (p) => `  • ${p.port.label}${p.port.required ? "" : " (optional)"}: ${p.detail}`,
          ),
        ]
      : ["INPUT PINS: none — it reads no columns."]),
    ...(pins.outputs.length > 0
      ? ["OUTPUT PINS:", ...pins.outputs.map((p) => `  • ${p.port.label}: ${p.detail}`)]
      : []),
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
  lines.push(modelDirectiveProtocol());
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
  // Neutral box; the colour lives in the bar and the label only.
  const wrapCls = "border-border/70";
  const barCls = tone ? tone.bar : "bg-border";
  const labelCls = tone ? tone.label : "text-fg-dim";
  return (
    <div
      className={`relative overflow-hidden rounded border ${wrapCls} bg-bg px-2 py-1.5 pl-2.5`}
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
      <div className="border-b border-border px-3 py-1.5 pr-8 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
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
  pins,
  blocked,
  fitOf,
  onToggle,
  onRemove,
  onAdd,
  catalogModelsByFamily,
}: {
  focused: CatalogModel | null;
  selected: SelectedModel[];
  /** The focused model's pins as the canvas has them wired. */
  pins: { inputs: ToolInputPin[]; outputs: ToolOutputPin[] } | null;
  /** Why the focused model can't run, if it can't. */
  blocked?: string;
  fitOf: (id: string) => ModelFit;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (id: string) => void;
  catalogModelsByFamily: Map<ModelFamily, CatalogModel[]>;
}) {
  const { resolved } = useTheme();
  const theme: Theme = resolved === "light" ? "light" : "dark";
  const palette = theme === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;

  const focusedSelection = focused ? selected.find((m) => m.id === focused.id) : null;
  const focusedFit = focused ? fitOf(focused.id) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1.5 pl-8 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
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
              <p className="mt-1 text-[11px] text-fg-mute">
                <SciText>{focused.description}</SciText>
              </p>
            </div>

            {/* Can it run? — the data check plus the canvas's wiring. */}
            {focusedSelection ? (
              blocked ? (
                <div className="rounded border border-warn/50 bg-warn/5 p-2 text-[11px] leading-snug text-warn">
                  ⚠ can't run here: {blocked}
                </div>
              ) : (
                <div className="rounded border border-primary/40 bg-primary/5 p-2 text-[11px] leading-snug text-primary">
                  ✓ ready — every input is fed
                  {focusedSelection.enabled ? "" : " (switched off: Hard will skip it)"}
                </div>
              )
            ) : (
              focusedFit?.state === "blocked" && (
                <div className="rounded border border-border bg-bg p-2 text-[11px] leading-snug text-fg-dim">
                  ✗ can't run on this data: {focusedFit.reason}
                </div>
              )
            )}
            {focused.illustrative && (
              <div className="rounded border border-border bg-bg p-2 text-[11px] leading-snug text-fg-mute">
                <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  illustrative ·{" "}
                </span>
                its figures are {focused.illustrative}.
              </div>
            )}

            {pins && pins.inputs.length + pins.outputs.length > 0 && (
              <div className="rounded border border-border bg-bg p-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  pins
                </div>
                <ul className="space-y-1">
                  {pins.inputs.map((p) => (
                    <li key={`in:${p.port.id}`} className="flex gap-1.5 text-[11px] leading-snug">
                      <span
                        aria-hidden
                        className="mt-[5px] inline-block h-2 w-2 shrink-0"
                        style={{
                          background: portColorOf(p.type, theme),
                          borderRadius: PORT_TYPES[p.type].provenance === "result" ? 1 : 999,
                          transform:
                            PORT_TYPES[p.type].provenance === "result"
                              ? "rotate(45deg)"
                              : undefined,
                        }}
                      />
                      <span>
                        <span className="text-fg">in · {p.port.label}</span>
                        <span className="text-fg-dim">
                          {p.port.required ? " (required)" : " (optional)"} — {p.detail}
                        </span>
                      </span>
                    </li>
                  ))}
                  {pins.outputs.map((p) => (
                    <li key={`out:${p.port.id}`} className="flex gap-1.5 text-[11px] leading-snug">
                      <span
                        aria-hidden
                        className="mt-[5px] inline-block h-2 w-2 shrink-0 rotate-45 rounded-[1px]"
                        style={{ background: portColorOf(p.port.type, theme) }}
                      />
                      <span>
                        <span className="text-fg">out · {p.port.label}</span>
                        <span className="text-fg-dim"> — {p.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pins && pins.inputs.length + pins.outputs.length === 0 && (
              <p className="text-[11px] leading-snug text-fg-dim">
                No pins: it reads no columns and feeds no other model.
              </p>
            )}

            {focusedSelection?.rationale && (
              <div className="rounded border border-border bg-bg p-2">
                <div className="mb-0.5 font-mono text-[9px] uppercase text-fg-dim">
                  {focusedSelection.source === "ai" ? "ai rationale" : "user pick"}
                </div>
                <p className="text-[11px] text-fg-mute">
                  <SciText>{focusedSelection.rationale}</SciText>
                </p>
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
            Click a model node on the canvas, or pick one from the catalog below. Drop a wire on
            empty canvas — or right-click it — for the models that fit.
          </p>
        )}

        <div className="mt-6">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            catalog
          </div>
          <p className="mb-2 text-[10px] leading-snug text-fg-dim">
            <span className="text-primary">✓</span> runs on this data ·{" "}
            <span className="text-fg-mute">~</span> illustrative ·{" "}
            <span className="text-fg-dim">✗</span> its inputs aren't here
          </p>
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
                    const fit = fitOf(m.id);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => (isSelected ? onRemove(m.id) : onAdd(m.id))}
                          title={
                            fit.state === "ready"
                              ? m.description
                              : `${fit.reason}${isSelected ? "" : fit.state === "blocked" ? " Attaches switched off." : ""}`
                          }
                          className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-left font-mono text-[10px] transition ${
                            isSelected
                              ? "border-primary bg-primary/10 text-primary"
                              : fit.state === "blocked"
                                ? "border-transparent text-fg-dim opacity-60 hover:border-border hover:bg-bg-2"
                                : "border-transparent text-fg-mute hover:border-border hover:bg-bg-2"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={`w-2 shrink-0 text-center ${
                                fit.state === "ready"
                                  ? "text-primary"
                                  : fit.state === "blocked"
                                    ? "text-fg-dim"
                                    : "text-fg-mute"
                              }`}
                            >
                              {FIT_MARK[fit.state]}
                            </span>
                            <span className="truncate">{m.name}</span>
                          </span>
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

/** The add menu, open at a canvas point. `flow` is where a picked model lands. */
type MenuState = {
  x: number;
  y: number;
  flow: XY | null;
  title: string;
  subtitle?: string;
  sections: MenuSection[];
  onPick: (key: string) => void;
};

export function ToolsWorkstation() {
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const theme: Theme = resolved === "light" ? "light" : "dark";
  const {
    dataset,
    selectedModels,
    setSelectedModels,
    domain,
    setDomain,
    pickSummary,
    setPickSummary,
    picksDatasetName,
    setPicksDatasetName,
    modelWires,
    setModelWires,
    logEvent,
  } = useScelo();

  // Actuarial tables from the Tools chat too — "build a commutation table
  // at 4 %" while picking models should just work; typed prompts are also
  // read for table ideas.
  const tableChat = useActuarialTableChat("tools", dataset);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "fallback">("idle");
  const [regenSeed, setRegenSeed] = useState(0);
  const previousIdsRef = useRef<string[]>([]);
  // The ids of the LAST AI pick, in pick order. Drives the justification
  // bubble on the canvas: while the attached roster still equals this set,
  // the bubble explains why THESE models; the moment the user adds, removes
  // or swaps one, the roster is theirs — the justification no longer
  // describes what's on screen, so the bubble goes. Local state on purpose
  // (not persisted): after a reload the summary still lives in the chat
  // context, but a stale bubble should not reappear over a curated stack.
  const [aiPickIds, setAiPickIds] = useState<string[] | null>(null);
  const [pickBubbleDismissed, setPickBubbleDismissed] = useState(false);

  // Column metas — used both for the LLM prompt and the heuristic. We
  // profile the raw dataset (not the filtered slice) because model
  // selection is about the dataset's intrinsic shape, not the user's
  // current filter view. getColumnMetas is the shared WeakMap-cached
  // profiling pass — mounting this workstation must not re-scan a
  // dataset another pane already profiled (a full re-summarise freezes
  // the main thread for seconds at import scale).
  const columnMetas = useMemo<ColumnMeta[]>(() => {
    if (!dataset) return [];
    return getColumnMetas(dataset);
  }, [dataset]);

  const signature: DataSignature | null = useMemo(
    () => (dataset ? dataSignature(dataset, columnMetas) : null),
    [dataset, columnMetas],
  );

  // What the data can feed — the hub's output pins — found by the same
  // detectors the runners use, so a pin is a promise Hard keeps.
  const roles = useMemo(() => (dataset ? detectDataRoles(dataset) : []), [dataset]);
  const dataTypes = useMemo(() => dataTypesOf(roles), [roles]);

  // How each catalog model sits against this data (cached per dataset in
  // modelApplicability, so the catalog and menus can ask freely).
  const fitOf = useCallback(
    (id: string): ModelFit => {
      const model = MODEL_BY_ID.get(id);
      if (!model || !dataset) return { state: "blocked", reason: "Load a dataset first." };
      const ok = modelApplicability(id, dataset);
      if (!ok.ok) return { state: "blocked", reason: ok.reason };
      if (model.illustrative) {
        return { state: "illustrative", reason: `Illustrative: ${model.illustrative}.` };
      }
      return { state: "ready" };
    },
    [dataset],
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
          // Picks the data cannot feed arrive switched off (visible in
          // Tools with the reason; Hard does not run them).
          const picks: SelectedModel[] = res.selected.map((s) => ({
            id: s.id,
            enabled: !s.disabled,
            source: "ai",
            rationale: s.rationale,
          }));
          setSelectedModels(picks);
          setPicksDatasetName(dataset.name);
          previousIdsRef.current = picks.map((p) => p.id);
          setAiPickIds(picks.map((p) => p.id));
          setPickBubbleDismissed(false);
          setStatus("ready");
          logEvent({
            stage: "tools",
            kind: "models.aiPick",
            payload: {
              domain: res.domain,
              summary: res.summary,
              source: "ai",
              models: res.selected
                .filter((s) => !s.disabled)
                .map((s) => ({ id: s.id, rationale: s.rationale })),
            },
          });
        })
        .catch(() => {
          if (ac.signal.aborted || !signature) return;
          // Pass the regenerate counter through so pressing regenerate
          // while offline rotates deterministic same-family alternates
          // instead of silently returning the identical list.
          const fallback = finalizePick(heuristicPick(signature, variant), dataset);
          setDomain(fallback.domain);
          setPickSummary(fallback.summary);
          // Picks the data cannot feed arrive switched off (visible in
          // Tools with the reason; Hard does not run them).
          const picks: SelectedModel[] = fallback.selected.map((s) => ({
            id: s.id,
            enabled: !s.disabled,
            source: "ai",
            rationale: s.rationale,
          }));
          setSelectedModels(picks);
          setPicksDatasetName(dataset.name);
          previousIdsRef.current = picks.map((p) => p.id);
          setAiPickIds(picks.map((p) => p.id));
          setPickBubbleDismissed(false);
          setStatus("fallback");
          logEvent({
            stage: "tools",
            kind: "models.aiPick",
            payload: {
              domain: fallback.domain,
              summary: fallback.summary,
              source: "fallback",
              models: fallback.selected
                .filter((s) => !s.disabled)
                .map((s) => ({ id: s.id, rationale: s.rationale })),
            },
          });
        });
      return ac;
    },
    [
      dataset,
      columnMetas,
      signature,
      setDomain,
      setSelectedModels,
      setPickSummary,
      setPicksDatasetName,
      logEvent,
    ],
  );

  // Initial identification on mount, and re-identification whenever the
  // dataset NAME changes from the one the current picks were computed for
  // (tracked in context and persisted with the session, so the comparison
  // survives full reloads). Keyed on name, not object identity: cleaning /
  // derived-column transforms create new dataset objects with the SAME
  // name and must not clobber a curated pick list, but a different file or
  // sample is a new analysis subject and stale picks would silently
  // mis-route it. Aborts on unmount / dataset swap so we don't race.
  // biome-ignore lint/correctness/useExhaustiveDependencies: regenSeed triggers re-identify; we don't want to refire on selectedModels edits.
  useEffect(() => {
    if (!dataset) return;
    if (selectedModels.length > 0 && picksDatasetName === dataset.name) return;
    const ac = identify(0);
    return () => ac?.abort();
  }, [dataset, picksDatasetName, identify]);

  // Manual regenerate — bumps the variant counter so the LLM gets the
  // "previous picks were X, pick a different mix" nudge.
  const regenerate = useCallback(() => {
    setRegenSeed((s) => s + 1);
  }, []);

  // Justification bubble visibility: the summary describes the AI's pick, so
  // it shows only while the attached roster IS that pick (order-insensitive).
  // Adding, removing or swapping a model breaks the equality and the bubble
  // disappears — the stack is now the user's curation, not the AI's claim.
  // Toggling a model off keeps it: the roster is unchanged, merely muted.
  const pickBubbleVisible = useMemo(() => {
    if (!pickSummary || !aiPickIds || pickBubbleDismissed) return false;
    if (status === "loading") return false;
    if (selectedModels.length !== aiPickIds.length) return false;
    // Every attached model must still be the AI's own pick — remove-then-
    // re-add restores the same id with source "user", and the bubble must
    // not resurrect over a roster the user has already touched.
    if (selectedModels.some((m) => m.source !== "ai")) return false;
    const current = new Set(selectedModels.map((m) => m.id));
    return aiPickIds.every((id) => current.has(id));
  }, [pickSummary, aiPickIds, pickBubbleDismissed, status, selectedModels]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only react to regenSeed; dataset/identify already trigger the first-mount effect above.
  useEffect(() => {
    if (regenSeed === 0 || !dataset) return;
    const ac = identify(regenSeed);
    return () => ac?.abort();
  }, [regenSeed]);

  // Live stack + wires for callbacks that must not go stale (chat replies,
  // React Flow handlers created once).
  const selectedModelsRef = useRef(selectedModels);
  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);
  const modelWiresRef = useRef<ModelWire[]>(modelWires);
  useEffect(() => {
    modelWiresRef.current = modelWires;
  }, [modelWires]);

  // Wires ─────────────────────────────────────────────────────────────────────
  // The session's modelWires ARE the canvas's model → model wires (Hard
  // executes exactly these). New models arrive wired by the session
  // provider (autoWire); here the actuary plugs, unplugs and re-plugs.
  const connect = useCallback(
    (source: string, target: string) => {
      setModelWires((prev) => connectWire(prev, source, target));
      logEvent({
        stage: "tools",
        kind: "model.wire",
        payload: { source, target, connected: true },
      });
    },
    [setModelWires, logEvent],
  );
  const unplug = useCallback(
    (source: string, target: string) => {
      setModelWires((prev) => disconnectWire(prev, source, target));
      logEvent({
        stage: "tools",
        kind: "model.wire",
        payload: { source, target, connected: false },
      });
    },
    [setModelWires, logEvent],
  );

  // Canvas arrangement: laid out automatically until the actuary drags a
  // node (or drops one where they want it); "re-layout" hands it back.
  const arrangedRef = useRef(false);
  const pendingPositionsRef = useRef(new Map<string, XY>());
  // Where the nodes are now (for placing a dropped node clear of them).
  const nodesRef = useRef<Node[]>([]);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

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
  /**
   * Attach a model — with whatever it cannot run without (SHAP arrives with
   * the GBM it explains), switched on only if the data can feed it — and
   * optionally drop it at a canvas point and plug it to a given model.
   */
  const addModel = useCallback(
    (id: string, opts: { at?: XY; wireFrom?: string; wireInto?: string } = {}) => {
      const model = MODEL_BY_ID.get(id);
      if (!model || !dataset) return;
      const present = new Set(selectedModelsRef.current.map((m) => m.id));
      if (!present.has(id)) {
        const pulls = requiredProducers(id).filter((p) => !present.has(p));
        const arrivals: SelectedModel[] = [...pulls, id].map((mid) => ({
          id: mid,
          enabled: modelApplicability(mid, dataset).ok,
          source: "user",
          rationale:
            mid === id ? model.description : `Supplies the fitted model ${model.name} explains.`,
        }));
        setSelectedModels((prev) => [
          ...prev,
          ...arrivals.filter((m) => !prev.some((p) => p.id === m.id)),
        ]);
        for (const m of arrivals)
          logEvent({ stage: "tools", kind: "model.add", payload: { id: m.id } });
        // While the canvas lays itself out, a new node takes its slot in the
        // left-to-right flow. Once the actuary has arranged it by hand, the
        // node lands where it was dropped — nudged clear of the others — and
        // anything it brings along sits just to its left.
        if (opts.at && arrangedRef.current) {
          const taken = nodesRef.current.map((n) => ({
            x: n.position.x,
            y: n.position.y,
            w: n.width ?? TOOL_W,
            h: n.height ?? 160,
          }));
          const place = (mid: string, at: XY) => {
            const h = estimateToolHeight(mid, false);
            const spot = freeSpot(at, TOOL_W, h, taken);
            taken.push({ ...spot, w: TOOL_W, h });
            pendingPositionsRef.current.set(modelNodeId(mid), spot);
            return spot;
          };
          const spot = place(id, opts.at);
          for (const p of pulls) place(p, { x: spot.x - TOOL_W - COL_GAP, y: spot.y });
        }
      }
      if (opts.wireFrom) connect(opts.wireFrom, id);
      if (opts.wireInto) connect(id, opts.wireInto);
    },
    [dataset, setSelectedModels, logEvent, connect],
  );
  const onAdd = useCallback((id: string) => addModel(id), [addModel]);
  // Swap one model for another in-place. Replaces the entry at the same
  // index so the node takes the old one's slot and the stack's order is
  // stable; the replacement is switched on only if the data can feed it.
  const onReplace = useCallback(
    (currentId: string, nextId: string) => {
      if (currentId === nextId) return;
      const next = MODEL_BY_ID.get(nextId);
      if (!next || !dataset) return;
      setSelectedModels((prev) => {
        const idx = prev.findIndex((m) => m.id === currentId);
        if (idx < 0) return prev;
        // If the replacement is already in the selection, just drop the
        // current one to avoid duplicates.
        if (prev.some((m) => m.id === nextId)) return prev.filter((m) => m.id !== currentId);
        const copy = [...prev];
        copy[idx] = {
          id: nextId,
          enabled: modelApplicability(nextId, dataset).ok,
          source: "user",
          rationale: next.description,
        };
        return copy;
      });
      // Audit both halves of the swap so the export script log reflects it.
      logEvent({ stage: "tools", kind: "model.remove", payload: { id: currentId } });
      logEvent({ stage: "tools", kind: "model.add", payload: { id: nextId } });
    },
    [dataset, setSelectedModels, logEvent],
  );

  // Catalog grouped by family for the right panel; within a family, what
  // runs on this data first, the illustrative next, what can't run last.
  const catalogByFamily = useMemo(() => {
    const m = new Map<ModelFamily, CatalogModel[]>();
    for (const model of MODEL_CATALOG) {
      const arr = m.get(model.family) ?? [];
      arr.push(model);
      m.set(model.family, arr);
    }
    for (const [family, list] of m) {
      m.set(
        family,
        [...list].sort((x, y) => FIT_RANK[fitOf(x.id).state] - FIT_RANK[fitOf(y.id).state]),
      );
    }
    return m;
  }, [fitOf]);

  const enabledCount = selectedModels.filter((m) => m.enabled).length;

  // Chat-driven stack mutations. Every completed assistant reply from any
  // Tools chat passes through here: if it carries a scelo-models directive,
  // apply it against the LIVE stack (ref, not closure — the memo'd context
  // the chat was created with may be stale by the time the reply lands),
  // log the same events the manual add/remove buttons do, and swap the
  // machine block for a plain confirmation of what actually happened.
  // Apply a stack directive — a chat reply's fenced block or a
  // deterministic command — to the LIVE stack and wiring (refs, not
  // closures: the memo'd chat context may be stale by the time a reply
  // lands), log the same events the canvas does, and say what happened.
  const applyStackDirective = useCallback(
    (directive: ModelDirective): string => {
      const { next, report } = applyModelDirective(selectedModelsRef.current, directive);
      const changed =
        report.added.length > 0 ||
        report.removed.length > 0 ||
        report.enabled.length > 0 ||
        report.disabled.length > 0;
      if (changed) {
        setSelectedModels(next);
        for (const id of report.added) {
          logEvent({ stage: "tools", kind: "model.add", payload: { id } });
        }
        for (const id of report.removed) {
          logEvent({ stage: "tools", kind: "model.remove", payload: { id } });
        }
        for (const id of [...report.enabled, ...report.disabled]) {
          logEvent({
            stage: "tools",
            kind: "model.toggle",
            payload: { id, enabled: report.enabled.includes(id) },
          });
        }
      }
      // Wires land against the stack AFTER the adds / removes, so "add CBD
      // and price the annuity on it" works in one block.
      const wiring = applyWireDirective(
        modelWiresRef.current,
        directive,
        next.map((m) => m.id),
      );
      if (wiring.next !== modelWiresRef.current) {
        setModelWires(wiring.next);
        const log = (op: { from: string; to: string }, connected: boolean) =>
          logEvent({
            stage: "tools",
            kind: "model.wire",
            payload: { source: op.from, target: op.to, connected },
          });
        for (const op of wiring.report.replaced) log(op, false);
        for (const op of wiring.report.unwired) log(op, false);
        for (const op of wiring.report.wired) log(op, true);
      }
      const wireText = describeWireReport(wiring.report);
      const modelText = changed || !wireText ? describeDirectiveReport(report) : "";
      return [modelText, wireText].filter(Boolean).join(" · ");
    },
    [setSelectedModels, setModelWires, logEvent],
  );

  // Every completed assistant reply from any Tools chat passes through
  // here: a scelo-models block is applied and swapped for a plain
  // confirmation of what actually happened.
  const onChatStackDirective = useCallback(
    (text: string): string | undefined => {
      const directive = parseModelDirective(text);
      if (!directive) return undefined;
      return replaceDirectiveBlock(text, applyStackDirective(directive));
    },
    [applyStackDirective],
  );

  // Deterministic stack commands — tried before the provider. "add all the
  // suggested models" resolves the ids from the assistant's own prior
  // replies (newest first, skipping confirmations that only re-list the
  // attached stack), so acceptance never depends on the LLM remembering
  // what it proposed. Explicit "add glm-frequency / remove mack / swap X
  // for Y / wire cbd into lifecontingencies" resolve straight from the
  // catalog. Returns null → normal chat.
  const applyDirectiveAndDescribe = useCallback(
    (directive: ReturnType<typeof parseStackCommand>): string | null =>
      directive ? `**stack update:** ${applyStackDirective(directive)}` : null,
    [applyStackDirective],
  );
  const onChatStackCommand = useCallback(
    (text: string, assistantHistory?: string[]): string | null => {
      // Table requests first: they name tables explicitly, whereas the stack
      // parser is happy to read "add …" loosely.
      const tableReply = tableChat.onLocalCommand(text);
      if (tableReply !== null) return tableReply;
      return applyDirectiveAndDescribe(
        parseStackCommand(text, assistantHistory ?? [], selectedModelsRef.current),
      );
    },
    [applyDirectiveAndDescribe, tableChat.onLocalCommand],
  );

  // Pins ──────────────────────────────────────────────────────────────────────
  // Each model's pins as the canvas has them wired: what feeds every input
  // (the dataset, another model, the pin's default, or nothing), and where
  // every output goes.
  const pinsFor = useCallback(
    (sm: SelectedModel): { inputs: ToolInputPin[]; outputs: ToolOutputPin[] } => {
      const nameOf = (id: string) => MODEL_BY_ID.get(id)?.name ?? id;
      const roleOf = (t: DataPortType) => roles.find((r) => r.type === t);
      const fromData = (t: DataPortType) => {
        const r = roleOf(t);
        return `from the dataset — ${r ? `${r.columns.slice(0, 4).join(", ")}${r.columns.length > 4 ? " …" : ""} (${r.evidence})` : PORT_TYPES[t].label}`;
      };
      const inputs = inputFeeds(sm.id, selectedModels, modelWires, dataTypes).map(
        ({ port, feed }): ToolInputPin => {
          const draggable = port.accepts.some((t) => !isDataType(t));
          const base = { port, draggable };
          switch (feed.kind) {
            case "data":
              return {
                ...base,
                type: feed.type,
                filled: true,
                tone: "ok",
                detail: fromData(feed.type),
              };
            case "wire": {
              const outType = resolveWire(feed.from, sm.id)?.output.type ?? port.accepts[0];
              if (feed.live) {
                return {
                  ...base,
                  type: outType,
                  filled: true,
                  tone: "ok",
                  detail: `from ${nameOf(feed.from)}'s ${PORT_TYPES[outType].label}`,
                };
              }
              const fb = feed.fallback;
              const using =
                fb?.kind === "data"
                  ? `the dataset's ${PORT_TYPES[fb.type].label}`
                  : fb?.kind === "default"
                    ? fb.text
                    : "nothing";
              return {
                ...base,
                type: outType,
                filled: false,
                tone: fb?.kind === "missing" ? "missing" : "fallback",
                note: `${nameOf(feed.from)} off`,
                detail: `wired from ${nameOf(feed.from)}, which is switched off — so it uses ${using}`,
              };
            }
            case "default":
              return {
                ...base,
                type: port.accepts[0],
                filled: false,
                tone: "default",
                note: feed.text,
                detail: `nothing plugged in — ${feed.text}. ${port.note}`,
              };
            case "missing": {
              const resultTypes = port.accepts.filter((t) => !isDataType(t));
              const producer = resultTypes.flatMap((t) => producersOf(t))[0];
              let fix: ToolInputPin["fix"];
              if (producer) {
                const onCanvas = selectedModels.find((m) => m.id === producer.modelId);
                const pname = nameOf(producer.modelId);
                fix = !onCanvas
                  ? {
                      label: `+ ${pname}`,
                      run: () => addModel(producer.modelId, { wireInto: sm.id }),
                    }
                  : !onCanvas.enabled
                    ? {
                        label: `switch on ${pname}`,
                        run: () => {
                          onToggle(producer.modelId);
                          connect(producer.modelId, sm.id);
                        },
                      }
                    : { label: `plug in ${pname}`, run: () => connect(producer.modelId, sm.id) };
              }
              const what = describeAccepts(port.accepts);
              return {
                ...base,
                type: port.accepts[0],
                filled: false,
                tone: "missing",
                note: resultTypes.length > 0 ? "nothing plugged in" : "not in this data",
                fix,
                detail:
                  resultTypes.length > 0
                    ? `needs ${what} plugged in — nothing is. ${port.note}`
                    : `needs ${what}, and this dataset has none. ${port.note}`,
              };
            }
          }
        },
      );
      const present = new Set(selectedModels.map((m) => m.id));
      const outputs = portsOf(sm.id).outputs.map((port): ToolOutputPin => {
        const to = modelWires
          .filter(
            (w) =>
              w.source === sm.id &&
              present.has(w.target) &&
              resolveWire(w.source, w.target)?.output.id === port.id,
          )
          .map((w) => nameOf(w.target));
        return {
          port,
          filled: to.length > 0,
          detail:
            to.length > 0
              ? `feeds ${to.join(", ")}. ${port.note}`
              : `plugged into nothing yet — drag it onto a model, or onto empty canvas for the ones that take it. ${port.note}`,
        };
      });
      return { inputs, outputs };
    },
    [selectedModels, modelWires, dataTypes, roles, addModel, onToggle, connect],
  );

  // Why a model can't run: the data first (applicability), then any
  // required input nothing on the canvas feeds (SHAP without a GBM).
  const blockedReasonFor = useCallback(
    (sm: SelectedModel): string | undefined => {
      const fit = fitOf(sm.id);
      if (fit.state === "blocked") return fit.reason;
      const unmet = unmetInputs(sm.id, selectedModels, modelWires, dataTypes)[0];
      if (!unmet) return undefined;
      const what = describeAccepts(unmet.accepts);
      return `Needs ${what} plugged into “${unmet.label}” — nothing on the canvas feeds it.`;
    },
    [fitOf, selectedModels, modelWires, dataTypes],
  );

  // Pipeline status for the banner — the Blueprint "compile" readout.
  const pipeline = useMemo(() => {
    let ready = 0;
    let blocked = 0;
    let off = 0;
    for (const m of selectedModels) {
      if (!m.enabled) off++;
      else if (blockedReasonFor(m)) blocked++;
      else ready++;
    }
    return { ready, blocked, off };
  }, [selectedModels, blockedReasonFor]);

  // Hub pins: the roles an attached model reads (its wires land there),
  // plus — expanded, or on an empty canvas — everything else the data can
  // feed, as the place to drag new models from.
  const [hubExpanded, setHubExpanded] = useState(false);
  const usedTypes = useMemo(() => {
    const used = new Set<DataPortType>();
    for (const sm of selectedModels) {
      for (const { feed } of inputFeeds(sm.id, selectedModels, modelWires, dataTypes)) {
        if (feed.kind === "data") used.add(feed.type);
        if (feed.kind === "wire" && feed.fallback?.kind === "data") used.add(feed.fallback.type);
      }
    }
    return used;
  }, [selectedModels, modelWires, dataTypes]);
  const showAllRoles = hubExpanded || selectedModels.length === 0;
  const hubRows = useMemo(
    () =>
      roles
        .filter((r) => showAllRoles || usedTypes.has(r.type))
        .map((role) => ({ role, used: usedTypes.has(role.type) })),
    [roles, usedTypes, showAllRoles],
  );

  // Add menu ──────────────────────────────────────────────────────────────────
  const mainRef = useRef<HTMLElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  /** Place the menu at a client point, clamped inside the canvas. */
  const menuAt = useCallback(
    (clientX: number, clientY: number): { x: number; y: number; flow: XY | null } => {
      const rect = mainRef.current?.getBoundingClientRect();
      const x = rect ? Math.max(8, Math.min(clientX - rect.left, rect.width - 310)) : clientX;
      const y = rect ? Math.max(8, Math.min(clientY - rect.top, rect.height - 400)) : clientY;
      const flow =
        flowInstanceRef.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? null;
      return { x, y, flow };
    },
    [],
  );

  /** One menu entry per model, grouped: fits this data / on the canvas /
   *  can't run here. */
  const entrySections = useCallback(
    (
      ids: string[],
      describe: (id: string) => { hint: string; enabled: boolean; attached: boolean },
    ): MenuSection[] => {
      const ready: MenuEntry[] = [];
      const illustrative: MenuEntry[] = [];
      const attached: MenuEntry[] = [];
      const blocked: MenuEntry[] = [];
      const present = new Set(selectedModelsRef.current.map((m) => m.id));
      for (const id of ids) {
        const m = MODEL_BY_ID.get(id);
        if (!m) continue;
        const d = describe(id);
        const fit = fitOf(id);
        // A model that can't run without another arrives with it — say so.
        const brings = d.attached
          ? []
          : requiredProducers(id)
              .filter((p) => !present.has(p))
              .map((p) => MODEL_BY_ID.get(p)?.name ?? p);
        const entry: MenuEntry = {
          key: id,
          name: m.name,
          family: m.family,
          hint: brings.length
            ? `Arrives with ${brings.join(", ")}, which it needs. ${d.hint}`
            : d.hint,
          enabled: d.enabled,
          attached: d.attached,
        };
        if (d.attached) attached.push(entry);
        else if (fit.state === "blocked")
          blocked.push({ ...entry, enabled: false, hint: fit.reason });
        else if (fit.state === "illustrative") illustrative.push(entry);
        else ready.push(entry);
      }
      return [
        { title: "fits this data", entries: ready },
        { title: "illustrative — built-in assumptions, not your data", entries: illustrative },
        { title: "on the canvas", entries: attached },
        { title: "can't run on this data", entries: blocked },
      ].filter((s) => s.entries.length > 0);
    },
    [fitOf],
  );

  /** Models that take `type` — dropped from an output pin (model or hub). */
  const openConsumersMenu = useCallback(
    (
      type: PortType,
      from: { model: string } | { hub: true },
      clientX: number,
      clientY: number,
      dropped: boolean,
    ) => {
      const at = menuAt(clientX, clientY);
      const fromModel = "model" in from ? from.model : null;
      const present = new Map(selectedModelsRef.current.map((m) => [m.id, m] as const));
      const consumers = consumersOf(type).filter((c) => c.modelId !== fromModel);
      const sections = entrySections(
        consumers.map((c) => c.modelId),
        (id) => {
          const port = consumers.find((c) => c.modelId === id)?.port;
          const onCanvas = present.has(id);
          if (!onCanvas) {
            return {
              hint: `${MODEL_BY_ID.get(id)?.description ?? ""} Reads it through “${port?.label}”.`,
              enabled: true,
              attached: false,
            };
          }
          if (!fromModel)
            return { hint: "already reads it from the dataset", enabled: false, attached: true };
          const plugged = modelWiresRef.current.some(
            (w) => w.source === fromModel && w.target === id,
          );
          return {
            hint: plugged ? "already plugged in" : `plug into its “${port?.label}”`,
            enabled: !plugged,
            attached: true,
          };
        },
      );
      setMenu({
        ...at,
        flow: dropped && at.flow ? { x: at.flow.x, y: at.flow.y - 40 } : null,
        title: `models that take ${PORT_TYPES[type].phrase}`,
        subtitle: fromModel
          ? `from ${MODEL_BY_ID.get(fromModel)?.name ?? fromModel} — picking one plugs it in`
          : "from the dataset",
        sections,
        onPick: (id) => {
          setMenu(null);
          addModel(id, {
            at: dropped && at.flow ? { x: at.flow.x, y: at.flow.y - 40 } : undefined,
            wireFrom: fromModel ?? undefined,
          });
        },
      });
    },
    [menuAt, entrySections, addModel],
  );

  /** Models that make what an input takes — dropped from an input pin. */
  const openProducersMenu = useCallback(
    (targetId: string, portId: string, clientX: number, clientY: number) => {
      const port = portsOf(targetId).inputs.find((p) => p.id === portId);
      if (!port) return;
      const at = menuAt(clientX, clientY);
      const producers = port.accepts
        .filter((t) => !isDataType(t))
        .flatMap((t) => producersOf(t))
        .filter((p) => p.modelId !== targetId);
      const current = wireInto(modelWiresRef.current, targetId, portId);
      const present = new Set(selectedModelsRef.current.map((m) => m.id));
      const sections = entrySections(
        producers.map((p) => p.modelId),
        (id) =>
          present.has(id)
            ? current?.source === id
              ? { hint: "already plugged in", enabled: false, attached: true }
              : {
                  hint: `plug its “${producers.find((p) => p.modelId === id)?.port.label}” in`,
                  enabled: true,
                  attached: true,
                }
            : { hint: MODEL_BY_ID.get(id)?.description ?? "", enabled: true, attached: false },
      );
      // A pin that also takes a dataset role can be handed back to the data.
      const dataType = port.accepts.find(
        (t): t is DataPortType => isDataType(t) && dataTypes.has(t),
      );
      if (dataType && current) {
        sections.unshift({
          title: "the dataset",
          entries: [
            {
              key: "dataset",
              name: `dataset · ${PORT_TYPES[dataType].label}`,
              family: null,
              hint: `unplug ${MODEL_BY_ID.get(current.source)?.name ?? current.source} and feed it the table itself`,
              enabled: true,
            },
          ],
        });
      }
      const flow = at.flow ? { x: at.flow.x - TOOL_W, y: at.flow.y - 40 } : undefined;
      setMenu({
        ...at,
        flow: flow ?? null,
        title: `what can feed “${port.label}”`,
        subtitle: `${MODEL_BY_ID.get(targetId)?.name ?? targetId} takes ${describeAccepts(port.accepts)}`,
        sections,
        onPick: (key) => {
          setMenu(null);
          if (key === "dataset") {
            if (current) unplug(current.source, current.target);
            return;
          }
          addModel(key, { at: flow, wireInto: targetId });
        },
      });
    },
    [menuAt, entrySections, dataTypes, addModel, unplug],
  );

  /** Right-click on empty canvas: every model, what fits this data first. */
  const openAllMenu = useCallback(
    (clientX: number, clientY: number) => {
      const at = menuAt(clientX, clientY);
      const present = new Set(selectedModelsRef.current.map((m) => m.id));
      const sections = entrySections(
        MODEL_CATALOG.map((m) => m.id),
        (id) => {
          const m = MODEL_BY_ID.get(id);
          const reads = portsOf(id)
            .inputs.filter((p) => p.required)
            .map((p) => p.label);
          return present.has(id)
            ? { hint: "already on the canvas", enabled: false, attached: true }
            : {
                hint: `${reads.length ? `Reads ${reads.join(" + ")}. ` : "Reads no columns. "}${m?.description ?? ""}`,
                enabled: true,
                attached: false,
              };
        },
      );
      setMenu({
        ...at,
        title: "add a model",
        subtitle: "ranked by what this data can feed",
        sections,
        onPick: (id) => {
          setMenu(null);
          addModel(id, { at: at.flow ?? undefined });
        },
      });
    },
    [menuAt, entrySections, addModel],
  );

  const onRoleMenu = useCallback(
    (type: DataPortType, clientX: number, clientY: number) =>
      openConsumersMenu(type, { hub: true }, clientX, clientY, false),
    [openConsumersMenu],
  );

  // React Flow nodes + edges ─────────────────────────────────────────────────
  const desiredNodes: Node[] = useMemo(() => {
    if (!dataset) return [];
    const hub: Node<HubNodeData> = {
      id: HUB_NODE_ID,
      type: "hub",
      position: { x: 0, y: 0 },
      data: {
        dataset,
        domain,
        selectedCount: enabledCount,
        rows: hubRows,
        hiddenCount: hubExpanded || selectedModels.length === 0 ? 0 : roles.length - hubRows.length,
        expanded: hubExpanded && selectedModels.length > 0,
        onToggleExpanded: () => setHubExpanded((e) => !e),
        onRoleMenu,
        chatContext: buildHubChatContext({
          dataset,
          domain: domain as ModelFamily | null,
          selected: selectedModels,
          summary: pickSummary,
          roles,
          wires: modelWires,
        }),
        chatPlaceholder:
          selectedModels.length === 0
            ? "suggest a starter model mix…"
            : "rebalance the mix, flag gaps…",
        onStackDirective: onChatStackDirective,
        onLocalStackCommand: onChatStackCommand,
      },
      draggable: true,
      selectable: false,
    };
    const tools: Node<ToolNodeData>[] = [];
    for (const sm of selectedModels) {
      const model = MODEL_BY_ID.get(sm.id);
      if (!model) continue;
      const pins = pinsFor(sm);
      tools.push({
        id: modelNodeId(sm.id),
        type: "tool",
        position: { x: 0, y: 0 },
        data: {
          model,
          selected: sm.enabled,
          rationale: sm.rationale,
          blocked: blockedReasonFor(sm),
          inputs: pins.inputs,
          outputs: pins.outputs,
          fitOf,
          onToggle,
          onRemove,
          onReplace,
          isFocused: focusedId === sm.id,
          chatContext: buildModelChatContext({
            dataset,
            domain: domain as ModelFamily | null,
            selected: selectedModels,
            focus: sm,
            focusModel: model,
            pins,
          }),
          chatPlaceholder: `ask about ${model.name}…`,
          onStackDirective: onChatStackDirective,
          onLocalStackCommand: onChatStackCommand,
        },
        draggable: true,
      });
    }
    return [hub, ...tools];
  }, [
    dataset,
    selectedModels,
    domain,
    enabledCount,
    hubRows,
    hubExpanded,
    roles,
    modelWires,
    onRoleMenu,
    pinsFor,
    blockedReasonFor,
    fitOf,
    onToggle,
    onRemove,
    onReplace,
    focusedId,
    pickSummary,
    onChatStackDirective,
    onChatStackCommand,
  ]);

  // Wires: dataset feeds (hub pin → input, not removable — the data always
  // feeds what reads it) and model → model wires (removable). A wire whose
  // source is switched off is drawn dashed, beside the feed its pin falls
  // back to.
  const desiredEdges: Edge<WireEdgeData>[] = useMemo(() => {
    const out: Edge<WireEdgeData>[] = [];
    const nameOf = (id: string) => MODEL_BY_ID.get(id)?.name ?? id;
    for (const sm of selectedModels) {
      const target = modelNodeId(sm.id);
      for (const { port, feed } of inputFeeds(sm.id, selectedModels, modelWires, dataTypes)) {
        const targetHandle = inHandleId(port.id);
        const dataEdge = (type: DataPortType) =>
          out.push({
            id: `data:${type}->${sm.id}:${port.id}`,
            type: "wire",
            source: HUB_NODE_ID,
            sourceHandle: dataHandleId(type),
            target,
            targetHandle,
            // The data always feeds what reads it: nothing to unplug.
            deletable: false,
            focusable: false,
            data: { color: portColorOf(type, theme), live: sm.enabled },
          });
        if (feed.kind === "data") dataEdge(feed.type);
        if (feed.kind !== "wire") continue;
        const pair = resolveWire(feed.from, sm.id);
        if (!pair) continue;
        out.push({
          id: `wire:${feed.from}->${sm.id}`,
          type: "wire",
          source: modelNodeId(feed.from),
          sourceHandle: outHandleId(pair.output.id),
          target,
          targetHandle,
          data: {
            color: portColorOf(pair.output.type, theme),
            live: feed.live && sm.enabled,
            onRemove: () => unplug(feed.from, sm.id),
            title: `unplug ${nameOf(feed.from)} → ${nameOf(sm.id)} (${pair.output.label} → ${pair.input.label})`,
          },
        });
        if (feed.fallback?.kind === "data") dataEdge(feed.fallback.type);
      }
    }
    return out;
  }, [selectedModels, modelWires, dataTypes, theme, unplug]);

  // Controlled React Flow state. `onNodesChange` is what makes nodes actually
  // draggable — without it React Flow has no callback for drag updates and
  // the node snaps back to its prop position on each render.
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  nodesRef.current = nodes;

  // Measured node heights feed the layout (estimates until then), so a node
  // that grows — its chat opened, a warning appeared — pushes its column
  // down instead of overlapping it.
  const [measured, setMeasured] = useState<Map<string, number>>(() => new Map());
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      const dims = changes.filter(
        (c): c is Extract<NodeChange, { type: "dimensions" }> =>
          c.type === "dimensions" && !!c.dimensions,
      );
      if (dims.length === 0) return;
      setMeasured((prev) => {
        let next: Map<string, number> | null = null;
        for (const c of dims) {
          const h = Math.round(c.dimensions?.height ?? 0);
          if (Math.abs((prev.get(c.id) ?? -1) - h) > 1) {
            next ??= new Map(prev);
            next.set(c.id, h);
          }
        }
        return next ?? prev;
      });
    },
    [onNodesChange],
  );

  // Lay the graph out (or keep the actuary's arrangement) whenever its
  // shape, wiring or measured sizes change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutEpoch forces a fresh layout on "re-layout".
  useEffect(() => {
    const ids = selectedModels.map((m) => m.id);
    const heights = new Map(
      selectedModels.map((sm) => [
        sm.id,
        measured.get(modelNodeId(sm.id)) ?? estimateToolHeight(sm.id, !!blockedReasonFor(sm)),
      ]),
    );
    const layout = blueprintLayout({
      ids,
      wires: modelWires,
      heights,
      hubHeight: measured.get(HUB_NODE_ID) ?? estimateHubHeight(hubRows.length),
      roleOrder: roles.map((r) => r.type),
    });
    const auto = (id: string): XY | undefined =>
      id === HUB_NODE_ID ? layout.hub : layout.models.get(modelIdOfNode(id) ?? "");
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n] as const));
      return desiredNodes.map((n) => {
        const existing = prevById.get(n.id);
        const keep = {
          width: existing?.width,
          height: existing?.height,
          selected: existing?.selected,
        };
        if (arrangedRef.current) {
          if (existing) return { ...n, ...keep, position: existing.position };
          const pending = pendingPositionsRef.current.get(n.id);
          if (pending) {
            pendingPositionsRef.current.delete(n.id);
            return { ...n, position: pending };
          }
        }
        return { ...n, ...keep, position: auto(n.id) ?? n.position };
      });
    });
  }, [desiredNodes, measured, layoutEpoch, setNodes]);

  useEffect(() => {
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return desiredEdges.map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [desiredEdges, setEdges]);

  // Keep the whole graph in view while it is laid out automatically: once
  // every node has been measured, and again whenever models join or leave.
  const allMeasured = nodes.length > 0 && nodes.every((n) => measured.has(n.id));
  const fitKey = `${selectedModels.map((m) => m.id).join(",")}|${allMeasured}|${layoutEpoch}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fitKey is the trigger.
  useEffect(() => {
    if (!allMeasured || arrangedRef.current) return;
    const t = window.setTimeout(() => {
      flowInstanceRef.current?.fitView({ padding: 0.1, duration: 250, maxZoom: 1.1 });
    }, 120);
    return () => window.clearTimeout(t);
  }, [fitKey]);

  // Manual "re-layout" — back to the automatic left-to-right arrangement.
  const relayout = useCallback(() => {
    arrangedRef.current = false;
    pendingPositionsRef.current.clear();
    setLayoutEpoch((e) => e + 1);
  }, []);

  // Connecting ────────────────────────────────────────────────────────────────
  // Blueprint rules: output → input, types must agree, no loops, a pin takes
  // one wire (plugging a new one replaces the old).
  const isValidConnection = useCallback(
    (c: Connection) => checkConnection(c, modelWiresRef.current).ok,
    [],
  );
  const connectingRef = useRef<{ start: OnConnectStartParams | null; made: boolean }>({
    start: null,
    made: false,
  });
  const onConnect = useCallback(
    (c: Connection) => {
      connectingRef.current.made = true;
      const check = checkConnection(c, modelWiresRef.current);
      if (!check.ok) return;
      if (check.action.kind === "wire") connect(check.action.source, check.action.target);
      else if (check.action.kind === "data") {
        const w = wireInto(modelWiresRef.current, check.action.target, check.action.portId);
        if (w) unplug(w.source, w.target);
      }
    },
    [connect, unplug],
  );
  const onConnectStart = useCallback((_: unknown, params: OnConnectStartParams) => {
    connectingRef.current = { start: params, made: false };
  }, []);
  // A wire dropped on empty canvas opens the menu of models that fit it.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const { start, made } = connectingRef.current;
      connectingRef.current = { start: null, made: false };
      if (made || !start?.nodeId) return;
      const target = event.target as Element | null;
      if (!target?.classList?.contains("react-flow__pane")) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const h = parseHandleId(start.handleId);
      if (!h) return;
      if (h.kind === "data") {
        openConsumersMenu(h.type, { hub: true }, point.clientX, point.clientY, true);
        return;
      }
      const modelId = modelIdOfNode(start.nodeId);
      if (!modelId) return;
      if (h.kind === "out") {
        const port = portsOf(modelId).outputs.find((p) => p.id === h.port);
        if (port)
          openConsumersMenu(port.type, { model: modelId }, point.clientX, point.clientY, true);
        return;
      }
      openProducersMenu(modelId, h.port, point.clientX, point.clientY);
    },
    [openConsumersMenu, openProducersMenu],
  );

  // Chatbar context — refreshes whenever picks / dataset / domain change.
  const chatStageContext = useMemo(
    () =>
      `${buildToolsStageContext({
        dataset,
        domain: domain as ModelFamily | null,
        selected: selectedModels,
        summary: pickSummary,
        roles,
        wires: modelWires,
      })}\n\n${tableChat.contextAddendum}`,
    [dataset, domain, selectedModels, pickSummary, roles, modelWires, tableChat.contextAddendum],
  );
  const chatPlaceholder = useMemo(() => {
    if (!dataset) return "load a dataset in Soft Data first…";
    if (selectedModels.length === 0) return "ask scelo about model choice…";
    return `ask scelo about these ${enabledCount} model${enabledCount === 1 ? "" : "s"}…`;
  }, [dataset, selectedModels.length, enabledCount]);

  const focused = focusedId ? (MODEL_BY_ID.get(focusedId) ?? null) : null;
  const focusedSelection = focusedId ? selectedModels.find((m) => m.id === focusedId) : undefined;
  const focusedPins = focusedSelection ? pinsFor(focusedSelection) : null;
  const palette = theme === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const blueprint = useMemo(() => ({ theme, wires: modelWires }), [theme, modelWires]);

  return (
    <div className="flex h-full flex-col">
      {/* top toolbar */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-2">
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo")}
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          <Arrow dir="left" /> macro view
        </button>
        <button
          type="button"
          onClick={() => navigate("/dashboards/scelo/soft")}
          title="Step back to Soft Data."
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          <Arrow dir="left" /> back: soft
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
            className="ia-tool-btn"
          >
            {status === "loading" ? "identifying…" : "identify models"}
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={!dataset || status === "loading"}
            className="ia-tool-btn"
          >
            regenerate
          </button>
          <button
            type="button"
            onClick={relayout}
            disabled={!dataset || selectedModels.length === 0}
            title="Lay the graph back out left to right and refit the view."
            className="ia-tool-btn"
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
                  : pipeline.blocked > 0
                    ? `${pipeline.blocked} switched-on model${pipeline.blocked === 1 ? "" : "s"} can't run — Hard will say why.`
                    : "Run the picks in Hard Data."
            }
            className="ia-tool-btn ia-tool-btn-cta"
          >
            next: hard <Arrow />
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
          <div className="flex-1" />
          {/* Fallback picks must be visibly labelled — the user needs to
              know the mix came from the deterministic local heuristic,
              not the AI picker (and that regenerate rotates alternates
              locally rather than re-asking the model). */}
          {status === "fallback" && (
            <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] text-warn">
              AI picker unreachable — deterministic local pick shown
            </span>
          )}
          {/* The Blueprint "compile" readout: what Hard will actually run. */}
          {selectedModels.length > 0 && (
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                pipeline.blocked > 0
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-primary/40 bg-primary/10 text-primary"
              }`}
              title="Switched-on models whose inputs are all fed will run in Hard; the rest will report why not."
            >
              {pipeline.blocked === 0 ? "✓ " : "⚠ "}
              {pipeline.ready} ready
              {pipeline.blocked > 0 ? ` · ${pipeline.blocked} can't run` : ""}
              {pipeline.off > 0 ? ` · ${pipeline.off} off` : ""}
              {modelWires.length > 0
                ? ` · ${modelWires.length} wire${modelWires.length === 1 ? "" : "s"}`
                : ""}
            </span>
          )}
          {domain && (
            <span
              className="rounded border bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
              style={{
                color: palette[domain as ModelFamily],
                borderColor: palette[domain as ModelFamily],
              }}
            >
              {domain}
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
            go to Soft Data <Arrow />
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
        <main ref={mainRef} className="relative min-w-0 flex-1">
          {/* Model identification in flight with nothing picked yet — the
              canvas would sit empty for the whole LLM round-trip. Same
              loading vocabulary as Soft; indeterminate scan because an LLM
              call has no honest progress signal. */}
          {status === "loading" && selectedModels.length === 0 && dataset && (
            <UploadIndicator
              layout="overlay"
              accent="primary"
              state={{ verb: "identifying", name: dataset.name }}
            />
          )}
          {/* Why-these-models bubble. Floats over the canvas while the
              attached stack is still exactly the AI's pick; vanishes the
              moment the user adds / removes / swaps a model (see
              pickBubbleVisible) or dismisses it. */}
          {pickBubbleVisible && dataset && (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
              <div className="pointer-events-auto relative max-w-xl rounded-2xl border border-border bg-bg-2/80 px-4 py-3 pr-9 shadow-lg backdrop-blur-md">
                <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: "rgb(var(--rgb-primary))" }}
                  />
                  why these models
                  {domain && <span className="text-fg-mute">· {domain}</span>}
                  <span className="text-fg-mute">
                    · {selectedModels.length} selected
                    {status === "fallback" ? " · offline pick" : ""}
                  </span>
                </div>
                <p className="text-[12.5px] leading-snug text-fg">{pickSummary}</p>
                <button
                  type="button"
                  onClick={() => setPickBubbleDismissed(true)}
                  className="absolute right-2 top-2 rounded p-0.5 text-fg-dim transition-colors hover:text-fg"
                  aria-label="dismiss model justification"
                  title="dismiss"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    aria-hidden="true"
                    role="presentation"
                  >
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>
          )}
          {dataset ? (
            <BlueprintContext.Provider value={blueprint}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={handleNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onConnectStart={onConnectStart}
                onConnectEnd={onConnectEnd}
                isValidConnection={isValidConnection}
                connectionLineComponent={BlueprintConnectionLine}
                onEdgesDelete={(deleted) => {
                  // Delete / Backspace on a selected model → model wire.
                  for (const e of deleted) {
                    const s = modelIdOfNode(e.source);
                    const t = modelIdOfNode(e.target);
                    if (s && t) unplug(s, t);
                  }
                }}
                onNodesDelete={(deleted) => {
                  // Keyboard-deleted model nodes (Backspace / Delete) need
                  // to drop out of `selectedModels` too; the hub is not
                  // deletable so we filter it out.
                  for (const n of deleted) {
                    if (n.type !== "tool") continue;
                    const id = modelIdOfNode(n.id);
                    if (id) onRemove(id);
                  }
                }}
                onNodeDragStop={() => {
                  arrangedRef.current = true;
                }}
                onPaneContextMenu={(e) => {
                  e.preventDefault();
                  openAllMenu(e.clientX, e.clientY);
                }}
                // (No close-on-pane-click: dropping a wire on the pane ends in a
                // pane click, which would shut the menu it just opened. The
                // menu closes on any press outside it, and on pan / zoom.)
                onMoveStart={closeMenu}
                onInit={(inst) => {
                  flowInstanceRef.current = inst;
                }}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodeClick={(_, node) => {
                  const id = modelIdOfNode(node.id);
                  if (node.type === "tool" && id) setFocusedId(id);
                }}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.3}
                maxZoom={1.6}
                nodeDragThreshold={3}
                // Connectable pin-to-pin; isValidConnection enforces the
                // types, and a wire dropped on empty canvas opens the menu
                // of models that fit it.
                nodesConnectable={true}
                // Backspace OR Delete removes a selected node / wire. React
                // Flow's default is "Backspace" alone; both keys is closer
                // to what most diagramming tools do.
                deleteKeyCode={["Backspace", "Delete"]}
                proOptions={{ hideAttribution: true }}
              >
                <Background color={resolved === "light" ? "#dcdad5" : "#1a1a1a"} gap={16} />
                <FlowControls />
              </ReactFlow>
              {menu && (
                <AddModelMenu
                  x={menu.x}
                  y={menu.y}
                  title={menu.title}
                  subtitle={menu.subtitle}
                  sections={menu.sections}
                  onPick={menu.onPick}
                  onClose={closeMenu}
                />
              )}
              {selectedModels.length > 0 && !menu && (
                <div className="pointer-events-none absolute left-3 top-2 z-10 font-mono text-[9.5px] text-fg-dim">
                  drag a pin onto a matching pin · drop it on empty canvas, or right-click, to add a
                  model
                </div>
              )}
            </BlueprintContext.Provider>
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
            pins={focusedPins}
            blocked={focusedSelection ? blockedReasonFor(focusedSelection) : undefined}
            fitOf={fitOf}
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
          onLocalCommand={onChatStackCommand}
          onAssistantFinal={onChatStackDirective}
          actions={tableChat.actions}
        />
      </div>
    </div>
  );
}
