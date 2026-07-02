// Custom React Flow node for Scelo's three macro stages: soft data → tools →
// hard data. Minimal by default — one stage label, a name, a one-liner, a
// live status hint, and a single-line action bar where the user can ask
// stage-scoped questions ("restore a project", "swap chain-ladder for Mack",
// "explain this ultimate"). The message thread is collapsed until messages
// exist so the resting state stays calm.

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Handle, type NodeProps, Position } from "reactflow";
import { ChatInputPill } from "./ChatInputPill";
import { SceloChatMarkdown } from "./SceloChatMarkdown";
import { getColumnMetas } from "./columnMetaCache";
import { FAMILY_COLOR_DARK, MODEL_BY_ID } from "./modelCatalog";
import { type RunResult } from "./modelRunner";
import { useScelo } from "./sceloContext";
import { useNodeChat } from "./useNodeChat";

export type SceloStage = "soft" | "tools" | "hard";

export type SceloNodeData = {
  stage: SceloStage;
  title: string;
  subtitle: string;
};

// Per-stage chat config. Placeholder seeds the input with examples of what
// to ask; stageContext frames the AI as an action assistant for THAT stage
// only, so the chat stays useful at the macro view (no model jumping ahead
// from Soft, no re-collecting data from Hard).
const STAGE_CHAT: Record<SceloStage, { placeholder: string; stageContext: string }> = {
  soft: {
    placeholder: "restore a project, fetch from a database…",
    stageContext: [
      "CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a pure chat reply.",
      "",
      "You are Scelo at the SOFT DATA stage of the pipeline — the data-intake desk.",
      "Help the user source, restore, or connect a dataset: open a saved project, restore an exported snapshot, sketch a read-only database connection, suggest schema mappings for a CSV/Parquet, or describe their raw data so we can decide whether to clean it.",
      "Keep replies short and actionable. Stay focused on intake — do not jump ahead to model choice or final results.",
    ].join("\n"),
  },
  tools: {
    placeholder: "swap chain-ladder for Mack, compare models…",
    stageContext: [
      "CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a pure chat reply.",
      "",
      "You are Scelo at the TOOLS stage of the pipeline — the model bench.",
      "Help the user compare, refine, or substitute model picks: explain a model's assumptions and trade-offs, suggest a sibling (e.g. Mack when uncertainty matters), flag mismatches against the dataset's shape, or sketch how to combine results.",
      "Keep replies short and actionable. Do not re-collect data; do not pre-empt the final readout.",
    ].join("\n"),
  },
  hard: {
    placeholder: "explain this ultimate, compare runs…",
    stageContext: [
      "CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a pure chat reply.",
      "",
      "You are Scelo at the HARD DATA stage of the pipeline — the readout desk.",
      "Help the user read and communicate the outputs: interpret ultimates / IBNR / intervals, compare two runs, sketch the board-pack narrative, or flag results that look unusual.",
      "Keep replies short and actionable. Do not re-open data collection or model selection unless the user explicitly asks.",
    ].join("\n"),
  },
};

// Stage summary — small structured object that drives the in-node status
// block on the macro view. When the corresponding stage hasn't produced
// anything yet, returns `{ primary: "—" }` and the card keeps its calm
// resting state. Otherwise, supplies a primary stat, ~2 short secondary
// stats, an optional detail line, and (for visual cues without overloading
// the node) a tiny sparkline-ish bar.

type SummaryBar = {
  // Stacked horizontal bar — each segment {label, value, color}.
  segments: { label: string; value: number; color: string }[];
};

type StageSummary = {
  primary: string;
  secondary?: string[];
  detail?: string;
  bar?: SummaryBar;
};

