// Composite assistant message — one per query. Renders the routing card,
// any retrieval badges, tool-call cards (paired with their results),
// markdown text, and (in checkpoint 7+) charts/tables/citations.
//
// This file deliberately stays the orchestration layer; rich content
// blocks (markdown, charts) live in their own files so each can evolve.

import { useEffect, useState } from "react";
import type { AssistantPart, ConversationMessage } from "@/lib/conversations";
import { ActionBar } from "./ActionBar";
import { ChartBlock } from "./ChartBlock";
import { CitationsBlock } from "./CitationsBlock";
import { DisclaimerBlock } from "./DisclaimerBlock";
import { MarkdownBlock } from "./MarkdownBlock";
import { OpenInDashboardButton } from "./OpenInDashboardButton";
import { RoutingCard } from "./RoutingCard";
import { StatusPip } from "./StatusPip";
import { TableBlock } from "./TableBlock";
import { ToolCallCard } from "./ToolCallCard";

type Props = {
  message: ConversationMessage;
  isStreaming: boolean;
  onRegenerate?: () => void;
  onBranch?: () => void;
};

// Pair tool_call parts with their later tool_result parts so we render one
// card per call. Returns the parts in display order with each tool_call
// augmented with its result, and any orphan tool_results passed through.
type DisplayItem =
  | { kind: "routing"; part: Extract<AssistantPart, { kind: "routing" }> }
  | { kind: "wiki_retrieval"; part: Extract<AssistantPart, { kind: "wiki_retrieval" }> }
  | {
      kind: "regulatory_retrieval";
      part: Extract<AssistantPart, { kind: "regulatory_retrieval" }>;
    }
  | {
      kind: "tool";
      tool: string;
      args?: Record<string, unknown>;
      output?: unknown;
      durationMs?: number;
      errored: boolean;
      chartSpecIds?: string[];
      specialist?: string;
      dashboardPath?: string;
    }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string };

// Detect a regulatory-tool output shape (see RegulatoryToolOutput in
// packages/ia-agents/ia_agents/tools/regulatory_tool.py).
type RegulatoryOutput = {
  summary?: string;
  directly_applicable?: string[];
  potentially_applicable?: string[];
  flags?: string[];
  gaps?: string[];
  disclaimer?: string;
};

function asRegulatoryOutput(output: unknown): RegulatoryOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.disclaimer !== "string") return null;
  if (!Array.isArray(o.directly_applicable) && !Array.isArray(o.potentially_applicable)) {
    return null;
  }
  return o as RegulatoryOutput;
}

// Detect a triangle-shaped reserving result so we can render the development
// triangle as a TableBlock. Mack output also has ibnr_by_origin which we
// render as a small two-column summary.
type ReservingOutput = {
  mack?: { ibnr_total?: number; ibnr_by_origin?: Record<string, number> };
};

