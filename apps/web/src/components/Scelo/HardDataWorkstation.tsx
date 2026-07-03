// Hard Data drill-in — the third stage of the Scelo pipeline. Closes the
// soft → tools → hard loop: takes the models the user picked in Tools,
// runs each one (through the Scelo IDE's bundled Python/R bridge when one
// exists, otherwise the deterministic in-browser approximation), and
// renders the results as a hub-and-spoke React Flow graph that flows
// inward into a "Board Pack" hub at the centre.
//
//   [Chain Ladder]\
//                 \
//   [Mack]──────── [BOARD PACK] ◀── AI narrative
//                 /
//   [Bootstrap] /
//   [GLM freq] /
//
// Each result node shows a headline metric, secondary numbers, and an
// optional tiny chart (line or bar). Clicking a result node fills the
// right panel with the full detail and the AI narrative.

import { streamOrchestrator } from "@/lib/api";
import { openInSwarm } from "@/lib/swarmBus";
import { useTheme } from "@/lib/theme";
import ReactECharts from "echarts-for-react";
import { BarChart, BoxplotChart, LineChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactFlow, {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { SWARM_DOCS_URL, swarmStartCommand } from "../workspace/SwarmPanel";
import { ChatInputPill } from "./ChatInputPill";
import { ClimateDataPanel, isClimateFamilyModel } from "./ClimateDataPanel";
import { ExportButton } from "./ExportScreen";
import { FlowControls } from "./FlowControls";
import { ResizablePanel } from "./ResizablePanel";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import { SceloLogo } from "./SceloLogo";
import { ScrollFade } from "./ScrollFade";
import { type Dataset, formatNumber } from "./SoftDataWorkstation";
import { StageChatPanel } from "./StageChatPanel";
import { UploadIndicator, nextPaint } from "./UploadIndicator";
import { useSwarmProbe } from "../SwarmStatus";
import { type CouncilSynthesis, conveneCouncil } from "./forecast/councilClient";
import { forecastConfigFor } from "./forecast/derive";
import { hasForecastDomain } from "./forecast/domainLabels";
import { runForecast } from "./forecast/runner";
import type { ForecastResult } from "./forecast/runner";
import {
  buildLifelibNotebook,
  isLifelibModel,
  triggerNotebookDownload,
} from "./lifelibNotebookExport";
import {
  FAMILY_COLOR_DARK,
  FAMILY_COLOR_LIGHT,
  MODEL_BY_ID,
  type ModelFamily,
} from "./modelCatalog";
import { BRIDGED_MODEL_IDS, type RunResult, runModel, runModelAsync } from "./modelRunner";
import { modelTheoryFor } from "./modelTheory";
import { type SelectedModel, useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

echarts.use([
  TooltipComponent,
  GridComponent,
  BarChart,
  LineChart,
  BoxplotChart,
  ScatterChart,
  CanvasRenderer,
  // SVG renderer for the report — vector output prints crisply at any zoom,
  // unlike canvas which rasterises and gets blocky in the saved PDF.
  SVGRenderer,
]);

// ── tiny chart inside the result nodes ───────────────────────────────────────

// Bar sparkline for each result node — one bar per cohort / period in the
// series, no axes, no gridlines. Reverted from the Tufte line+endpoint
// design at the user's request: bars read more naturally for discrete
// cohort breakdowns (chain-ladder per-origin ultimates, etc.) than a
// smoothed or sharp line would.
function MicroChart({
  series,
  color,
}: {
  series: NonNullable<RunResult["series"]>;
  color: string;
}) {
  const option = useMemo(() => {
    const ys = series.y;
    if (ys.length === 0) return null;
    return {
      animation: false,
      grid: { left: 2, right: 2, top: 4, bottom: 2 },
      xAxis: { type: "category", show: false, data: series.x, boundaryGap: true },
      yAxis: { type: "value", show: false, scale: true },
      tooltip: {
        trigger: "axis",
        appendToBody: true,
        backgroundColor: "rgb(var(--rgb-bg-1))",
        borderColor: "rgb(var(--rgb-border))",
        textStyle: { color: "rgb(var(--rgb-fg))", fontSize: 10 },
        extraCssText: "z-index: 9999; font-family: 'SN Pro', 'Inter', sans-serif;",
        formatter: (params: Array<{ axisValue: string; data: number }>) => {
          if (!Array.isArray(params) || params.length === 0) return "";
          const p = params[0];
          return `${p.axisValue}<br/>${formatNumber(Number(p.data))}`;
        },
      },
      series: [
        {
          type: "bar" as const,
          data: ys,
          itemStyle: { color, borderRadius: [2, 2, 0, 0] },
          barWidth: "72%",
        },
      ],
    };
  }, [series, color]);

  if (!option) return null;
  return (
    <div className="pointer-events-auto" style={{ height: 30, width: "100%" }}>
      <ReactECharts
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        style={{ height: 30, width: "100%" }}
      />
    </div>
  );
}

// Compact table for nodes whose result reads better as a small breakdown
// than as a sparkline (Bornhuetter-Ferguson — no development pattern of its
// own, but a meaningful per-origin reserve split). Constraint per the UI
// contract is "one visual element per node", so this is rendered IN PLACE
// of MicroChart when the run carries `tableSpec` instead of `series`.
function MicroTable({
  spec,
  color,
}: {
  spec: NonNullable<RunResult["tableSpec"]>;
  color: string;
}) {
  if (spec.rows.length === 0) return null;
  return (
    // `nowheel`/`nodrag` let the user scroll the table inside the node without
    // React Flow hijacking the gesture as a canvas pan/zoom. ScrollFade gives
    // the quiet hover-only scrollbar + a gradient fade on whichever edge is
    // clipped, so a wide table (or a long per-origin split) reads as "more to
    // see" rather than an abrupt cut.
    <ScrollFade
      axis="both"
      className="nowheel nodrag pointer-events-auto mt-1 max-h-40 overflow-auto rounded border border-border/40"
    >
      <table className="min-w-full border-collapse font-mono text-[9px]">
        <thead>
          <tr>
            {spec.headers.map((h, i) => (
              <th
                key={h}
                className={`whitespace-nowrap bg-bg-2/40 px-1.5 py-0.5 uppercase tracking-wider text-fg-dim ${
                  i === 0 ? "text-left" : "text-right"
                }`}
                style={i === 0 ? { color } : undefined}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, ri) => {
            const rowKey = `${ri}:${row[0]}`;
            return (
              <tr key={rowKey} className="border-t border-border/30 odd:bg-bg-1/30">
                {row.map((cell, ci) => (
                  <td
                    key={`${rowKey}:${spec.headers[ci] ?? ci}`}
                    className={`whitespace-nowrap px-1.5 py-0.5 ${
                      typeof cell === "number" && ci > 0
                        ? "text-right tabular-nums text-fg"
                        : ci === 0
                          ? "text-left text-fg-mute"
                          : "text-right text-fg-mute"
                    }`}
                  >
                    {typeof cell === "number" ? formatNumber(cell) : cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollFade>
  );
}

// Tiny inline CI strip rendered in SVG — much lighter than spinning up a
// second ECharts instance for ~8px of vertical real estate. Shows:
//   • a coloured horizontal whisker from the lower to the upper bound
//   • two end caps so the range reads as a measurement, not a gradient
//   • a solid point at the headline value's position on that range
// Renders nothing for models with no uncertainty data (Chain Ladder, BF, etc.)
function CIStrip({ run, color }: { run: RunResult; color: string }) {
  const ci = extractInterval(run);
  if (!ci) return null;
  const centre = run.headline.value;
  const lo = Math.min(ci.lo, centre);
  const hi = Math.max(ci.hi, centre);
  const range = hi - lo;
  const pad = range > 0 ? range * 0.1 : Math.abs(centre) * 0.05 || 1;
  const minX = lo - pad;
  const maxX = hi + pad;
  const norm = (v: number) => (((v - minX) / (maxX - minX)) * 100).toFixed(2);
  return (
    <div className="mt-1" title={`${ci.kind} · ${formatNumber(ci.lo)} – ${formatNumber(ci.hi)}`}>
      <svg
        width="100%"
        height={10}
        className="block overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <title>{`Confidence interval: ${formatNumber(ci.lo)} – ${formatNumber(ci.hi)}`}</title>
        {/* whisker line */}
        <line
          x1={`${norm(ci.lo)}%`}
          y1="5"
          x2={`${norm(ci.hi)}%`}
          y2="5"
          stroke={color}
          strokeWidth="1.5"
          opacity="0.5"
        />
        {/* end caps */}
        <line
          x1={`${norm(ci.lo)}%`}
          y1="2"
          x2={`${norm(ci.lo)}%`}
          y2="8"
          stroke={color}
          strokeWidth="1.2"
          opacity="0.65"
        />
        <line
          x1={`${norm(ci.hi)}%`}
          y1="2"
          x2={`${norm(ci.hi)}%`}
          y2="8"
          stroke={color}
          strokeWidth="1.2"
          opacity="0.65"
        />
        {/* headline point */}
        <circle cx={`${norm(centre)}%`} cy="5" r="2.2" fill={color} />
      </svg>
    </div>
  );
}

// ── React Flow node types ────────────────────────────────────────────────────

type ResultNodeData = {
  run: RunResult;
  isFocused: boolean;
  color: string;
  // Callback to open the per-model detail dashboard. Lives on the data
  // object (not via context) so the React Flow node tree stays purely
  // prop-driven and React Flow's memoisation doesn't drift out of sync.
  onExpand: (modelId: string) => void;
};

function formatHeadline(h: RunResult["headline"]): string {
  if (h.value === 0 && h.label === "—") return "—";
  return formatNumber(h.value);
}

function ResultNode({ data }: NodeProps<ResultNodeData>) {
  const { run, color } = data;
  const dim = run.status !== "done";
  return (
    <div
      className={`glass-card w-[200px] rounded p-2 transition ${
        data.isFocused ? "ring-2 ring-primary" : ""
      }`}
      style={{
        // Family colour overrides the .glass-card hairline so the model's
        // family stays the dominant visual cue on the canvas.
        borderColor: color,
        borderWidth: 1,
        opacity: dim ? 0.55 : 1,
      }}
    >
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ background: color, width: 6, height: 6, opacity: 0 }}
      />
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[9px] uppercase tracking-wider" style={{ color }}>
          {run.family}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              // Don't let the click bubble to the React Flow node — clicking
              // the card body focuses the model in the side panel, but the
              // expand button has a different job.
              e.stopPropagation();
              data.onExpand(run.modelId);
            }}
            title="open detail dashboard"
            aria-label="open detail dashboard"
            className="nodrag flex h-3.5 w-3.5 items-center justify-center rounded text-fg-dim hover:bg-bg-2 hover:text-fg"
          >
            <svg
              viewBox="0 0 10 10"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 1.5h2.5V4" />
              <path d="M4 8.5H1.5V6" />
              <path d="M8.5 1.5 L5.5 4.5" />
              <path d="M1.5 8.5 L4.5 5.5" />
            </svg>
          </button>
          <StatusPip status={run.status} />
        </div>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-1">
        <span className="truncate text-xs text-fg">
          {MODEL_BY_ID.get(run.modelId)?.name ?? run.modelId}
        </span>
        {/* Provenance badge: bundled Python/R bridge (canonical library) vs
            the in-browser TS approximation. Absent on legacy persisted
            runs — no badge is better than a guessed one. */}
        {run.source && (
          <span
            className={`shrink-0 rounded border px-1 font-mono text-[8px] uppercase tracking-wider ${
              run.source === "python-bridge"
                ? "border-primary text-primary"
                : "border-border text-fg-dim"
            }`}
            title={
              run.source === "python-bridge"
                ? "computed by the Scelo IDE's bundled Python/R runtime (canonical implementation)"
                : "computed by the in-browser approximation"
            }
          >
            {run.source === "python-bridge" ? "python" : "in-browser"}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-lg text-fg">{formatHeadline(run.headline)}</span>
        <span className="font-mono text-[9px] uppercase text-fg-dim">{run.headline.label}</span>
      </div>
      {/* One visual per node: prefer the chart when the run has a series;
          otherwise fall back to the table when one's provided. */}
      {run.series ? (
        <MicroChart series={run.series} color={color} />
      ) : run.tableSpec ? (
        <MicroTable spec={run.tableSpec} color={color} />
      ) : null}
      {/* A bridge that failed must say WHY — these numbers are the fallback
          approximation, not the canonical run the user may be expecting. */}
      {run.bridgeError && (
        <div
          className="mt-1 truncate text-[9px] text-error"
          title={`python bridge failed: ${run.bridgeError}`}
        >
          bridge failed: {run.bridgeError}
        </div>
      )}
      {run.status === "done" && <CIStrip run={run} color={color} />}
    </div>
  );
}

function StatusPip({ status }: { status: RunResult["status"] }) {
  const cls =
    status === "done"
      ? "bg-primary"
      : status === "running"
        ? "bg-warn animate-pulse"
        : status === "error"
          ? "bg-error"
          : "bg-fg-dim";
  return <span className={`block h-1.5 w-1.5 rounded-full ${cls}`} title={status} />;
}

type HubNodeData = {
  dataset: Dataset;
  domain: ModelFamily | null;
  runCount: number;
  narrative: string | null;
  status: "idle" | "loading" | "ready" | "fallback";
  // Open the printable board-pack report (same expand affordance the result
  // nodes have — the report modal is the board pack's "expanded" view and
  // owns the print-to-PDF path).
  onExpand: () => void;
};

function HubNode({ data }: NodeProps<HubNodeData>) {
  return (
    <div
      className="glass-card w-[260px] rounded-lg p-3"
      style={{
        // Primary tint on the board-pack hub so the spokes read as
        // converging on it. Inline border wins over the .glass-card hairline.
        borderColor: "rgb(var(--rgb-primary))",
        borderWidth: 2,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ background: "rgb(var(--rgb-primary))", width: 8, height: 8, opacity: 0 }}
      />
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary">
          board pack
        </span>
        <div className="flex items-center gap-1.5">
          {data.status === "loading" && (
            <span className="font-mono text-[9px] text-warn">narrating…</span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              data.onExpand();
            }}
            title="open printable board-pack report (PDF)"
            aria-label="open printable board-pack report"
            className="nodrag flex h-3.5 w-3.5 items-center justify-center rounded text-fg-dim hover:bg-bg-2 hover:text-fg"
          >
            <svg
              viewBox="0 0 10 10"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 1.5h2.5V4" />
              <path d="M4 8.5H1.5V6" />
              <path d="M8.5 1.5 L5.5 4.5" />
              <path d="M1.5 8.5 L4.5 5.5" />
            </svg>
          </button>
        </div>
      </div>
      <div className="mt-0.5 truncate text-sm text-fg" title={data.dataset.name}>
        {data.dataset.name}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-fg-mute">
        {data.runCount} results · {data.domain ?? "no domain"}
      </div>
      {data.narrative ? (
        // Scroll the full narrative inside the node rather than clamping it to
        // five lines. ScrollFade adds the hover-only bar + a fade on the top/
        // bottom edge as it's scrolled. `nowheel`/`nodrag` keep the scroll
        // from panning the canvas.
        <ScrollFade
          axis="y"
          className="nowheel nodrag mt-2 max-h-36 overflow-auto pr-1 text-fg-mute"
        >
          {/* Markdown so inline code (`moderate`) and emphasis render properly
              instead of showing literal backticks. */}
          <SceloChatMarkdown dataset={null} size="xs">
            {data.narrative}
          </SceloChatMarkdown>
        </ScrollFade>
      ) : (
        <p className="mt-2 text-[11px] italic text-fg-dim">
          {data.runCount === 0 ? "no models attached" : "click rerun to generate a narrative"}
        </p>
      )}
    </div>
  );
}

const NODE_TYPES = { hub: HubNode, result: ResultNode };

// Hub + result node dimensions (px). Used to centre each node exactly on its
// slot in the column layout.
const HUB_W = 260;
const HUB_H = 140;
const RESULT_W = 200;
const RESULT_H = 110;

// Lay result nodes in a vertical column to the LEFT of the hub — mirroring
// the inward result-flow (spokes feed into the board pack on the right).
//
//    [ result 1 ]
//    [ result 2 ]   [ HUB ]
//    [ result 3 ]
//
// Returns the *centre* of each result node — callers offset by -W/2 / -H/2.
function columnLayout(n: number): Array<{ x: number; y: number }> {
  if (n === 0) return [];
  const horizontalGap = 160;
  const verticalGap = RESULT_H + 40;
  const colX = -(HUB_W / 2 + horizontalGap + RESULT_W / 2);
  const totalHeight = (n - 1) * verticalGap;
  const startY = -totalHeight / 2;
  return Array.from({ length: n }, (_, i) => ({
    x: colX,
    y: startY + i * verticalGap,
  }));
}

// ── narrative (LLM, with heuristic fallback) ─────────────────────────────────

function heuristicNarrative(args: {
  dataset: Dataset;
  domain: ModelFamily | null;
  runs: RunResult[];
}): string {
  const { dataset, domain, runs } = args;
  if (runs.length === 0) {
    return `${dataset.name}: no models attached — head back to Tools and pick a few.`;
  }
  const done = runs.filter((r) => r.status === "done");
  if (done.length === 0) {
    return `${dataset.name}: all ${runs.length} model runs failed against this data shape. Likely the dataset doesn't match the picked models — revisit Tools.`;
  }
  const lines = [
    `${dataset.name}: ${done.length} of ${runs.length} models computed${
      domain ? ` in the ${domain} domain` : ""
    }.`,
  ];
  for (const r of done) lines.push(`• ${r.blurb}`);
  return lines.join(" ");
}

async function fetchNarrative(args: {
  dataset: Dataset;
  domain: ModelFamily | null;
  runs: RunResult[];
  variant: number;
  signal: AbortSignal;
}): Promise<string> {
  const { dataset, domain, runs, variant } = args;
  const blurbLines = runs
    .map((r) => `- ${r.modelId} (${r.family}, ${r.status}): ${r.blurb}`)
    .join("\n");
  const variantNudge =
    variant > 0
      ? `\nREGENERATION #${variant + 1}. Reword in a different voice / structure than the previous narrative.`
      : "";

  const prompt = `CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a chat reply only.

You are Scelo at the HARD DATA stage. Write a SHORT executive summary (4-6 sentences, no bullet points) of the model run results below — board-pack style, concrete numbers, no jargon for jargon's sake.

DATASET: ${dataset.name} · ${dataset.rows.length} rows · ${dataset.columns.length} columns
DOMAIN: ${domain ?? "unspecified"}

MODEL RUNS:
${blurbLines}

Rules:
- Open with the headline finding in plain English.
- Reference 2-3 specific numbers from the runs above.
- Note one cross-check or caveat (if relevant).
- Do not invent numbers not present above.
- 4-6 sentences total, no bullets, no headers.${variantNudge}

Reply with the narrative ONLY — no JSON, no code fences, no tool calls.`;

  let buffer = "";
  let streamError: string | null = null;
  await streamOrchestrator(
    prompt,
    [],
    {
      onEvent: (e) => {
        if (e.kind === "message") buffer += e.payload.text;
        else if (e.kind === "error") streamError = e.payload.message;
      },
      onError: (e) => {
        streamError = e.message;
      },
    },
    { signal: args.signal },
  );
  if (args.signal.aborted) throw new Error("aborted");
  if (streamError) throw new Error(streamError);
  const cleaned = buffer.trim();
  if (cleaned.length === 0) throw new Error("empty narrative");
  return cleaned;
}

// ── chatbar ─────────────────────────────────────────────────────────────────

function buildHardStageContext(args: {
  dataset: Dataset | null;
  domain: ModelFamily | null;
  runs: RunResult[];
  narrative: string | null;
}): string {
  const { dataset, domain, runs, narrative } = args;
  const lines = [
    "You are Scelo at the HARD DATA stage of the pipeline.",
    "The user is inside the hard-data workstation, looking at processed, decision-grade output from the models they picked in Tools.",
    "Help them interpret, communicate, and act on these numbers; do not re-open data collection or model selection unless explicitly asked.",
    "",
  ];
  if (!dataset) {
    lines.push("CURRENT STATE: no dataset loaded.");
    return lines.join("\n");
  }
  lines.push(
    `DATASET: \`${dataset.name}\` — ${dataset.rows.length} rows, ${dataset.columns.length} columns.`,
  );
  lines.push(`DOMAIN: ${domain ?? "unspecified"}.`);
  if (runs.length === 0) {
    lines.push("RUNS: no models have run yet.");
  } else {
    lines.push("MODEL RUNS:");
    for (const r of runs) {
      lines.push(`  • ${r.modelId} (${r.family}, ${r.status}): ${r.blurb}`);
    }
  }
  if (narrative) lines.push(`EXECUTIVE NARRATIVE: ${narrative}`);
  return lines.join("\n");
}

// ── left panel: run snapshot + headline distribution ────────────────────────

// Mirror the Tools workstation panel: two containers, accent-bordered tiles,
// and a single boxplot-style "what's the consensus?" plot. Here the focus is
// on RUN OUTPUTS rather than the dataset itself.
const HARD_TILE_ACCENTS = {
  primary: { wrap: "border-primary/60", bar: "bg-primary", label: "text-primary" },
  "accent-2": { wrap: "border-accent-2/60", bar: "bg-accent-2", label: "text-accent-2" },
  "accent-3": { wrap: "border-accent-3/60", bar: "bg-accent-3", label: "text-accent-3" },
  warn: { wrap: "border-warn/60", bar: "bg-warn", label: "text-warn" },
  error: { wrap: "border-error/60", bar: "bg-error", label: "text-error" },
} as const;
type HardTileAccent = keyof typeof HARD_TILE_ACCENTS;

function HardStatTile({
  label,
  value,
  accent,
  inlineColor,
}: {
  label: string;
  value: string | number;
  accent?: HardTileAccent;
  inlineColor?: string;
}) {
  const tone = accent ? HARD_TILE_ACCENTS[accent] : null;
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

// Extract a 95% confidence interval from a run's structured detail blob,
// keying off the conventions our model runners emit:
//   • Bootstrap stores p5 / p95 (a pre-baked 90% range — close enough at this
//     scale and the actuarial convention used in the rest of the workstation).
//   • Mack stores detail.ibnr + detail.se → ±1.96·SE is a normal-approx 95% CI.
// Models without uncertainty data return null and render as a bare point on
// the forest plot.
function extractInterval(run: RunResult): { lo: number; hi: number; kind: string } | null {
  const d = run.detail as Record<string, unknown> | undefined;
  if (!d) return null;
  if (typeof d.p5 === "number" && typeof d.p95 === "number") {
    return { lo: d.p5, hi: d.p95, kind: "p5–p95 (bootstrap)" };
  }
  if (typeof d.se === "number" && typeof d.ibnr === "number" && d.se > 0) {
    return { lo: d.ibnr - 1.96 * d.se, hi: d.ibnr + 1.96 * d.se, kind: "±1.96·SE (Mack)" };
  }
  return null;
}

// Restrict the comparison to runs that share a headline label so the x-axis
// stays comparable (e.g. "IBNR" runs together; a Lee-Carter "q(65)" doesn't
// share a scale with reserving estimates).
function pickComparableGroup(doneRuns: RunResult[]): {
  rows: RunResult[];
  label: string;
} {
  if (doneRuns.length === 0) return { rows: [], label: "" };
  const byLabel = new Map<string, RunResult[]>();
  for (const r of doneRuns) {
    const k = r.headline.label;
    const arr = byLabel.get(k) ?? [];
    arr.push(r);
    byLabel.set(k, arr);
  }
  let rows: RunResult[] = [];
  let label = "";
  for (const [k, arr] of byLabel) {
    if (arr.length > rows.length) {
      rows = arr;
      label = k;
    }
  }
  return { rows, label };
}

// What should the "estimates" panel show?
//   - "forest"  → ≥2 models share the same headline label → real meta-analysis view
//   - "metrics" → mixed units (eg. life family: PV / CSM / SCR / K) → vertical
//                  scorecard, one tile per model, each carrying its own unit
//   - "empty"   → nothing to show yet
//
// Exported so the parent section header can label the subtitle correctly
// ("forest" vs "metrics") without re-doing the grouping.
export type EstimatesMode = "forest" | "metrics" | "empty";

export function estimatesMode(doneRuns: RunResult[]): EstimatesMode {
  if (doneRuns.length === 0) return "empty";
  const { rows } = pickComparableGroup(doneRuns);
  return rows.length >= 2 ? "forest" : "metrics";
}

// Forest plot — the canonical "do my models agree?" actuarial view. Each
// model is a horizontal row; a dot sits at the point estimate, a line spans
// the confidence interval (where available), and a dashed vertical rule
// marks the consensus (median across point estimates). The visual borrows
// from meta-analysis / reserve-committee presentation packs.
function ForestPlot({
  doneRuns,
  familyPalette,
  primary,
  textDim,
  textMute,
  grid,
  renderer = "canvas",
  heightOverride,
}: {
  doneRuns: RunResult[];
  familyPalette: Record<ModelFamily, string>;
  primary: string;
  textDim: string;
  textMute: string;
  grid: string;
  // SVG when the chart needs to print crisply (the report PDF); canvas
  // is fine on screen and faster for interactive panels.
  renderer?: "canvas" | "svg";
  // Override the per-row default sizing — used in the report where we
  // want a roomier chart than the side-panel needs.
  heightOverride?: number;
}) {
  // Branch on the data shape. With <2 comparable runs (single-model or
  // mixed-unit families like life), a forest plot is meaningless — one
  // dot + a "median" line through it reads as a UI bug. Render the
  // metric-scorecard fallback instead. The chart path below ONLY runs
  // when there's a real group to compare.
  const mode = estimatesMode(doneRuns);
  if (mode === "metrics") {
    return <MetricScorecard runs={doneRuns} familyPalette={familyPalette} />;
  }

  const { option, label } = useMemo(() => {
    const { rows: group, label } = pickComparableGroup(doneRuns);
    if (group.length === 0) return { option: null, label: "" };

    // Build a row per model — most-recent-on-top by sorting by family then
    // headline value so neighbouring rows are visually related.
    const rows = group
      .map((r) => ({
        run: r,
        name: MODEL_BY_ID.get(r.modelId)?.name ?? r.modelId,
        family: r.family,
        value: r.headline.value,
        ci: extractInterval(r),
      }))
      .sort((a, b) => {
        if (a.family !== b.family) return a.family.localeCompare(b.family);
        return a.value - b.value;
      });

    const values = rows.map((r) => r.value);
    const intervals = rows.flatMap((r) => (r.ci ? [r.ci.lo, r.ci.hi] : []));
    const allPoints = [...values, ...intervals];
    const lo = Math.min(...allPoints);
    const hi = Math.max(...allPoints);
    const xPad = (hi - lo) * 0.1 || Math.max(Math.abs(hi) * 0.05, 1);

    // Median across point estimates → the consensus reference line.
    const sorted = [...values].sort((a, b) => a - b);
    const mid =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

    // ECharts category axis works top-down by index; we want top-down too.
    const yCategories = rows.map((r) => r.name);
    const yIndexFor = (name: string) => yCategories.indexOf(name);

    // Build series: one thin line per row for the CI band, an inset cap
    // glyph at each end (so the CI feels like a whisker, not a wire), and a
    // single scatter series for all point estimates.
    const ciLineSeries = rows
      .filter((r) => r.ci)
      .map((r) => ({
        name: `${r.name} ci`,
        type: "line" as const,
        data: [
          [r.ci?.lo, yIndexFor(r.name)] as [number, number],
          [r.ci?.hi, yIndexFor(r.name)] as [number, number],
        ],
        showSymbol: false,
        symbol: "none" as const,
        lineStyle: { color: familyPalette[r.family], width: 2, opacity: 0.55 },
        silent: true,
        animation: false,
        z: 2,
      }));
    const ciCapSeries = rows
      .filter((r) => r.ci)
      .map((r) => ({
        name: `${r.name} caps`,
        type: "scatter" as const,
        data: [
          [r.ci?.lo, yIndexFor(r.name)] as [number, number],
          [r.ci?.hi, yIndexFor(r.name)] as [number, number],
        ],
        symbol: "rect" as const,
        symbolSize: [2, 9] as [number, number],
        itemStyle: { color: familyPalette[r.family], opacity: 0.75 },
        silent: true,
        animation: false,
        z: 2,
      }));
    const pointSeries = {
      name: "estimates",
      type: "scatter" as const,
      data: rows.map((r) => ({
        value: [r.value, yIndexFor(r.name)] as [number, number],
        itemStyle: { color: familyPalette[r.family] },
        name: r.name,
      })),
      symbolSize: 10,
      itemStyle: { borderColor: "rgb(var(--rgb-bg-1))", borderWidth: 1.5 },
      z: 3,
    };

    return {
      label,
      option: {
        animation: false,
        grid: { left: 8, right: 12, top: 12, bottom: 24, containLabel: true },
        tooltip: {
          trigger: "item",
          backgroundColor: "rgb(var(--rgb-bg-1))",
          borderColor: "rgb(var(--rgb-border))",
          textStyle: { color: "rgb(var(--rgb-fg))", fontSize: 10 },
          formatter: (params: { seriesName?: string; data?: unknown; name?: string }) => {
            if (params.seriesName !== "estimates") return "";
            const v = Array.isArray((params.data as { value: number[] })?.value)
              ? (params.data as { value: number[] }).value[0]
              : 0;
            const row = rows.find((r) => r.name === params.name);
            const ciLine = row?.ci
              ? `<br/><span style="opacity:0.6">${formatNumber(row.ci.lo)} – ${formatNumber(row.ci.hi)} · ${row.ci.kind}</span>`
              : "";
            return `<b>${params.name ?? "model"}</b><br/>${formatNumber(v)}${ciLine}`;
          },
        },
        xAxis: {
          type: "value",
          min: lo - xPad,
          max: hi + xPad,
          axisLabel: {
            fontSize: 9,
            color: textDim,
            hideOverlap: true,
            formatter: (v: number) => formatNumber(v),
          },
          axisLine: { lineStyle: { color: grid } },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: grid, type: "dashed", opacity: 0.45 } },
        },
        yAxis: {
          type: "category",
          data: yCategories,
          inverse: true,
          axisLabel: {
            fontSize: 9,
            color: textMute,
            // Compact display when names get long.
            formatter: (v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v),
          },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        series: [
          ...ciLineSeries,
          ...ciCapSeries,
          pointSeries,
          {
            name: "consensus",
            type: "line" as const,
            data: [],
            markLine: {
              symbol: "none",
              silent: true,
              lineStyle: { color: primary, type: "dashed", width: 1.25, opacity: 0.85 },
              label: {
                fontSize: 9,
                color: primary,
                formatter: "median",
                position: "insideEndTop",
              },
              data: [{ xAxis: mid }],
            },
            z: 1,
          },
        ],
      },
    };
  }, [doneRuns, familyPalette, primary, textDim, textMute, grid]);

  if (!option) {
    return (
      <p className="py-3 text-center text-[11px] text-fg-dim">No completed runs to compare yet.</p>
    );
  }

  // ~30px per row + axis padding — keeps things compact even for 6+ models.
  const rowCount = (option.yAxis.data as string[]).length;
  const height = heightOverride ?? Math.max(110, Math.min(220, rowCount * 26 + 56));

  return (
    <>
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{ height, width: "100%" }}
        opts={{ renderer }}
      />
      <div className="mt-1 text-center font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        showing: {label}
      </div>
    </>
  );
}

// MetricScorecard — fallback for the "estimates" panel when there's no
// meaningful comparable group to plot. Used when the picked models emit
// different headline metrics (the canonical case: life family — BasicTerm
// PV, IFRS17 CSM, Solvency2 SCR, Cluster K — every model its own unit).
// One compact row per model: family-coloured dot, model name, value +
// unit label. Reads as a one-line scorecard, not a meta-analysis.
function MetricScorecard({
  runs,
  familyPalette,
}: {
  runs: RunResult[];
  familyPalette: Record<ModelFamily, string>;
}) {
  // Same family-then-value sort as the forest so neighbouring rows are
  // visually grouped. Mirrors the forest's reading order.
  const sorted = [...runs].sort((a, b) => {
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    return a.headline.value - b.headline.value;
  });
  if (sorted.length === 0) {
    return (
      <p className="py-3 text-center text-[11px] text-fg-dim">No completed runs to compare yet.</p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {sorted.map((r) => {
        const dot = familyPalette[r.family];
        const name = MODEL_BY_ID.get(r.modelId)?.name ?? r.modelId;
        return (
          <li
            key={r.modelId}
            className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-x-2 py-1.5"
          >
            <span
              className="mt-1 inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: dot }}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="truncate text-[11.5px] text-fg">{name}</div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                {r.headline.label}
              </div>
            </div>
            <div className="text-right font-mono text-[12px] tabular-nums text-fg">
              {formatHeadline(r.headline)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Trajectory overlay — for reserving in particular, the per-origin-year
// ultimate is where disagreement often actually lives (two models can land
// on the same total IBNR but allocate it differently across cohorts). One
// thin line per model, coloured by family. When no run has a `series` we
// fall back to a hint rather than rendering an empty axis.
function TrajectoryOverlay({
  doneRuns,
  familyPalette,
  textDim,
  textMute,
  grid,
  renderer = "canvas",
  heightOverride,
}: {
  doneRuns: RunResult[];
  familyPalette: Record<ModelFamily, string>;
  textDim: string;
  textMute: string;
  grid: string;
  renderer?: "canvas" | "svg";
  heightOverride?: number;
}) {
  const { option, xLabel } = useMemo(() => {
    const withSeries = doneRuns.filter((r) => r.series && r.series.x.length > 0);
    if (withSeries.length === 0) return { option: null, xLabel: "" };

    // Bucket by shared x-axis — only overlay runs that share categories.
    const byKey = new Map<string, RunResult[]>();
    for (const r of withSeries) {
      if (!r.series) continue;
      const k = r.series.x.join("|");
      const arr = byKey.get(k) ?? [];
      arr.push(r);
      byKey.set(k, arr);
    }
    let group: RunResult[] = [];
    for (const arr of byKey.values()) {
      if (arr.length > group.length) group = arr;
    }
    // Fallback: if no two runs share an axis, just show the first one.
    if (group.length === 0) group = [withSeries[0]];
    const baseX = group[0]?.series?.x ?? [];
    if (baseX.length === 0) return { option: null, xLabel: "" };

    // Best-guess x-axis label from the column names we actually use upstream.
    const xLabel = inferTrajectoryAxis(baseX);

    const lineSeries = group.map((r) => {
      const name = MODEL_BY_ID.get(r.modelId)?.name ?? r.modelId;
      return {
        name,
        type: "line" as const,
        data: r.series?.y ?? [],
        smooth: true,
        showSymbol: true,
        symbol: "circle" as const,
        symbolSize: 4,
        lineStyle: { color: familyPalette[r.family], width: 1.5, opacity: 0.9 },
        itemStyle: { color: familyPalette[r.family] },
        emphasis: { lineStyle: { width: 2.5, opacity: 1 } },
        animation: false,
      };
    });

    return {
      xLabel,
      option: {
        animation: false,
        grid: { left: 8, right: 12, top: 12, bottom: 32, containLabel: true },
        legend: {
          show: lineSeries.length > 1,
          bottom: 0,
          textStyle: { color: textMute, fontSize: 9 },
          itemWidth: 8,
          itemHeight: 6,
          itemGap: 8,
        },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "line", lineStyle: { color: grid } },
          backgroundColor: "rgb(var(--rgb-bg-1))",
          borderColor: "rgb(var(--rgb-border))",
          textStyle: { color: "rgb(var(--rgb-fg))", fontSize: 10 },
          formatter: (
            params: Array<{ seriesName: string; data: number; axisValueLabel: string }>,
          ) => {
            if (!Array.isArray(params) || params.length === 0) return "";
            const head = `<b>${params[0].axisValueLabel}</b>`;
            const lines = params.map(
              (p) =>
                `<span style="opacity:0.7">${p.seriesName}</span> ${formatNumber(Number(p.data))}`,
            );
            return [head, ...lines].join("<br/>");
          },
        },
        xAxis: {
          type: "category",
          data: baseX,
          axisLabel: { fontSize: 9, color: textDim, hideOverlap: true },
          axisLine: { lineStyle: { color: grid } },
          axisTick: { show: false },
        },
        yAxis: {
          type: "value",
          axisLabel: {
            fontSize: 9,
            color: textDim,
            formatter: (v: number) => formatNumber(v),
          },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: grid, type: "dashed", opacity: 0.45 } },
        },
        series: lineSeries,
      },
    };
  }, [doneRuns, familyPalette, textDim, textMute, grid]);

  if (!option) {
    return (
      <p className="py-3 text-center text-[11px] text-fg-dim">
        Models on this dataset don't expose a development trajectory.
      </p>
    );
  }

  return (
    <>
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{ height: heightOverride ?? 140, width: "100%" }}
        opts={{ renderer }}
      />
      {xLabel && (
        <div className="mt-1 text-center font-mono text-[9px] uppercase tracking-wider text-fg-dim">
          x: {xLabel}
        </div>
      )}
    </>
  );
}

// Heuristic: most reserving series are origin years (4-digit ints). Mortality
// projections are also year-indexed. Otherwise we just say "category".
function inferTrajectoryAxis(x: string[]): string {
  if (x.length === 0) return "";
  const looksLikeYears = x.every((v) => /^\d{4}$/.test(v));
  if (looksLikeYears) return "origin year";
  return "category";
}

function HardLeftStatsPanel({
  dataset,
  domain,
  runsList,
  enabledCount,
  narrativeStatus,
}: {
  dataset: Dataset | null;
  domain: ModelFamily | null;
  runsList: RunResult[];
  enabledCount: number;
  narrativeStatus: "idle" | "loading" | "ready" | "fallback";
}) {
  const { resolved } = useTheme();
  const familyPalette = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const primary = resolved === "light" ? "#009669" : "#00d68f";
  const textDim = resolved === "light" ? "#8a8a86" : "#6a6a66";
  const textMute = resolved === "light" ? "#5a5a56" : "#9a9a96";
  const grid = resolved === "light" ? "#e6e4df" : "#2a2a2a";

  const stats = useMemo(() => {
    const done = runsList.filter((r) => r.status === "done");
    const running = runsList.filter((r) => r.status === "running").length;
    const errors = runsList.filter((r) => r.status === "error").length;
    // Spread (coefficient of variation) of the largest comparable sub-group.
    let cov: number | null = null;
    if (done.length >= 2) {
      const byLabel = new Map<string, number[]>();
      for (const r of done) {
        const k = r.headline.label;
        const arr = byLabel.get(k) ?? [];
        arr.push(r.headline.value);
        byLabel.set(k, arr);
      }
      let largest: number[] = [];
      for (const arr of byLabel.values()) {
        if (arr.length > largest.length) largest = arr;
      }
      if (largest.length >= 2) {
        const mean = largest.reduce((a, b) => a + b, 0) / largest.length;
        if (mean !== 0) {
          const variance = largest.reduce((acc, v) => acc + (v - mean) ** 2, 0) / largest.length;
          cov = Math.sqrt(variance) / Math.abs(mean);
        }
      }
    }
    return { done, running, errors, cov };
  }, [runsList]);

  const narrativeLabel =
    narrativeStatus === "loading"
      ? "narrating…"
      : narrativeStatus === "ready"
        ? "ready"
        : narrativeStatus === "fallback"
          ? "local"
          : "idle";
  const narrativeAccent: HardTileAccent =
    narrativeStatus === "loading"
      ? "warn"
      : narrativeStatus === "fallback"
        ? "warn"
        : narrativeStatus === "ready"
          ? "primary"
          : "primary";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        run stats
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {!dataset ? (
          <p className="px-1 py-4 text-center text-[11px] text-fg-dim">
            Load a dataset and run the models to see stats here.
          </p>
        ) : (
          <>
            {/* container 1: run snapshot */}
            <section className="rounded border border-border bg-bg-1 p-2">
              <header className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                snapshot
              </header>
              <div className="grid grid-cols-2 gap-1.5">
                <HardStatTile label="attached" value={enabledCount} accent="primary" />
                <HardStatTile label="complete" value={stats.done.length} accent="primary" />
                {stats.running > 0 && (
                  <HardStatTile label="running" value={stats.running} accent="warn" />
                )}
                {stats.errors > 0 && (
                  <HardStatTile label="errors" value={stats.errors} accent="error" />
                )}
                <HardStatTile
                  label="rows"
                  value={dataset.rows.length.toLocaleString()}
                  accent="accent-2"
                />
                <HardStatTile
                  label="spread"
                  value={stats.cov === null ? "—" : `${(stats.cov * 100).toFixed(1)}%`}
                  accent={
                    stats.cov === null
                      ? "primary"
                      : stats.cov > 0.15
                        ? "error"
                        : stats.cov > 0.05
                          ? "warn"
                          : "primary"
                  }
                />
                <HardStatTile
                  label="domain"
                  value={domain ?? "—"}
                  inlineColor={domain ? familyPalette[domain] : undefined}
                />
                <HardStatTile label="narrative" value={narrativeLabel} accent={narrativeAccent} />
              </div>
            </section>

            {/* container 2: forest plot OR per-model scorecard depending on
                whether the picked models share a comparable headline metric */}
            <section className="rounded border border-border bg-bg-1 p-2">
              <header className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  estimates · {estimatesMode(stats.done) === "forest" ? "forest" : "metrics"}
                </span>
                <span className="font-mono text-[10px] text-primary">
                  {stats.done.length} run{stats.done.length === 1 ? "" : "s"}
                </span>
              </header>
              <ForestPlot
                doneRuns={stats.done}
                familyPalette={familyPalette}
                primary={primary}
                textDim={textDim}
                textMute={textMute}
                grid={grid}
              />
            </section>

            {/* container 3: per-cohort trajectory overlay */}
            <section className="rounded border border-border bg-bg-1 p-2">
              <header className="mb-1 flex items-baseline justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  trajectory
                </span>
                <span className="font-mono text-[10px] text-fg-dim">where do they diverge?</span>
              </header>
              <TrajectoryOverlay
                doneRuns={stats.done}
                familyPalette={familyPalette}
                textDim={textDim}
                textMute={textMute}
                grid={grid}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ── right panel ─────────────────────────────────────────────────────────────

function ResultDetailsPanel({
  focused,
  narrative,
  narrativeStatus,
  dataset,
  doneRuns,
}: {
  focused: RunResult | null;
  narrative: string | null;
  narrativeStatus: "idle" | "loading" | "ready" | "fallback";
  dataset: Dataset | null;
  /** All completed runs — used to surface the Forecast / Council CTAs in
   *  the default panel (no node clicked) on top of the dominant run, so
   *  the actions are discoverable without having to click first. */
  doneRuns: RunResult[];
}) {
  // Pick the "dominant" completed run for the no-focus board-pack default:
  // largest |headline| among runs whose family has a forecast mapping.
  // This lets the user trigger forecast / council on the most consequential
  // result without first having to click a node on the canvas.
  const defaultTarget = useMemo<RunResult | null>(() => {
    const candidates = doneRuns.filter((r) => hasForecastDomain(r.family));
    if (candidates.length === 0) return null;
    return candidates
      .slice()
      .sort((a, b) => Math.abs(b.headline.value) - Math.abs(a.headline.value))[0];
  }, [doneRuns]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        {focused ? "result · detail" : "board pack · narrative"}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {focused ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                {focused.family}
              </div>
              <h2 className="text-sm text-fg">
                {MODEL_BY_ID.get(focused.modelId)?.name ?? focused.modelId}
              </h2>
              <p className="mt-1 text-[11px] text-fg-mute">{focused.blurb}</p>
            </div>
            <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
              <Stat
                label={focused.headline.label}
                value={formatHeadline(focused.headline)}
                primary
              />
              {focused.secondary.map((s) => (
                <Stat key={s.label} label={s.label} value={s.value} />
              ))}
            </div>
            {focused.status === "error" && (
              <div className="rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[11px] text-error">
                error: {focused.error ?? "unknown"}
              </div>
            )}
            {isLifelibModel(focused.modelId) && (
              <LifelibNotebookCta modelId={focused.modelId} dataset={dataset} />
            )}
            {hasForecastDomain(focused.family) &&
              focused.modelId !== "wmtr-projection" &&
              focused.modelId !== "wmtr-sensitivity" && <ForecastAttachCta focused={focused} />}
            {hasForecastDomain(focused.family) && <CouncilAttachCta focused={focused} />}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {narrativeStatus === "loading" && (
              <p className="text-[11px] italic text-fg-dim">drafting executive narrative…</p>
            )}
            {narrative ? (
              <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">
                {narrative}
              </div>
            ) : (
              <p className="text-[11px] text-fg-dim">
                The narrative will appear here once the runs finish.
              </p>
            )}
            {narrativeStatus === "fallback" && (
              <p className="text-[10px] text-fg-dim">
                Couldn't reach the model; using a local stitched-together fallback. Try rerun.
              </p>
            )}
            {defaultTarget && (
              <>
                <div className="mt-1 border-t border-border pt-2 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                  cross-cutting actions · on the dominant run
                </div>
                <p className="text-[10px] text-fg-dim italic">
                  Targeting{" "}
                  <span className="text-fg-mute">
                    {MODEL_BY_ID.get(defaultTarget.modelId)?.name ?? defaultTarget.modelId}
                  </span>{" "}
                  — click a different result node to retarget.
                </p>
                {defaultTarget.modelId !== "wmtr-projection" &&
                  defaultTarget.modelId !== "wmtr-sensitivity" && (
                    <ForecastAttachCta focused={defaultTarget} />
                  )}
                <CouncilAttachCta focused={defaultTarget} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LifelibNotebookCta({
  modelId,
  dataset,
}: {
  modelId: string;
  dataset: Dataset | null;
}) {
  const onDownload = () => {
    try {
      const nb = buildLifelibNotebook(modelId, dataset);
      const fname = `${modelId}_lifelib.ipynb`;
      triggerNotebookDownload(fname, nb);
    } catch (e) {
      console.error("lifelib notebook export failed", e);
    }
  };
  return (
    <div className="rounded border border-border bg-bg-1 p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        bridge · run in python
      </div>
      <p className="mt-1 text-[11px] text-fg-mute">
        The in-browser run is a faithful port of the lifelib model. Download a pre-filled Jupyter
        notebook to reproduce it with the canonical Python library on your own model-point file at
        full scale.
      </p>
      <button
        type="button"
        onClick={onDownload}
        className="mt-2 inline-flex items-center gap-1.5 rounded border border-border bg-bg px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg transition hover:border-fg-dim hover:text-fg"
      >
        ↓ Export · lifelib notebook
      </button>
      {!dataset && (
        <div className="mt-1.5 text-[10px] text-fg-dim italic">
          No MP file attached — notebook ships with an empty DataFrame; replace with{" "}
          <code>pd.read_csv(...)</code> on load.
        </div>
      )}
    </div>
  );
}

// ── ForecastAttachCta · per-result "Forecast forward" meta-action ────────
//
// Surfaces only on result cards whose family has a sensible M/T/R mapping
// (see hasForecastDomain). Synthesizes a WMTR config from the result +
// the source scenario and runs the engine inline. The card relabels M/T/R
// for the source family so the projection reads in that domain's language.

function ForecastAttachCta({ focused }: { focused: RunResult }) {
  const { dataset } = useScelo();
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scenario = dataset?.name ?? null;

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Paint "projecting…" before the synchronous engine blocks the thread —
    // setBusy alone never reaches the screen.
    await nextPaint();
    try {
      const config = forecastConfigFor(focused, scenario, focused.family);
      const r = runForecast(config, focused.family);
      setForecast(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "forecast failed");
    } finally {
      setBusy(false);
    }
  }, [focused, scenario]);

  return (
    <div className="rounded border border-border bg-bg-1 p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        forecast forward · W(M, T, R)
      </div>
      <p className="mt-1 text-[11px] text-fg-mute">
        Project this result forward under shocks. M / T / R relabelled for the source family.
      </p>
      {!forecast && (
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1.5 rounded border border-border bg-bg px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg transition hover:border-fg-dim hover:text-fg disabled:opacity-50"
        >
          {busy ? "projecting…" : "▷ run forecast"}
        </button>
      )}
      {error && <div className="mt-1.5 text-[10px] text-error">{error}</div>}
      {forecast && <ForecastInline forecast={forecast} />}
    </div>
  );
}

function ForecastInline({ forecast }: { forecast: ForecastResult }) {
  const { labels, result, config, dominantOutcome, driver } = forecast;
  const last = result.years.length - 1;
  const finalSurv = result.meanSurv[last] ?? 0;
  const finalW = result.meanW[last] ?? 0;
  const ratio = result.w0 > 0 ? finalW / result.w0 : 0;
  const outcomeLabel = (k: "grew" | "stabilized" | "declined" | "collapsed") =>
    labels.outcomeLabels?.[k] ?? k;
  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        {labels.headline}
      </div>
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        <div className="rounded bg-bg px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">M</div>
          <div className="text-fg-mute leading-tight">{labels.M}</div>
        </div>
        <div className="rounded bg-bg px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">T</div>
          <div className="text-fg-mute leading-tight">{labels.T}</div>
        </div>
        <div className="rounded bg-bg px-1.5 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">R</div>
          <div className="text-fg-mute leading-tight">{labels.R}</div>
        </div>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1 text-[10px]">
        <div className="rounded border border-border bg-bg px-2 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">
            survival @ {config.horizon}y
          </div>
          <div className="text-fg font-medium">{(finalSurv * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded border border-border bg-bg px-2 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">W / W₀</div>
          <div className="text-fg font-medium">
            {ratio >= 1 ? "+" : ""}
            {((ratio - 1) * 100).toFixed(0)}%
          </div>
        </div>
      </div>
      <div className="mt-1 flex flex-col gap-1">
        <div className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
          outcome distribution
        </div>
        {(["grew", "stabilized", "declined", "collapsed"] as const).map((k) => {
          const v = result.outcomeFractions[k];
          return (
            <div
              key={k}
              className="grid grid-cols-[80px_1fr_36px] items-center gap-1.5 text-[10px]"
            >
              <span className="text-fg-mute truncate">{outcomeLabel(k)}</span>
              <span className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
                <span
                  className="block h-full"
                  style={{
                    width: `${Math.max(1, v * 100)}%`,
                    background:
                      k === "grew"
                        ? "rgb(var(--rgb-primary))"
                        : k === "stabilized"
                          ? "rgb(var(--rgb-accent-2))"
                          : k === "declined"
                            ? "rgb(var(--rgb-warn))"
                            : "rgb(var(--rgb-error))",
                  }}
                />
              </span>
              <span className="text-fg-mute text-right font-mono tabular-nums">
                {(v * 100).toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        dominant: <span className="text-fg-mute">{outcomeLabel(dominantOutcome)}</span> · driver:{" "}
        <span className="text-fg-mute">{driver}</span> · shock:{" "}
        <span className="text-fg-mute">{config.shock}</span>
      </div>
    </div>
  );
}

// ── CouncilAttachCta · per-result "Convene council" meta-action ──────────
//
// Calls out to the swarm server (canonical 192-agent deliberation app on
// :3010) and renders the synthesis inline. Subset defaults to 12 to keep
// per-result clicks cheap; user can dial up to 192 for deep council.

// Swarm API liveness for the council CTA. Mirrors SwarmPanel's probe (no-cors
// fetch: connection-refused throws, any HTTP response resolves) but targets
// the :3010 API base the council actually calls — including the ?swarmUrl=
// override — so the status dot can never disagree with the button's fate.
function CouncilAttachCta({ focused }: { focused: RunResult }) {
  const { dataset } = useScelo();
  const navigate = useNavigate();
  const [synth, setSynth] = useState<CouncilSynthesis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressId, setProgressId] = useState<string | null>(null);
  const [subset, setSubset] = useState<12 | 24 | 48 | 96 | 192>(12);
  const probe = useSwarmProbe();
  // Society pulse defaults ON so the swarm app's Society tab is populated
  // when the user clicks "open in swarm ↗". Adds ~30s of Ollama time on a
  // local run; the user can opt out via the "skip society" toggle for a
  // faster council-only deliberation.
  const [skipSociety, setSkipSociety] = useState(false);

  const convene = useCallback(() => {
    setBusy(true);
    setError(null);
    setProgressId(null);
    const labelName = MODEL_BY_ID.get(focused.modelId)?.name ?? focused.modelId;
    const scenarioContext =
      `${labelName} (${focused.family}) result on dataset \`${dataset?.name ?? "unknown"}\`: ` +
      `${focused.headline.label} = ${formatHeadline(focused.headline)}. ${focused.blurb}`;
    void conveneCouncil({
      scenario: scenarioContext,
      subset,
      skipSociety,
      onStart: (id) => setProgressId(id),
    })
      .then((s) => setSynth(s))
      .catch((e) => setError(e instanceof Error ? e.message : "council failed"))
      .finally(() => setBusy(false));
  }, [focused, dataset, subset, skipSociety]);

  return (
    <div className="rounded border border-border bg-bg-1 p-2.5">
      <div className="flex items-baseline justify-between font-mono text-[9px] uppercase tracking-wider text-fg-dim">
        <span>convene council · swarm @ :3010</span>
        <span
          className={probe === "up" ? "text-primary" : probe === "down" ? "text-error" : ""}
          title={probe === "up" ? "swarm API reachable" : "swarm API not reachable"}
        >
          {probe === "up" && "● live"}
          {probe === "probing" && "○ probing…"}
          {probe === "down" && "● offline"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-fg-mute">
        N stratified personas interrogate this result. Trust / distrust + a proposed parameter shift
        come back.
      </p>
      {probe === "down" && !synth && (
        <div className="mt-2 rounded border border-border bg-bg-2 p-2 text-[10px] text-fg-mute">
          The swarm is a separate app (not bundled with Scelo) and nothing is listening on :3010.
          Start it from your swarms checkout:
          <code className="mt-1 block select-all rounded bg-bg-1 px-1.5 py-1 font-mono text-fg">
            {swarmStartCommand()}
          </code>
          <span className="mt-1 block text-fg-dim">
            Its default port is 3000 — the PORT=3010 override is required. This panel re-probes
            every 5 seconds.{" "}
            <a
              href={SWARM_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-fg"
            >
              docs: swarm/running
            </a>
          </span>
          <button
            type="button"
            onClick={() => navigate("/swarm")}
            className="ia-btn ia-btn-sm ia-btn-secondary mt-2 w-full justify-center"
            title="Open the full swarm screen — it live-probes the server and shows the embedded swarm UI once it's up"
          >
            open the swarm screen →
          </button>
        </div>
      )}
      {!synth && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[10px] text-fg-mute">
              <span>Agents</span>
              <div className="relative inline-flex items-center text-fg">
                <select
                  value={subset}
                  onChange={(e) => setSubset(Number(e.target.value) as typeof subset)}
                  disabled={busy}
                  className="ia-btn ia-btn-sm ia-btn-secondary appearance-none pr-7 font-mono"
                >
                  <option value={12}>12</option>
                  <option value={24}>24</option>
                  <option value={48}>48</option>
                  <option value={96}>96</option>
                  <option value={192}>192 · full</option>
                </select>
                {/* Single-stroke chevron overlaid as a span : we can't
                 *  use `stroke="currentColor"` in a data-URL background
                 *  (data URLs render in isolation, so currentColor
                 *  resolves to the SVG default of black). A mask-image
                 *  fills currentColor via background-color, so the
                 *  arrow correctly tracks the select's text colour
                 *  across light + dark themes. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-2 h-3 w-3 bg-current"
                  style={{
                    WebkitMaskImage:
                      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6.5l4 4 4-4'/%3E%3C/svg%3E\")",
                    maskImage:
                      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6.5l4 4 4-4'/%3E%3C/svg%3E\")",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                    WebkitMaskPosition: "center",
                    maskPosition: "center",
                    WebkitMaskSize: "contain",
                    maskSize: "contain",
                  }}
                />
              </div>
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-fg-mute">
              <input
                type="checkbox"
                checked={skipSociety}
                onChange={(e) => setSkipSociety(e.target.checked)}
                disabled={busy}
                className="h-3 w-3 accent-fg"
              />
              Skip society pulse
            </label>
          </div>
          <button
            type="button"
            onClick={convene}
            disabled={busy || probe === "down"}
            className="ia-btn ia-btn-md ia-btn-secondary group w-full justify-between"
            title={
              probe === "down"
                ? "Swarm server offline — start it on :3010 first"
                : "Run a council on this result"
            }
          >
            <span className="flex items-center gap-2">
              <ConveneIcon className="h-4 w-4 text-fg-mute group-hover:text-fg" />
              <span className="font-medium">
                {busy ? (progressId ? "Deliberating…" : "Starting…") : "Convene council"}
              </span>
            </span>
            <span className="font-mono text-[10px] text-fg-dim group-hover:text-fg-mute">
              {subset} agents
              {skipSociety ? " · council-only" : " · + society"}
            </span>
          </button>
          {/* A local-LLM council deliberates for minutes — surface the live
              swarm view as soon as the run has an id, not only when the
              synthesis lands. */}
          {busy && progressId && <OpenInSwarmLink runId={progressId} live />}
        </div>
      )}
      {error && (
        <div className="mt-1.5 text-[10px] text-error">
          {/failed to fetch/i.test(error) ? "swarm server unreachable at :3010" : error}
          <div className="text-[9px] text-fg-dim mt-0.5">
            {/timed out/i.test(error)
              ? "A large council (192 agents + society) on a local model can take a long time. Try a smaller agent count, enable “Skip society pulse”, or point the swarm at a faster provider — the run may still be finishing server-side."
              : /failed to fetch/i.test(error)
                ? `The swarm runs from a separate checkout — start it there with \`${swarmStartCommand()}\` (its default port is 3000, so the PORT=3010 override is required).`
                : "The swarm server responded but the run failed — check the swarm app's own logs for the run error."}
          </div>
        </div>
      )}
      {synth && <CouncilSynthesisCard synth={synth} />}
    </div>
  );
}

function CouncilSynthesisCard({ synth }: { synth: CouncilSynthesis }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        <div className="rounded border border-border bg-bg px-2 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">trust</div>
          <div className="text-primary font-medium">{synth.trustPct}%</div>
        </div>
        <div className="rounded border border-border bg-bg px-2 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">distrust</div>
          <div className="text-error font-medium">{synth.distrustPct}%</div>
        </div>
        <div className="rounded border border-border bg-bg px-2 py-1">
          <div className="font-mono text-[8px] uppercase text-fg-dim">uncertain</div>
          <div className="text-fg-mute font-medium">{synth.uncertainPct}%</div>
        </div>
      </div>
      {synth.dominantIntervention && (
        <div className="mt-1 rounded border border-border bg-bg px-2 py-1.5">
          <div className="font-mono text-[8px] uppercase text-fg-dim">
            dominant intervention · {synth.dominantIntervention.count} agents
          </div>
          <div className="text-[11px] text-fg">
            <span className="text-primary">
              {synth.dominantIntervention.direction === "increase" ? "↑" : "↓"}
            </span>{" "}
            <span className="font-mono">{synth.dominantIntervention.param}</span>{" "}
            <span className="text-fg-mute text-[10px]">
              ({synth.dominantIntervention.magnitude})
            </span>
          </div>
          {synth.dominantIntervention.exemplarRationale && (
            <div className="mt-0.5 text-[10px] italic text-fg-mute">
              "{synth.dominantIntervention.exemplarRationale}"
            </div>
          )}
        </div>
      )}
      <OpenInSwarmLink runId={synth.runId} />
    </div>
  );
}

/** "Open in swarm" : the primary CTA on a synthesis card, and (with
 *  `live`) the watch-it-deliberate link shown while a run is still in
 *  flight. Inside the IDE we route through swarmBus so /swarm loads the
 *  run-specific iframe; in the browser preview the same navigation works
 *  (the Swarm route degrades to an iframe of localhost:5190 which the
 *  user may or may not have running). Minimalist single-stroke icon per
 *  the rest of the site's iconography (currentColor, 1.5 stroke,
 *  round caps). */
function OpenInSwarmLink({ runId, live = false }: { runId: string; live?: boolean }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        // Cache the runId on the bus so /swarm reads it on mount, then
        // navigate to the full-window swarm route.
        openInSwarm({ runId });
        navigate("/swarm");
      }}
      title={
        live
          ? `Watch run ${runId} deliberate live in the swarm view`
          : `Open the full deliberation for ${runId} in the swarm view`
      }
      className="group mt-1 flex w-full items-center justify-between gap-2 rounded border border-border bg-bg-2 px-3 py-2 text-xs text-fg transition hover:border-primary hover:bg-bg-1"
    >
      <span className="flex items-center gap-2">
        <ExternalSquareIcon className="h-4 w-4 text-fg-mute group-hover:text-primary" />
        <span className="font-medium">{live ? "Watch live in swarm" : "Open in swarm"}</span>
      </span>
      <span className="font-mono text-[10px] text-fg-dim group-hover:text-fg-mute">
        {live ? "deliberating now →" : "full deliberation →"}
      </span>
    </button>
  );
}

/** 16×16 minimalist "open in new" mark : a square with an arrow
 *  escaping its top-right corner. Single-stroke, currentColor, 1.5
 *  width, round joins — matches the iconography spec. */
function ExternalSquareIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* Bottom-left square (the "from"). */}
      <path d="M3 7.5v5a1 1 0 0 0 1 1h5" />
      {/* Top-right arrow (the "to"). */}
      <path d="M9 3h4v4" />
      <path d="M13 3l-6 6" />
    </svg>
  );
}

/** 16×16 "convene" mark : a central node with three arcs gathering
 *  around it, reading as "a council assembling." Same single-stroke
 *  recipe as the other IDE icons. */
function ConveneIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* Centre node. */}
      <circle cx={8} cy={8} r={1.6} />
      {/* Three surrounding nodes at top, bottom-left, bottom-right. */}
      <circle cx={8} cy={3} r={1.2} />
      <circle cx={3.5} cy={12} r={1.2} />
      <circle cx={12.5} cy={12} r={1.2} />
      {/* Connecting lines, each stopping short of the dots so they
       *  don't visually merge. */}
      <path d="M8 6.4V4.2" />
      <path d="M6.7 9.2L4.6 10.9" />
      <path d="M9.3 9.2l2.1 1.7" />
    </svg>
  );
}

function Stat({
  label,
  value,
  primary,
}: {
  label: string;
  value: string;
  primary?: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded border bg-bg-1 px-2 py-1 ${
        primary ? "border-primary col-span-2" : "border-border"
      }`}
    >
      <span className="text-[9px] uppercase tracking-wider text-fg-dim">{label}</span>
      <span className={`truncate ${primary ? "text-base text-primary" : "text-fg"}`}>{value}</span>
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

// Run-staleness key for the dataset. Every transform (clean / derive /
// augment) creates a NEW dataset object but usually keeps the same `name`,
// so object identity — not the name — is the correct invalidation signal.
// WeakMap so superseded dataset versions stay collectable.
const datasetVersionByRef = new WeakMap<Dataset, number>();
let nextDatasetVersion = 1;
function datasetVersion(dataset: Dataset): number {
  let v = datasetVersionByRef.get(dataset);
  if (v === undefined) {
    v = nextDatasetVersion++;
    datasetVersionByRef.set(dataset, v);
  }
  return v;
}

export function HardDataWorkstation() {
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const { dataset, selectedModels, domain, runs, setRuns, logEvent } = useScelo();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeStatus, setNarrativeStatus] = useState<"idle" | "loading" | "ready" | "fallback">(
    "idle",
  );
  const [regenSeed, setRegenSeed] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  // Which result node has its detail dashboard open. Null = none.
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const onExpandRun = useCallback((modelId: string) => setExpandedRunId(modelId), []);
  // The board-pack hub "expands" into the printable report (which owns PDF).
  const onExpandHub = useCallback(() => setReportOpen(true), []);

  const palette = resolved === "light" ? FAMILY_COLOR_LIGHT : FAMILY_COLOR_DARK;
  const edgeBase = resolved === "light" ? "#bdbdb8" : "#3a3a3a";

  const enabled = useMemo(() => selectedModels.filter((m) => m.enabled), [selectedModels]);
  const enabledKey = useMemo(() => enabled.map((m) => m.id).join("|"), [enabled]);
  // Identity-derived version so cleaning / derive / augment (new dataset
  // object, same name) correctly invalidate the runs.
  const datasetKey = dataset ? datasetVersion(dataset) : -1;

  // Monotonic token so a run batch that was superseded mid-flight (dataset
  // swap, model toggle, unmount) stops writing results.
  const runEpoch = useRef(0);

  // Batch-level busy state for the canvas overlay — same loading vocabulary
  // as Soft's import/combine. Done/total gives HONEST determinate progress
  // (models completed, not time); `current` names the model on the rail.
  const [computeBusy, setComputeBusy] = useState<{
    done: number;
    total: number;
    current: string;
  } | null>(null);

  // Execute all enabled models. Models with a Python/R bridge go through
  // runModelAsync (the desktop IDE's bundled runtime — canonical numbers);
  // everything else uses the sync in-browser runner. Every model is staged
  // as "running" first so the status pips pulse while bridges execute, and
  // results land one by one as they finish. The sync runners block the main
  // thread, so the overlay is committed via a double-rAF before the loop and
  // the loop yields a frame per model — the browser gets a paint between
  // models instead of one long freeze.
  const executeRuns = useCallback(
    async (models: SelectedModel[], ds: Dataset) => {
      const epoch = ++runEpoch.current;
      const startedAt = performance.now();
      setComputeBusy({ done: 0, total: models.length, current: models[0]?.id ?? "" });
      const staged: Record<string, RunResult> = {};
      for (const m of models) {
        staged[m.id] = {
          modelId: m.id,
          family: MODEL_BY_ID.get(m.id)?.family ?? "general",
          status: "running",
          startedAt: Date.now(),
          headline: { label: "—", value: 0 },
          secondary: [],
          blurb: `${m.id} is running…`,
        };
      }
      setRuns(staged);
      // Commit the overlay + staged pips to screen before the first
      // synchronous model blocks the thread. nextPaint (not raw rAF): rAF
      // never fires in hidden/occluded tabs, which would stall the whole
      // batch until the tab is refocused.
      await nextPaint();
      try {
        let done = 0;
        for (const m of models) {
          if (runEpoch.current !== epoch) return; // superseded mid-flight
          setComputeBusy({ done, total: models.length, current: m.id });
          // One paint so the overlay's model name / progress just set above
          // reaches the screen before this model blocks the thread.
          await nextPaint();
          let result: RunResult;
          try {
            result = BRIDGED_MODEL_IDS.has(m.id)
              ? await runModelAsync(m.id, ds)
              : runModel(m.id, ds);
          } catch (e) {
            // Both runners catch internally; this guard keeps one unexpected
            // rejection from killing the rest of the batch.
            const msg = e instanceof Error ? e.message : String(e);
            result = {
              modelId: m.id,
              family: MODEL_BY_ID.get(m.id)?.family ?? "general",
              status: "error",
              startedAt: Date.now(),
              finishedAt: Date.now(),
              headline: { label: "—", value: 0 },
              secondary: [{ label: "reason", value: msg }],
              blurb: `${m.id} failed: ${msg}`,
              error: msg,
              source: "browser",
            };
          }
          if (runEpoch.current !== epoch) return; // superseded mid-flight
          done++;
          setRuns((prev) => ({ ...prev, [m.id]: result }));
        }
        logEvent({
          stage: "hard",
          kind: "runs.execute",
          payload: { models: models.map((m) => m.id) },
        });
      } finally {
        // Only the batch that owns the overlay may clear it — a superseding
        // batch has already replaced it with its own state.
        if (runEpoch.current === epoch) {
          const remaining = 350 - (performance.now() - startedAt);
          if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
          if (runEpoch.current === epoch) setComputeBusy(null);
        }
      }
    },
    [setRuns, logEvent],
  );

  // Run all enabled models whenever the (dataset, enabled set) changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to dataset + enabled set identity only.
  useEffect(() => {
    if (!dataset || enabled.length === 0) {
      setRuns({});
      setComputeBusy(null);
      return;
    }
    void executeRuns(enabled, dataset);
    return () => {
      // Invalidate the in-flight batch when the deps change / unmount.
      runEpoch.current++;
    };
  }, [datasetKey, enabledKey]);

  // Narrative: pulled from the orchestrator with a heuristic fallback. Refires
  // whenever the run set changes meaningfully OR the user hits rerun.
  const runsList = useMemo(() => Object.values(runs), [runs]);
  const runsFingerprint = useMemo(
    () => runsList.map((r) => `${r.modelId}:${r.status}:${r.headline.value}`).join("|"),
    [runsList],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: react to runs fingerprint + regenerate seed; dataset/domain change → fingerprint changes.
  useEffect(() => {
    if (!dataset || runsList.length === 0) {
      setNarrative(null);
      setNarrativeStatus("idle");
      return;
    }
    // Bridged models resolve asynchronously — hold the narrative until the
    // whole batch has settled so it never describes a half-finished board.
    if (runsList.some((r) => r.status === "running")) return;
    const ac = new AbortController();
    setNarrativeStatus("loading");
    fetchNarrative({
      dataset,
      domain,
      runs: runsList,
      variant: regenSeed,
      signal: ac.signal,
    })
      .then((text) => {
        if (ac.signal.aborted) return;
        setNarrative(text);
        setNarrativeStatus("ready");
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setNarrative(heuristicNarrative({ dataset, domain, runs: runsList }));
        setNarrativeStatus("fallback");
      });
    return () => ac.abort();
  }, [runsFingerprint, regenSeed]);

  // Manual rerun — recompute runs AND nudge the narrative variant counter.
  const rerun = useCallback(() => {
    if (!dataset) return;
    void executeRuns(enabled, dataset);
    setRegenSeed((s) => s + 1);
  }, [dataset, enabled, executeRuns]);

  // React Flow nodes + edges ─────────────────────────────────────────────────
  // Derived "desired" shape — the real React Flow state lives below and
  // preserves any user-dragged positions on subsequent re-renders.
  const desiredNodes: Node[] = useMemo(() => {
    if (!dataset) return [];
    const layout = columnLayout(runsList.length);
    const hub: Node<HubNodeData> = {
      id: "hub",
      type: "hub",
      position: { x: -HUB_W / 2, y: -HUB_H / 2 },
      data: {
        dataset,
        domain,
        runCount: runsList.filter((r) => r.status === "done").length,
        narrative,
        status: narrativeStatus,
        onExpand: onExpandHub,
      },
      draggable: true,
      selectable: false,
    };
    const results: Node<ResultNodeData>[] = runsList.map((r, i) => {
      const color = palette[r.family];
      return {
        id: `result-${r.modelId}`,
        type: "result",
        position: { x: layout[i].x - RESULT_W / 2, y: layout[i].y - RESULT_H / 2 },
        data: { run: r, isFocused: focusedId === r.modelId, color, onExpand: onExpandRun },
        draggable: true,
      };
    });
    return [hub, ...results];
  }, [
    dataset,
    runsList,
    domain,
    narrative,
    narrativeStatus,
    focusedId,
    palette,
    onExpandRun,
    onExpandHub,
  ]);

  const desiredEdges: Edge[] = useMemo(() => {
    return runsList.map((r): Edge => {
      const color = r.status === "done" ? palette[r.family] : edgeBase;
      return {
        id: `e-${r.modelId}`,
        source: `result-${r.modelId}`,
        target: "hub",
        animated: r.status === "done",
        style: {
          stroke: color,
          strokeWidth: r.status === "done" ? 1.5 : 1,
          opacity: r.status === "done" ? 1 : 0.5,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
  }, [runsList, palette, edgeBase]);

  // Controlled state — required for nodes to actually be draggable. The sync
  // effect below carries id-by-id positions across renders so a node the user
  // dragged doesn't snap back when results re-derive.
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
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

  // Auto-fit once spokes first appear — `fitView` prop only fires on mount,
  // but our nodes are inserted via the sync effect *after* mount.
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const hasFitRef = useRef(false);
  useEffect(() => {
    if (hasFitRef.current) return;
    if (nodes.length < 2) return;
    const inst = flowInstanceRef.current;
    if (!inst) return;
    hasFitRef.current = true;
    requestAnimationFrame(() => {
      inst.fitView({ padding: 0.2, duration: 300 });
    });
  }, [nodes.length]);

  const relayout = useCallback(() => {
    hasFitRef.current = false;
    setNodes(desiredNodes);
    requestAnimationFrame(() => {
      flowInstanceRef.current?.fitView({ padding: 0.2, duration: 300 });
    });
  }, [desiredNodes, setNodes]);

  // Chatbar ──────────────────────────────────────────────────────────────────
  const chatStageContext = useMemo(
    () => buildHardStageContext({ dataset, domain, runs: runsList, narrative }),
    [dataset, domain, runsList, narrative],
  );
  const chatPlaceholder = useMemo(() => {
    if (!dataset) return "load a dataset in Soft Data first…";
    if (runsList.length === 0) return "pick models in Tools, then ask scelo about them…";
    return `ask scelo about these ${runsList.length} result${runsList.length === 1 ? "" : "s"}…`;
  }, [dataset, runsList.length]);

  const focused = focusedId ? (runs[focusedId] ?? null) : null;
  const doneRuns = useMemo(() => Object.values(runs).filter((r) => r.status === "done"), [runs]);

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
          onClick={() => navigate("/dashboards/scelo/tools")}
          title="Step back to model selection."
          className="font-mono text-xs text-fg-mute hover:text-primary"
        >
          ← back: tools
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-3">
            <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
            <span>hard</span>
          </div>
          <h1 className="truncate text-sm text-fg">workstation</h1>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => navigate("/dashboards/scelo/tools")}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
          >
            edit models
          </button>
          <button
            type="button"
            onClick={rerun}
            disabled={!dataset || enabled.length === 0}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            rerun & regenerate
          </button>
          <button
            type="button"
            onClick={relayout}
            disabled={!dataset || enabled.length === 0}
            title="Snap nodes back to the default circle and refit the view."
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            re-layout
          </button>
          <ExportButton stage="hard" disabled={!dataset} />
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            disabled={!dataset}
            title="Open a printable board-pack preview"
            className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-2 disabled:text-fg-dim"
          >
            report · pdf
          </button>
        </div>
      </header>

      {/* banner */}
      {dataset ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            board pack for
          </span>
          <span className="font-mono text-xs text-fg">{dataset.name}</span>
          <span className="font-mono text-[10px] text-fg-dim">
            {dataset.rows.length} rows · {selectedModels.length} model
            {selectedModels.length === 1 ? "" : "s"} attached
          </span>
          {domain && (
            <span
              className="ml-auto rounded border bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
              style={{ color: palette[domain], borderColor: palette[domain] }}
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
            go to Soft Data →
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <ResizablePanel
          side="left"
          defaultWidth={256}
          badge="hard · stats"
          accentClass="text-accent-3"
        >
          <HardLeftStatsPanel
            dataset={dataset}
            domain={domain}
            runsList={runsList}
            enabledCount={enabled.length}
            narrativeStatus={narrativeStatus}
          />
        </ResizablePanel>
        <main className="relative min-w-0 flex-1">
          {computeBusy && (
            <UploadIndicator
              layout="overlay"
              accent="accent-2"
              state={{
                verb: "computing",
                name: computeBusy.current,
                pct:
                  computeBusy.total > 0 ? (100 * computeBusy.done) / computeBusy.total : undefined,
              }}
            />
          )}
          {dataset && enabled.length > 0 ? (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={(inst) => {
                flowInstanceRef.current = inst;
              }}
              nodeTypes={NODE_TYPES}
              onNodeClick={(_, node) => {
                if (node.type === "result") {
                  const id = node.id.replace(/^result-/, "");
                  setFocusedId((curr) => (curr === id ? null : id));
                } else if (node.type === "hub") {
                  setFocusedId(null);
                }
              }}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.4}
              maxZoom={1.5}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color={resolved === "light" ? "#dcdad5" : "#1a1a1a"} gap={16} />
              <FlowControls />
            </ReactFlow>
          ) : (
            <EmptyHardState
              hasDataset={!!dataset}
              hasModels={enabled.length > 0}
              onGoTools={() => navigate("/dashboards/scelo/tools")}
              onGoSoft={() => navigate("/dashboards/scelo/soft")}
            />
          )}
        </main>
        <ResizablePanel
          side="right"
          defaultWidth={288}
          badge="hard · result"
          accentClass="text-accent-3"
        >
          <ResultDetailsPanel
            focused={focused}
            narrative={narrative}
            narrativeStatus={narrativeStatus}
            dataset={dataset}
            doneRuns={doneRuns}
          />
        </ResizablePanel>
        {/* far right: persistent Scelo chat panel */}
        <StageChatPanel
          stageContext={chatStageContext}
          placeholder={chatPlaceholder}
          chatId="hard-stage"
          title={chatPlaceholder}
          badge="hard · chat"
          dataset={dataset}
        />
      </div>

      {reportOpen && dataset && (
        <ReportPreviewModal
          dataset={dataset}
          domain={domain}
          runsList={runsList}
          narrative={narrative}
          onClose={() => setReportOpen(false)}
        />
      )}
      {expandedRunId &&
        (() => {
          const run = runsList.find((r) => r.modelId === expandedRunId);
          if (!run) return null;
          return (
            <ModelDetailModal
              run={run}
              color={palette[run.family]}
              onClose={() => setExpandedRunId(null)}
            />
          );
        })()}
    </div>
  );
}

// Preview-then-print PDF report. Renders a board-pack styled view of the
// dataset + completed model runs + AI narrative inside a modal. The actual
// PDF is produced by the browser's print → "Save as PDF" pipeline; the
// print stylesheet in theme.css hides everything except the `data-print-
// region` subtree, so the page chrome (modal frame, buttons, blur) doesn't
// land in the export.
//
// Early-days scope on purpose: title + project context + dataset summary +
// AI narrative + a flat table of model headlines and blurbs. Future work
// could embed the consensus / trajectory charts as SVG, paginate per
// section, add a cover page, etc. — the modal is the right place to grow it.
function ReportPreviewModal({
  dataset,
  domain,
  runsList,
  narrative,
  onClose,
}: {
  dataset: Dataset;
  domain: ModelFamily | null;
  runsList: RunResult[];
  narrative: string | null;
  onClose: () => void;
}) {
  const { project } = useScelo();
  const done = runsList.filter((r) => r.status === "done");
  const generatedAt = new Date().toLocaleString();

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/40 backdrop-blur-sm">
      <div className="flex h-[90vh] w-[88vw] max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl">
        <header
          data-print-skip
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-4 py-2.5"
        >
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-wider text-accent-3">
              report · preview
            </div>
            <h2 className="truncate text-sm text-fg">Review before printing</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-fg-dim"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded border border-primary/60 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20"
            >
              download pdf
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-bg-2/30 p-6">
          {/* The printable region. data-print-region is what theme.css's
              @media print rule keeps visible; everything else is hidden. */}
          <div
            data-print-region
            className="mx-auto max-w-3xl overflow-hidden rounded border border-border bg-bg p-8 shadow-lg"
            style={{ minHeight: "calc(100% - 1px)" }}
          >
            {/* Brand strip — charcoal banner, taller, fonts inverted to
                light. Inline styles deliberately bypass the light-themed
                CSS variables on `[data-print-region]` so the banner reads
                as a deep brand block on the otherwise-white page (and the
                print stylesheet's `print-color-adjust: exact` keeps the
                fill intact in the PDF). */}
            <div
              data-print-card
              className="-mx-8 -mt-8 mb-6 flex items-center gap-4 px-8 py-5"
              style={{ background: "#1f1f1f", color: "#fafafa" }}
            >
              {/* New S0.1 wordmark on a white chip. SceloLogo paints with
                  currentColor, so the chip sets a dark `color` to keep the
                  mark legible (the banner text around it is light). */}
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded"
                style={{ background: "#ffffff", color: "#1f1f1f" }}
              >
                <SceloLogo className="h-9 w-9" />
              </div>
              <div className="leading-tight">
                <div
                  className="font-mono text-[15px] font-semibold tracking-wide"
                  style={{ color: "#fafafa" }}
                >
                  intelligent actuaries
                </div>
                <div
                  className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
                  style={{ color: "#9a9a96" }}
                >
                  scelo · board pack
                </div>
              </div>
            </div>

            <div
              data-print-muted
              className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
            >
              {project ? `${project.name} · ` : ""}generated {generatedAt}
            </div>
            <h1 className="mb-1 text-2xl font-semibold text-fg">Board pack</h1>
            <div className="mb-6 font-mono text-xs text-fg-mute">
              dataset: <span className="text-fg">{dataset.name}</span>
              <span className="mx-1.5 text-fg-dim">·</span>
              {dataset.rows.length.toLocaleString()} rows · {dataset.columns.length} columns
              {domain && (
                <>
                  <span className="mx-1.5 text-fg-dim">·</span>
                  domain: <span className="text-fg">{domain}</span>
                </>
              )}
            </div>

            <section data-print-card className="mb-6 rounded border border-border p-4">
              <h2
                data-print-muted
                className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
              >
                executive summary
              </h2>
              {narrative ? (
                // Render the narrative as markdown so inline code (`moderate`),
                // emphasis, and any lists/tables format properly instead of
                // showing literal backticks and run-on text.
                <SceloChatMarkdown dataset={null}>{narrative}</SceloChatMarkdown>
              ) : (
                <p data-print-muted className="text-sm italic text-fg-dim">
                  No narrative generated yet — run the model picker on Hard Data first.
                </p>
              )}
            </section>

            {/* Charts. Forced light palette (the data-print-region scope
                gives us light CSS variables, but the chart options take
                explicit colour args — so we pass the light hex values
                directly). renderer="svg" so the printed output stays
                vector-crisp rather than rasterising the canvas. */}
            {done.length > 0 && (
              <section data-print-card className="mb-6 rounded border border-border p-4">
                <h2
                  data-print-muted
                  className="mb-3 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
                >
                  estimates · {estimatesMode(done) === "forest" ? "forest" : "metrics"}
                </h2>
                <ForestPlot
                  doneRuns={done}
                  familyPalette={FAMILY_COLOR_LIGHT}
                  primary="#009669"
                  textDim="#8a8a86"
                  textMute="#5a5a56"
                  grid="#e6e4df"
                  renderer="svg"
                  heightOverride={220}
                />
              </section>
            )}

            {done.some((r) => r.series && r.series.x.length > 0) && (
              <section data-print-card className="mb-6 rounded border border-border p-4">
                <h2
                  data-print-muted
                  className="mb-3 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
                >
                  trajectory
                </h2>
                <TrajectoryOverlay
                  doneRuns={done}
                  familyPalette={FAMILY_COLOR_LIGHT}
                  textDim="#8a8a86"
                  textMute="#5a5a56"
                  grid="#e6e4df"
                  renderer="svg"
                  heightOverride={200}
                />
              </section>
            )}

            <section className="mb-6">
              <h2
                data-print-muted
                className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
              >
                model runs ({done.length})
              </h2>
              {done.length === 0 ? (
                <p data-print-muted className="text-sm italic text-fg-dim">
                  No completed runs to report.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {done.map((r) => {
                    const meta = MODEL_BY_ID.get(r.modelId);
                    return (
                      <li
                        key={r.modelId}
                        data-print-card
                        className="rounded border border-border p-3"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <div>
                            <div
                              data-print-muted
                              className="font-mono text-[10px] uppercase tracking-wider text-fg-dim"
                            >
                              {r.family}
                            </div>
                            <div className="text-sm text-fg">{meta?.name ?? r.modelId}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-lg text-fg">
                              {formatNumber(r.headline.value)}
                            </div>
                            <div
                              data-print-muted
                              className="font-mono text-[10px] uppercase tracking-wider text-fg-dim"
                            >
                              {r.headline.label}
                            </div>
                          </div>
                        </div>
                        {r.secondary.length > 0 && (
                          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                            {r.secondary.map((s) => (
                              <div key={s.label} className="flex items-baseline gap-1">
                                <dt data-print-muted className="text-fg-dim">
                                  {s.label}
                                </dt>
                                <dd className="text-fg">{s.value}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                        {r.blurb && (
                          <div className="mt-2 text-fg-mute">
                            <SceloChatMarkdown dataset={null} size="xs">
                              {r.blurb}
                            </SceloChatMarkdown>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <footer
              data-print-muted
              className="mt-8 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-wider text-fg-dim"
            >
              generated by scelo · intelligent actuaries
            </footer>
          </div>
        </div>

        <footer
          data-print-skip
          className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-1 px-4 py-2"
        >
          <span className="font-mono text-[10px] text-fg-dim">
            esc to close · download saves via your browser's print dialog (choose "Save as PDF")
          </span>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded border border-primary/60 bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20"
          >
            download pdf
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── per-model detail dashboard ─────────────────────────────────────────
//
// Opens from the small expand icon on each result node. Two-column layout:
//
//   ┌─────────────────────────────────┬─────────────────────────┐
//   │ header (model name · family ·   │     chat (scoped to     │
//   │   headline value + label)       │     this model only,    │
//   ├─────────────────────────────────┤     memory-keyed by     │
//   │ theory + assumptions            │     project)            │
//   │ run output (headline + secondary│                         │
//   │ diagnostics (model-specific)    │                         │
//   │ hypothesis tests (scaffold)     │                         │
//   └─────────────────────────────────┴─────────────────────────┘
//
// Scope today: scaffold + theory + run output + a "diagnostics" section
// that knows how to render a few model families' detail blobs. New
// diagnostic blocks per model are pure additions to `renderDiagnostics`.

function ModelDetailModal({
  run,
  color,
  onClose,
}: {
  run: RunResult;
  color: string;
  onClose: () => void;
}) {
  const model = MODEL_BY_ID.get(run.modelId);
  const theory = modelTheoryFor(run.modelId);
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/40 backdrop-blur-sm">
      <div className="flex h-[90vh] w-[92vw] max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl">
        {/* header */}
        <header
          className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-4 py-2.5"
          style={{ borderBottomColor: color }}
        >
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
              {run.family} · detail dashboard
            </div>
            <h2 className="truncate text-sm text-fg">{model?.name ?? run.modelId}</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-lg text-fg">{formatHeadline(run.headline)}</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                {run.headline.label}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="flex shrink-0 items-center gap-1.5 rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-mute hover:border-error hover:text-error"
            >
              close
              <span className="rounded border border-border bg-bg px-1 text-[9px] text-fg-dim">
                esc
              </span>
            </button>
          </div>
        </header>

        {/* body — two columns: content (left, scrollable) + chat (right) */}
        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {/* theory */}
            <section className="mb-5">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                theory · assumptions · formulae
              </h3>
              {theory ? (
                <SceloChatMarkdown dataset={null}>{theory}</SceloChatMarkdown>
              ) : (
                <p className="text-[11px] italic text-fg-dim">
                  No theory blurb for `{run.modelId}` yet — it'll grow as we add models.
                </p>
              )}
            </section>

            {/* climate data lineage — only for CLIMADA + parametric-climate runs */}
            {isClimateFamilyModel(run.modelId) && (
              <section className="mb-5">
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                  climate data lineage · reanalysis ensemble
                </h3>
                <ClimateDataPanel modelId={run.modelId} />
              </section>
            )}

            {/* run output */}
            <section className="mb-5">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                run output
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <DetailStat
                  label={run.headline.label}
                  value={formatHeadline(run.headline)}
                  accent={color}
                />
                {run.secondary.map((s) => (
                  <DetailStat key={s.label} label={s.label} value={s.value} />
                ))}
              </div>
              {run.blurb && (
                <p className="mt-3 text-[12px] leading-relaxed text-fg-mute">{run.blurb}</p>
              )}
            </section>

            {/* diagnostics — model-specific where we know how to render */}
            <section className="mb-5">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                diagnostics
              </h3>
              <ModelDiagnostics run={run} color={color} />
            </section>

            {/* hypothesis tests — scaffold for now */}
            <section className="mb-5">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
                hypothesis tests
              </h3>
              <HypothesisTestsScaffold run={run} />
            </section>

            {/* error fallback */}
            {run.status === "error" && run.error && (
              <section className="rounded border border-error/50 bg-error/10 px-3 py-2 font-mono text-[11px] text-error">
                run error · {run.error}
              </section>
            )}
          </main>

          {/* chat — scoped to this model, memory-keyed if a project is on */}
          <aside className="flex w-[36%] min-w-0 shrink-0 flex-col border-l border-border bg-bg">
            <ModelDetailChat modelId={run.modelId} modelName={model?.name ?? run.modelId} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function DetailStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      className="relative overflow-hidden rounded border border-border bg-bg px-2 py-1.5 pl-2.5"
      style={accent ? { borderColor: accent } : undefined}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: accent ?? "rgb(var(--rgb-border))" }}
      />
      <div
        className="font-mono text-[9px] uppercase tracking-wider"
        style={{ color: accent ?? "rgb(var(--rgb-fg-dim))" }}
      >
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm text-fg">{value}</div>
    </div>
  );
}

// Per-model diagnostics. Looks at the run's `detail` blob for known shapes
// and renders the appropriate plot/table. Models whose detail we don't yet
// know how to chart fall through to a generic "raw detail" expandable.
function ModelDiagnostics({ run, color }: { run: RunResult; color: string }) {
  const d = run.detail as Record<string, unknown> | undefined;
  if (!d) {
    return (
      <p className="text-[11px] italic text-fg-dim">
        No diagnostic blob produced — runner returned status `{run.status}`.
      </p>
    );
  }

  // Chain-ladder / Mack / Bootstrap all carry ATA factors → render as a
  // small bar chart of `factor` per development period.
  if (Array.isArray(d.factors) && (d.factors as unknown[]).every((v) => typeof v === "number")) {
    const factors = d.factors as number[];
    const cdf = Array.isArray(d.cdf) ? (d.cdf as number[]) : null;
    return (
      <div className="space-y-3">
        <SmallBarPanel
          title="ATA factors by development period"
          xs={factors.map((_, i) => `${i}→${i + 1}`)}
          ys={factors}
          color={color}
          ySuffix=""
        />
        {cdf && (
          <SmallBarPanel
            title="cumulative development factor (CDF)"
            xs={cdf.map((_, i) => `from ${i}`)}
            ys={cdf}
            color={color}
            ySuffix=""
          />
        )}
        {Array.isArray(d.sigmas) && (
          <SmallBarPanel
            title="Mack σₖ — residual variance per development"
            xs={(d.sigmas as number[]).map((_, i) => `${i}→${i + 1}`)}
            ys={d.sigmas as number[]}
            color={color}
          />
        )}
      </div>
    );
  }

  // Bootstrap surfaces p5/p95 around the central estimate — a tiny
  // bullet-style range bar speaks the point + range in one row.
  if (typeof d.p5 === "number" && typeof d.p95 === "number" && typeof d.ibnr === "number") {
    return <BootstrapRange p5={d.p5} p95={d.p95} centre={d.ibnr} color={color} />;
  }

  // Generic fallback — show the keys as a definition list. Null/empty entries
  // are dropped (they read as "unfinished" rather than informative), and
  // objects/arrays are summarised in words instead of raw `{ … }` / `[N items]`.
  const entries = Object.entries(d).filter(([, v]) => !isEmptyDetail(v));
  if (entries.length === 0) {
    return (
      <p className="text-[11px] italic text-fg-dim">
        No further structured diagnostics for this model.
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
      {entries.slice(0, 12).map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-1">
          <dt className="shrink-0 text-fg-dim">{k}</dt>
          <dd className="truncate text-fg" title={detailTitle(v)}>
            {formatDetailValue(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// Treat null / undefined / empty string / empty array / empty object as "no
// value" so the diagnostics list doesn't show bare `null` or `{ … }` rows.
function isEmptyDetail(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function formatDetailValue(v: unknown): string {
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) {
    const n = v.length;
    return `${n} value${n === 1 ? "" : "s"}`;
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    // Small flat objects of primitives read better expanded inline.
    const flat = keys.every((k) => {
      const t = typeof (v as Record<string, unknown>)[k];
      return t === "number" || t === "string" || t === "boolean";
    });
    if (flat && keys.length <= 4) {
      return keys
        .map((k) => {
          const inner = (v as Record<string, unknown>)[k];
          return `${k} ${typeof inner === "number" ? formatNumber(inner) : String(inner)}`;
        })
        .join(" · ");
    }
    return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
  }
  return String(v);
}

// Full value as a hover tooltip so summarised objects/arrays stay inspectable.
function detailTitle(v: unknown): string | undefined {
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function SmallBarPanel({
  title,
  xs,
  ys,
  color,
  ySuffix = "",
}: {
  title: string;
  xs: string[];
  ys: number[];
  color: string;
  ySuffix?: string;
}) {
  // ECharts on canvas can't resolve `rgb(var(--…))` strings — canvas
  // 2D context just sets fillStyle and CSS variables silently fall back
  // to a default (black). Compute real hex values from the active theme
  // and pass those in.
  const { resolved } = useTheme();
  const axisColor = resolved === "light" ? "#8a8a86" : "#9a9a96";
  const gridColor = resolved === "light" ? "#e6e4df" : "#2a2a2a";
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 36, right: 12, top: 8, bottom: 22 },
      tooltip: {
        trigger: "axis",
        appendToBody: true,
        backgroundColor: resolved === "light" ? "#ffffff" : "#141414",
        borderColor: gridColor,
        textStyle: { color: resolved === "light" ? "#181818" : "#e8e8e8", fontSize: 10 },
        extraCssText: "z-index: 9999; font-family: 'SN Pro', 'Inter', sans-serif;",
      },
      xAxis: {
        type: "category",
        data: xs,
        axisLabel: { color: axisColor, fontSize: 9, hideOverlap: true },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: gridColor } },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: axisColor,
          fontSize: 9,
          formatter: (v: number) => `${formatNumber(v)}${ySuffix}`,
        },
        splitLine: { lineStyle: { color: gridColor, type: "dashed", opacity: 0.4 } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          data: ys,
          itemStyle: { color, borderRadius: [2, 2, 0, 0] },
          barWidth: "72%",
        },
      ],
    }),
    [xs, ys, color, ySuffix, axisColor, gridColor, resolved],
  );
  return (
    <div className="rounded border border-border bg-bg p-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-dim">{title}</div>
      <ReactECharts
        echarts={echarts}
        option={option}
        notMerge
        lazyUpdate
        style={{ height: 140, width: "100%" }}
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}

function BootstrapRange({
  p5,
  p95,
  centre,
  color,
}: {
  p5: number;
  p95: number;
  centre: number;
  color: string;
}) {
  const lo = Math.min(p5, centre);
  const hi = Math.max(p95, centre);
  const pad = (hi - lo) * 0.08 || Math.max(Math.abs(centre) * 0.05, 1);
  const minX = lo - pad;
  const maxX = hi + pad;
  const norm = (v: number) => (((v - minX) / (maxX - minX)) * 100).toFixed(2);
  return (
    <div className="rounded border border-border bg-bg p-3">
      <div className="mb-2 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        <span>predictive distribution · p5 → p95</span>
        <span>median {formatNumber(centre)}</span>
      </div>
      <svg width="100%" height={32} className="block" aria-hidden="true">
        <title>Bootstrap predictive distribution range</title>
        <line
          x1={`${norm(p5)}%`}
          y1="16"
          x2={`${norm(p95)}%`}
          y2="16"
          stroke={color}
          strokeWidth="2"
          opacity="0.45"
        />
        <line
          x1={`${norm(p5)}%`}
          y1="6"
          x2={`${norm(p5)}%`}
          y2="26"
          stroke={color}
          strokeWidth="1.4"
        />
        <line
          x1={`${norm(p95)}%`}
          y1="6"
          x2={`${norm(p95)}%`}
          y2="26"
          stroke={color}
          strokeWidth="1.4"
        />
        <circle cx={`${norm(centre)}%`} cy="16" r="4" fill={color} />
      </svg>
      <div className="mt-1 grid grid-cols-3 font-mono text-[10px] text-fg-mute">
        <span>p5 {formatNumber(p5)}</span>
        <span className="text-center text-fg">median {formatNumber(centre)}</span>
        <span className="text-right">p95 {formatNumber(p95)}</span>
      </div>
    </div>
  );
}

// Placeholder hypothesis-test panel. Today it surfaces a small fixed set
// of "what would we test for THIS model?" rows with a result column that
// reads `tbd` — the panel is here so the dashboard's structure is right
// when we wire actual tests in (Mack residual independence, GLM Wald,
// Lee-Carter forecasting residuals, etc.).
function HypothesisTestsScaffold({ run }: { run: RunResult }) {
  const tests = hypothesisTestsForModel(run.modelId);
  if (tests.length === 0) {
    return (
      <p className="text-[11px] italic text-fg-dim">
        No standard hypothesis tests defined for this model yet.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {tests.map((t) => (
        <li
          key={t.name}
          className="flex items-center justify-between gap-3 rounded border border-border bg-bg px-2.5 py-1.5"
        >
          <div className="min-w-0">
            <div className="font-mono text-[11px] text-fg">{t.name}</div>
            <div className="font-mono text-[10px] text-fg-dim">{t.description}</div>
          </div>
          <span className="shrink-0 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warn">
            tbd
          </span>
        </li>
      ))}
    </ul>
  );
}

type TestSpec = { name: string; description: string };
function hypothesisTestsForModel(modelId: string): TestSpec[] {
  switch (modelId) {
    case "chain-ladder":
    case "mack":
      return [
        {
          name: "Mack · independence of development factors",
          description: "tests whether successive ATA factors are correlated",
        },
        {
          name: "Mack · calendar-year effects",
          description: "checks for diagonal (CY) shocks the model assumes away",
        },
        {
          name: "Pearson residual normality",
          description: "QQ-plot proxy — flags pattern in scaled residuals",
        },
      ];
    case "bornhuetter-ferguson":
      return [
        {
          name: "ELR sensitivity",
          description: "±10 % ELR → reserve change; flag if >5 % swing",
        },
        {
          name: "early-origin stability",
          description: "are recent origins drawing >50 % of the reserve?",
        },
      ];
    case "bootstrap-ibnr":
      return [
        {
          name: "convergence",
          description: "is the median stable across the last 1000 iterations?",
        },
        {
          name: "tail symmetry",
          description: "p95-median vs median-p5 — flag if skew >2×",
        },
      ];
    case "lee-carter":
    case "cbd":
      return [
        {
          name: "stationarity of κ residuals",
          description: "ADF on the κ time series residuals after random-walk fit",
        },
        {
          name: "back-test holdout RMSE",
          description: "out-of-sample fit on the latest 5 years",
        },
      ];
    case "glm-frequency":
    case "glm-severity":
      return [
        {
          name: "deviance significance (Wald)",
          description: "per-coefficient p-values",
        },
        {
          name: "Pearson dispersion",
          description: "≈1 for Poisson, deviation flags overdispersion",
        },
        {
          name: "out-of-sample Gini",
          description: "lift on a holdout sample",
        },
      ];
    case "gbm":
      return [
        {
          name: "out-of-time fold AUC / Gini",
          description: "robustness against period drift",
        },
        {
          name: "SHAP stability",
          description: "do top features stay the same on retrain?",
        },
      ];
    default:
      return [];
  }
}

function ModelDetailChat({ modelId, modelName }: { modelId: string; modelName: string }) {
  const { chatMemoryPrefix } = useScelo();
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:hard-detail:${modelId}` : undefined;
  const stageContext = `You are Scelo at the Hard Data stage, focused specifically on the \`${modelId}\` (${modelName}) result. Help the user interpret the diagnostics, theory, and hypothesis-test results shown alongside this conversation. Suggest enhancements when relevant. Stay focused on this model — don't pre-empt other models in the run.`;
  const { messages, isStreaming, send, stop } = useNodeChat(stageContext, { memoryKey });
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every messages change.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const t = draft.trim();
    if (!t || isStreaming) return;
    setDraft("");
    void send(t);
  };

  return (
    <>
      <div className="border-b border-border bg-bg-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-dim">
        ask scelo · about this model
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-fg-dim">
            Ask about assumptions, hypothesis-test results, sensitivity, or how this run compares to
            its peers.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((m, idx) => {
              const isUser = m.role === "user";
              const isLast = idx === messages.length - 1;
              const streamingThis = !isUser && isLast && isStreaming;
              return (
                <li key={m.id} className="flex flex-col gap-1">
                  <span
                    className={`font-mono text-[9px] uppercase tracking-wider ${
                      isUser ? "text-fg-dim" : "text-accent-2"
                    }`}
                  >
                    {isUser ? "you" : "scelo"}
                  </span>
                  {isUser ? (
                    <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg">
                      {m.content}
                    </div>
                  ) : m.content ? (
                    <SceloChatMarkdown streaming={streamingThis} dataset={null}>
                      {m.content}
                    </SceloChatMarkdown>
                  ) : streamingThis ? (
                    <span className="text-fg-dim">…</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-bg-1 px-3 py-2">
        <ChatInputPill
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          isStreaming={isStreaming}
          placeholder={`ask about ${modelName}…`}
          rows={2}
          size="sm"
        />
      </div>
    </>
  );
}

function EmptyHardState({
  hasDataset,
  hasModels,
  onGoTools,
  onGoSoft,
}: {
  hasDataset: boolean;
  hasModels: boolean;
  onGoTools: () => void;
  onGoSoft: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div className="max-w-md">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-accent-3">
          hard data · empty
        </div>
        {!hasDataset && (
          <>
            <p className="mb-3 text-sm text-fg-mute">
              No dataset loaded yet — go to <span className="font-mono text-fg">Soft Data</span>{" "}
              first.
            </p>
            <button
              type="button"
              onClick={onGoSoft}
              className="rounded border border-border bg-bg-2 px-3 py-1.5 font-mono text-xs text-fg-mute hover:border-primary hover:text-primary"
            >
              go to Soft Data
            </button>
          </>
        )}
        {hasDataset && !hasModels && (
          <>
            <p className="mb-3 text-sm text-fg-mute">
              No models attached. Drop into <span className="font-mono text-fg">Tools</span> and
              pick a few — they'll execute and their results will appear here.
            </p>
            <button
              type="button"
              onClick={onGoTools}
              className="rounded border border-border bg-bg-2 px-3 py-1.5 font-mono text-xs text-fg-mute hover:border-primary hover:text-primary"
            >
              go to Tools
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Re-export so callers don't need to dig into SelectedModel.
export type { SelectedModel };