function useStageSummary(stage: SceloStage): StageSummary {
  const { dataset, selectedModels, runs, domain } = useScelo();

  // SOFT — rows · cols · missing% · column-type bar.
  if (stage === "soft") {
    return useMemo<StageSummary>(() => {
      if (!dataset) return { primary: "—" };
      // Shared WeakMap-cached profiling — one summariseDataset pass per
      // dataset object across every mounted pane, not one per node card.
      const metas = getColumnMetas(dataset);
      const totalCells = Math.max(1, dataset.rows.length * dataset.columns.length);
      const missing = metas.reduce((s, m) => s + m.missing, 0);
      const missingPct = (missing / totalCells) * 100;
      const num = metas.filter((m) => m.type === "number").length;
      const date = metas.filter((m) => m.type === "date").length;
      const str = metas.filter((m) => m.type === "string").length;
      return {
        primary: `${dataset.rows.length.toLocaleString()} rows`,
        secondary: [
          `${dataset.columns.length} cols`,
          `${missingPct < 0.05 ? "0%" : `${missingPct.toFixed(1)}%`} missing`,
        ],
        detail: dataset.name,
        bar: {
          segments: [
            { label: "numeric", value: num, color: "rgb(var(--rgb-accent-2))" },
            { label: "date", value: date, color: "rgb(var(--rgb-warn))" },
            { label: "string", value: str, color: "rgb(var(--rgb-fg-dim))" },
          ].filter((s) => s.value > 0),
        },
      };
    }, [dataset]);
  }

  // TOOLS — models picked · domain · family dots.
  if (stage === "tools") {
    return useMemo<StageSummary>(() => {
      const live = selectedModels.filter((m) => m.enabled);
      if (live.length === 0) return { primary: "—" };
      // Two truncated names as the detail; family dots in the bar.
      const names = live.map((m) => MODEL_BY_ID.get(m.id)?.name ?? m.id).slice(0, 2);
      const moreCount = live.length - names.length;
      const detail = moreCount > 0 ? `${names.join(", ")} · +${moreCount}` : names.join(", ");
      // Use the actual catalog family for each picked model so the dot
      // row always reflects what's on the canvas — not just the dominant
      // domain (which can lag when the user is mid-swap).
      const segments = live.map((m) => {
        const family = MODEL_BY_ID.get(m.id)?.family ?? "general";
        return {
          label: family,
          value: 1,
          color: FAMILY_COLOR_DARK[family],
        };
      });
      return {
        primary: `${live.length} model${live.length === 1 ? "" : "s"}`,
        secondary: domain ? [`domain · ${domain}`] : undefined,
        detail,
        bar: { segments },
      };
    }, [selectedModels, domain]);
  }

  // HARD — runs · complete / error · headline of dominant run.
  return useMemo<StageSummary>(() => {
    const all = Object.values(runs) as RunResult[];
    if (all.length === 0) return { primary: "—" };
    const done = all.filter((r) => r.status === "done");
    const errored = all.filter((r) => r.status === "error");
    // Dominant run = highest absolute headline value among completed runs.
    // Reads as the "anchor number" the user came here to see.
    const dominant = done
      .slice()
      .sort((a, b) => Math.abs(b.headline.value) - Math.abs(a.headline.value))[0];
    const secondary: string[] = [];
    if (done.length > 0) secondary.push(`${done.length} complete`);
    if (errored.length > 0)
      secondary.push(`${errored.length} error${errored.length === 1 ? "" : "s"}`);
    return {
      primary: `${all.length} run${all.length === 1 ? "" : "s"}`,
      secondary,
      detail: dominant
        ? `${dominant.headline.label} · ${formatCompact(dominant.headline.value)}`
        : undefined,
      bar:
        done.length > 0
          ? {
              segments: [
                {
                  label: "complete",
                  value: done.length,
                  color: "rgb(var(--rgb-primary))",
                },
                {
                  label: "error",
                  value: errored.length,
                  color: "rgb(var(--rgb-error))",
                },
              ].filter((s) => s.value > 0),
            }
          : undefined,
    };
  }, [runs]);
}

// SI-prefixed value formatter for the in-node detail line. Avoids overflow
// when a headline is "1,532,963" inside a 280-px card; "1.5M" sits much
// better visually.
function formatCompact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  return `${sign}${abs.toPrecision(2)}`;
}

// Tiny stacked horizontal bar, ~6px tall. SVG-free so it composes cleanly
// with the rest of the card chrome. Used for column-type breakdown,
// family-mix, and run-status breakdown.
function MiniStackedBar({ bar }: { bar: SummaryBar }) {
  const total = bar.segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-bg/40">
      {bar.segments.map((s) => (
        <span
          key={`${s.label}-${s.color}`}
          className="h-full"
          style={{
            width: `${(s.value / total) * 100}%`,
            background: s.color,
          }}
          title={`${s.label}: ${s.value}`}
        />
      ))}
    </div>
  );
}