// Derive a prefill payload from a tool's invocation args. We deliberately
// pass through only well-known keys per specialist so the dashboard can
// validate; everything else is dropped.
function derivePrefill(
  specialist: string,
  args?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const allow: Record<string, ReadonlyArray<string>> = {
    reserving: ["triangle", "method", "n_sims", "seed"],
    mortality: ["country", "sex", "model", "horizon", "ages"],
    pensions: ["scheme", "valuation_basis", "discount_rate"],
    pricing: ["dataset", "model_type", "target", "features"],
    climate: ["peril", "country", "scenario"],
    capital: ["module", "scenario", "horizon"],
    regulatory: ["domain", "jurisdiction", "topic"],
    documentation: ["report_kind", "specialist", "since"],
  };
  const keys = allow[specialist];
  if (!keys || keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in args) out[k] = args[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asReservingOutput(output: unknown): ReservingOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const mack = o.mack as Record<string, unknown> | undefined;
  if (!mack || typeof mack !== "object") return null;
  if (typeof mack.ibnr_total !== "number" && typeof mack.ibnr_by_origin !== "object") {
    return null;
  }
  return o as ReservingOutput;
}

function compose(parts: AssistantPart[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  // Index of the most recent tool item per tool name so we can attach
  // results back. We keep a stack since the same tool could be called
  // multiple times in one turn.
  const pendingByTool: Record<string, number[]> = {};

  for (const p of parts) {
    if (p.kind === "tool_call") {
      const idx = out.length;
      out.push({ kind: "tool", tool: p.tool, args: p.arguments, errored: false });
      pendingByTool[p.tool] = pendingByTool[p.tool] ?? [];
      pendingByTool[p.tool].push(idx);
      continue;
    }
    if (p.kind === "tool_result") {
      const stack = pendingByTool[p.tool];
      const idx = stack && stack.length > 0 ? stack.shift() : undefined;
      if (typeof idx === "number") {
        const existing = out[idx];
        if (existing.kind === "tool") {
          out[idx] = {
            ...existing,
            output: p.output,
            durationMs: p.duration_ms,
            chartSpecIds: p.chart_spec_ids,
            specialist: p.specialist,
            dashboardPath: p.dashboard_path,
          };
        }
      } else {
        // Orphan tool_result (no matching call) — surface as a stand-alone tool card.
        out.push({
          kind: "tool",
          tool: p.tool,
          output: p.output,
          durationMs: p.duration_ms,
          errored: false,
          chartSpecIds: p.chart_spec_ids,
          specialist: p.specialist,
          dashboardPath: p.dashboard_path,
        });
      }
      continue;
    }
    if (p.kind === "routing") {
      out.push({ kind: "routing", part: p });
      continue;
    }
    if (p.kind === "wiki_retrieval") {
      out.push({ kind: "wiki_retrieval", part: p });
      continue;
    }
    if (p.kind === "regulatory_retrieval") {
      out.push({ kind: "regulatory_retrieval", part: p });
      continue;
    }
    if (p.kind === "message") {
      out.push({ kind: "message", text: p.text });
      continue;
    }
    if (p.kind === "error") {
      out.push({ kind: "error", text: p.text });
    }
  }
  return out;
}

export function AssistantMessage({ message, isStreaming, onRegenerate, onBranch }: Props) {
  const items = compose(message.parts ?? []);
  const empty = items.length === 0;
  const usage = aggregateUsage(message.parts ?? []);
  // Estimate per-message USD from the active provider's selected model.
  // Lazy import keeps the price table out of the bundle when no usage
  // event ever fires (default Ollama path).
  const [usd, setUsd] = useState(0);
  useEffect(() => {
    if (!usage.any) return;
    let cancelled = false;
    Promise.all([
      import("../../lib/aiPricing"),
      import("../../lib/aiProviders"),
    ]).then(([pricingMod, providersMod]) => {
      const activeId = providersMod.getActiveProviderId();
      providersMod.getProviderConfig(activeId).then((cfg) => {
        if (cancelled) return;
        const cost = pricingMod.estimateUSD(
          usage.provider ?? activeId,
          cfg?.model,
          usage.input,
          usage.output,
        );
        setUsd(cost);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [usage.any, usage.provider, usage.input, usage.output]);

  return (
    <article className="flex gap-3">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-primary text-xs"
        aria-hidden
      >
        ia
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-fg-dim text-xs">
          <span className="text-primary">(Iα)</span>
          <span>ₐᵢ</span>
        </div>
        <div className="mt-2 space-y-3">
          {empty && isStreaming && <StatusPip mode="processing" />}
          {items.map((item, i) => {
            const key = `${i}-${item.kind}`;
            switch (item.kind) {
              case "routing":
                return (
                  <RoutingCard
                    key={key}
                    band={item.part.band}
                    tool={item.part.tool}
                    confidence={item.part.confidence}
                    isStreaming={isStreaming}
                  />
                );
              case "wiki_retrieval":
                return (
                  <div key={key} className="font-mono text-fg-dim text-[11px]">
                    wiki retrieval · {item.part.n} sources
                  </div>
                );
              case "regulatory_retrieval":
                return (
                  <div key={key} className="font-mono text-fg-dim text-[11px]">
                    regulatory retrieval · {item.part.n} sources
                  </div>
                );
              case "tool": {
                const reg = asRegulatoryOutput(item.output);
                const reserving = asReservingOutput(item.output);
                return (
                  <div key={key} className="space-y-3">
                    <ToolCallCard
                      tool={item.tool}
                      args={item.args}
                      output={item.output}
                      durationMs={item.durationMs}
                      errored={item.errored}
                    />
                    {item.chartSpecIds?.map((specId) => (
                      <ChartBlock key={specId} specId={specId} />
                    ))}
                    {reserving?.mack?.ibnr_by_origin && (
                      <TableBlock
                        caption={`mack · ibnr by origin${
                          typeof reserving.mack.ibnr_total === "number"
                            ? ` · total ${reserving.mack.ibnr_total.toLocaleString(undefined, {
                                maximumFractionDigits: 0,
                              })}`
                            : ""
                        }`}
                        columns={["origin", "IBNR"]}
                        columnTypes={["text", "number"]}
                        rows={Object.entries(reserving.mack.ibnr_by_origin).map(([k, v]) => [k, v])}
                        totalsRow={
                          typeof reserving.mack.ibnr_total === "number"
                            ? ["total", reserving.mack.ibnr_total]
                            : undefined
                        }
                      />
                    )}
                    {reg && (
                      <CitationsBlock
                        citations={[
                          ...(reg.directly_applicable ?? []).map((c) => ({
                            label: c,
                            applicability: "directly_applicable" as const,
                          })),
                          ...(reg.potentially_applicable ?? []).map((c) => ({
                            label: c,
                            applicability: "potentially_applicable" as const,
                          })),
                        ]}
                      />
                    )}
                    {reg?.disclaimer && <DisclaimerBlock text={reg.disclaimer} />}
                    {item.specialist && item.output !== undefined && (
                      <OpenInDashboardButton
                        specialist={item.specialist}
                        dashboardPath={item.dashboardPath}
                        prefill={derivePrefill(item.specialist, item.args)}
                      />
                    )}
                  </div>
                );
              }
              case "message":
                return (
                  <MarkdownBlock key={key} streaming={isStreaming && i === items.length - 1}>
                    {item.text}
                  </MarkdownBlock>
                );
              case "error":
                return (
                  <div
                    key={key}
                    className="border border-error bg-error/10 px-3 py-2 font-mono text-error text-xs"
                  >
                    error · {item.text}
                  </div>
                );
              default:
                return null;
            }
          })}
          {!isStreaming && !empty && <StatusPip mode="done" />}
          {usage.any && (
            <div className="flex items-center gap-2 font-mono text-[10px] text-fg-dim">
              <span
                className="rounded border border-border bg-bg-2 px-1.5 py-0.5"
                title={`${usage.input} input tokens · ${usage.output} output tokens${
                  usd > 0 ? ` · ~$${usd.toFixed(4)}` : ""
                }`}
              >
                {usage.provider ?? "llm"} · {formatTokens(usage.input)} in / {formatTokens(usage.output)} out
                {usd > 0 && (
                  <span className="ml-1 text-fg">
                    · ${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}
                  </span>
                )}
              </span>
            </div>
          )}
          <ActionBar
            text={message.content}
            onRegenerate={onRegenerate}
            onBranch={onBranch}
            hidden={isStreaming || empty}
          />
        </div>
      </div>
    </article>
  );
}

// Exported for tests in checkpoint 15.
export const __testing__ = { compose };

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

interface UsageAggregate {
  provider: string | undefined;
  input: number;
  output: number;
  any: boolean;
}

function aggregateUsage(parts: AssistantPart[]): UsageAggregate {
  const init: UsageAggregate = { provider: undefined, input: 0, output: 0, any: false };
  return parts.reduce<UsageAggregate>((acc, p) => {
    if (p.kind !== "usage") return acc;
    return {
      provider: p.provider ?? acc.provider,
      input: acc.input + (p.input_tokens ?? 0),
      output: acc.output + (p.output_tokens ?? 0),
      any: true,
    };
  }, init);
}