// Compact, in-node chat. Single-line input by default; the message thread
// appears above the input only after the first reply. All the React-Flow-
// hostile interactions (text selection, scrolling, dragging the textarea)
// are guarded with `nodrag` / `nowheel`.
function NodeChat({ stage }: { stage: SceloStage }) {
  const { chatMemoryPrefix } = useScelo();
  const { placeholder, stageContext } = STAGE_CHAT[stage];
  const memoryKey = chatMemoryPrefix ? `${chatMemoryPrefix}:macro-${stage}` : undefined;
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

  return (
    <div
      className="mt-5 flex flex-col gap-2 border-t border-border/70 pt-4"
      // Stop card-level click handler from drilling into the workstation
      // when the user is interacting with the chat area.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="nodrag nowheel scrollbar-none max-h-28 overflow-auto rounded-xl bg-bg/60 p-3 text-[10px] leading-snug"
        >
          {messages.map((m, idx) => {
            const isUser = m.role === "user";
            const isLast = idx === messages.length - 1;
            const streamingThis = !isUser && isLast && isStreaming;
            return (
              <div key={m.id} className="mb-2 last:mb-0">
                <div className="font-mono text-[8px] uppercase tracking-[0.15em] text-fg-dim">
                  {isUser ? "you" : "scelo"}
                </div>
                {isUser ? (
                  <div className="whitespace-pre-wrap text-fg">{m.content}</div>
                ) : m.content ? (
                  <SceloChatMarkdown streaming={streamingThis} dataset={null} size="xs">
                    {m.content}
                  </SceloChatMarkdown>
                ) : streamingThis ? (
                  <span className="text-fg-dim">…</span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <ChatInputPill
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submit}
        onStop={stop}
        isStreaming={isStreaming}
        placeholder={placeholder}
        rows={2}
        size="xs"
      />
    </div>
  );
}

export function SceloNode({ data }: NodeProps<SceloNodeData>) {
  const navigate = useNavigate();
  const summary = useStageSummary(data.stage);

  // Per-stage accent — single thread of colour that ties the small dot, the
  // stage label, and (on focus) the border together. Same palette the
  // workstations use, so the colour-coding stays consistent across views.
  const accent =
    data.stage === "soft"
      ? "text-accent-2"
      : data.stage === "tools"
        ? "text-primary"
        : "text-accent-3";

  const drillIn = () => navigate(`/dashboards/scelo/${data.stage}`);
  const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      drillIn();
    }
  };

  return (
    <div className="glass-card group w-[280px] rounded-2xl p-6">
      {/* Tools is the only node connected on both sides. Handles stay tiny
          and grey — present for the edge to attach to, never a focal point. */}
      {data.stage !== "soft" && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          style={{ background: "rgb(var(--rgb-border))", width: 6, height: 6 }}
        />
      )}
      {data.stage !== "hard" && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={false}
          style={{ background: "rgb(var(--rgb-border))", width: 6, height: 6 }}
        />
      )}

      {/* Clickable header zone — drilling into the workstation. The chat
          below stops propagation so it never triggers a drill.
          biome-ignore lint/a11y/useSemanticElements: the click zone contains
          an <h3> (flow content) which a <button> can't legally wrap; the
          role + tabIndex + key/click handlers cover the a11y contract. */}
      <div
        role="button"
        tabIndex={0}
        onClick={drillIn}
        onKeyDown={onCardKey}
        title={`Open the ${data.title.toLowerCase()} workstation`}
        className="cursor-pointer focus:outline-none"
      >
        <div
          className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${accent}`}
        >
          <span aria-hidden className="inline-block h-1 w-1 rounded-full bg-current opacity-70" />
          <span>{data.stage}</span>
        </div>

        <h3 className="mt-5 text-lg font-medium leading-tight text-fg">{data.title}</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-fg-mute">{data.subtitle}</p>

        <div className="mt-6 flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-wider text-fg-dim">
            {summary.primary}
            {summary.secondary && summary.secondary.length > 0 && (
              <>
                {summary.secondary.map((s) => (
                  <span key={s} className="ml-2 text-fg-dim/80">
                    · {s}
                  </span>
                ))}
              </>
            )}
          </span>
          <span
            aria-hidden
            className="font-mono text-[11px] text-fg-dim transition group-hover:text-fg"
          >
            open →
          </span>
        </div>

        {summary.detail && (
          <div className="mt-1.5 truncate text-[11px] text-fg-mute" title={summary.detail}>
            {summary.detail}
          </div>
        )}
        {summary.bar && summary.bar.segments.length > 0 && <MiniStackedBar bar={summary.bar} />}
      </div>

      <NodeChat stage={data.stage} />
    </div>
  );
}
