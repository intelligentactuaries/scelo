// actuarialTableUi.tsx — the UI half of actuarial table generation.
//
// The maths, the suggester and the prompt parser live headless in
// @scelo/core (actuarialTables.ts). This file is everything that touches
// React / the workspace:
//
//   buildWorkspaceTable   spec → WorkspaceTable (generate + stamp provenance)
//   TablePreview          compact first-N-rows table
//   ChatTableCard         renders a ```table fenced block in a chat reply —
//                         builds the table against the active dataset and
//                         offers "keep in workspace" / "use as dataset" / CSV
//   TableIdeasStrip       Soft Data: the agent's suggestions right after an
//                         upload — each with its ready-made prompt, a Build
//                         button and a Send-to-chat button
//   TablesShelf           Soft Data: what has been built this session
//
// Chat drafts: `seedChatDraft(chatId, text)` dispatches a window event the
// StageChatPanel listens for, so a suggestion can drop its prompt into the
// right-hand chat's input without threading props through three panes.

import {
  type ActuarialTableSpec,
  type Dataset,
  type TableSuggestion,
  coerceTableSpec,
  formatNumber,
  generateActuarialTable,
  tableToCsv,
} from "@scelo/core";
import { useEffect, useMemo, useState } from "react";
import { extractFirstJsonObject } from "./chatDerive";
import { type WorkspaceTable, useScelo } from "./sceloContext";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Deterministic id for a (spec, source) pair so re-rendering the same chat
 *  reply or pressing the same suggestion twice replaces rather than
 *  duplicates. */
export function tableIdFor(spec: ActuarialTableSpec, sourceDataset: string | null): string {
  // Canonical form: keys sorted, undefined dropped, `title` ignored — so the
  // spec the hook built from a prompt and the same spec re-read from the
  // reply's ```table block (which carries the title and may order keys
  // differently after coerceTableSpec) hash to the same id.
  const { title: _title, ...rest } = spec as ActuarialTableSpec & { title?: string };
  const raw = `${sourceDataset ?? "-"}|${stableStringify(rest)}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
  return `tbl-${spec.kind}-${(h >>> 0).toString(36)}`;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function buildWorkspaceTable(
  spec: ActuarialTableSpec,
  dataset: Dataset | null,
  origin: WorkspaceTable["origin"],
): WorkspaceTable {
  const built = generateActuarialTable(spec, dataset);
  const needsData = specReadsDataset(spec);
  return {
    id: tableIdFor(spec, needsData ? (dataset?.name ?? null) : null),
    title: built.title,
    spec,
    dataset: built.dataset,
    notes: built.notes,
    basisLabel: built.basisLabel,
    sourceDataset: needsData ? (dataset?.name ?? null) : null,
    origin,
    createdAt: Date.now(),
  };
}

/** True when the spec reads columns from the active dataset (as opposed to
 *  a purely parametric table). */
export function specReadsDataset(spec: ActuarialTableSpec): boolean {
  switch (spec.kind) {
    case "life-table":
    case "commutation":
    case "annuity-assurance":
    case "net-premium":
      return spec.basis.kind !== "gompertz-makeham";
    case "runoff-triangle":
    case "exposure-ae":
    case "model-points":
      return true;
    case "discount-curve":
      return Boolean(spec.tenorColumn && spec.rateColumn);
  }
}

export function downloadCsv(filename: string, dataset: Dataset): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([tableToCsv(dataset)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(title: string): string {
  return `${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "table"
  }.csv`;
}

export const CHAT_DRAFT_EVENT = "scelo:chat-draft";
export function seedChatDraft(chatId: string, text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_DRAFT_EVENT, { detail: { chatId, text } }));
}

/** Markdown for a chat reply that carries a built table. The ```table block
 *  renders as ChatTableCard; `kept` tells the card the workspace already has
 *  it (typed commands auto-keep, LLM proposals don't). */
export function tableReplyMarkdown(
  t: WorkspaceTable,
  opts: { kept: boolean; lead?: string },
): string {
  const rows = t.dataset.rows.length;
  const cols = t.dataset.columns.length;
  const lead = opts.lead ?? `Built **${t.title}** — ${rows.toLocaleString()} rows × ${cols} cols.`;
  const keep = opts.kept
    ? "Kept in your workspace tables (Soft Data → Tables); use it as the active dataset, stage it for a combine, or download the CSV from the card."
    : "Press **keep** on the card to add it to your workspace tables.";
  const notes = t.notes.length ? `\n\n${t.notes.map((n) => `- ${n}`).join("\n")}` : "";
  return `${lead} ${keep}\n\n\`\`\`table\n${JSON.stringify({ ...t.spec, title: t.title }, null, 0)}\n\`\`\`${notes}`;
}

// ─── TablePreview ────────────────────────────────────────────────────────

export function TablePreview({
  dataset,
  maxRows = 8,
  dense = false,
}: {
  dataset: Dataset;
  maxRows?: number;
  dense?: boolean;
}) {
  const rows = dataset.rows.slice(0, maxRows);
  const more = dataset.rows.length - rows.length;
  // `!` variants: inside a chat reply the preview sits under `.ia-md`, whose
  // `th`/`td` rules (padding, uppercase headers) would otherwise win on
  // specificity — and uppercase would collapse dx / Dx into one label.
  const cell = dense ? "!px-1.5 !py-0.5" : "!px-2 !py-1";
  return (
    <div className="min-w-0 overflow-x-auto rounded border border-border bg-bg">
      <table
        className={`w-full border-collapse font-mono ${dense ? "text-[10px]" : "text-[11px]"}`}
      >
        <thead>
          <tr className="bg-bg-1 text-left text-fg-mute">
            {dataset.columns.map((c) => (
              <th
                key={c}
                // normal-case matters here: dx and Dx are different functions.
                className={`${cell} whitespace-nowrap !font-normal !normal-case !tracking-normal !text-[inherit]`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={String(r[dataset.columns[0]] ?? i)}
              className="border-t border-border/60 text-fg"
            >
              {dataset.columns.map((c) => {
                const v = r[c];
                return (
                  <td key={c} className={`${cell} whitespace-nowrap tabular-nums`}>
                    {v === null || v === undefined ? (
                      <span className="text-fg-dim">·</span>
                    ) : typeof v === "number" ? (
                      formatNumber(v)
                    ) : (
                      String(v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && (
        <div className="border-t border-border/60 px-2 py-1 font-mono text-[10px] text-fg-dim">
          … {more.toLocaleString()} more row{more === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

// ─── ChatTableCard (```table fenced block) ───────────────────────────────

type CardState =
  | { kind: "ok"; table: WorkspaceTable }
  | { kind: "error"; message: string }
  | { kind: "pending" };

function safeParseSpec(raw: string): ActuarialTableSpec | { error: string } {
  const json = extractFirstJsonObject(raw);
  if (!json) return { error: "no JSON object in the table block" };
  try {
    return coerceTableSpec(JSON.parse(json));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function ChatTableCard({ raw }: { raw: string }) {
  const {
    dataset,
    tables,
    addTable,
    removeTable,
    setDataset,
    pushHistory,
    setFilters,
    logEvent,
    stagedDatasets,
    setStagedDatasets,
  } = useScelo();
  const parsed = useMemo(() => safeParseSpec(raw), [raw]);
  const [state, setState] = useState<CardState>({ kind: "pending" });
  const [expanded, setExpanded] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild only when the spec or the dataset identity changes.
  useEffect(() => {
    if ("error" in parsed) {
      setState({ kind: "error", message: parsed.error });
      return;
    }
    try {
      setState({ kind: "ok", table: buildWorkspaceTable(parsed, dataset, "llm") });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [raw, dataset?.name, dataset?.rows.length, dataset?.columns.length]);

  if (state.kind === "pending") {
    return <Shell tone="neutral">building table…</Shell>;
  }
  if (state.kind === "error") {
    return (
      <Shell tone="error">
        could not build the table: {state.message}
        {!dataset && (
          <div className="mt-1 text-fg-mute">
            No dataset is loaded — parametric tables (illustrative Gompertz–Makeham basis, flat
            discount curve) still work; column-based ones need a file.
          </div>
        )}
      </Shell>
    );
  }
  const t = state.table;
  const kept = tables.some((x) => x.id === t.id);
  const canStage = Boolean(dataset) && stagedDatasets.length < 2;
  return (
    <Shell tone="ok">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-primary">▦ table</span>
        <span className="break-words text-fg">{t.title}</span>
        <span className="text-fg-dim">
          {t.dataset.rows.length.toLocaleString()} × {t.dataset.columns.length}
        </span>
      </div>
      <div className="mt-1.5">
        <TablePreview dataset={t.dataset} maxRows={expanded ? 40 : 6} dense />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <CardButton
          onClick={() => {
            if (kept) removeTable(t.id);
            else {
              addTable({ ...t, createdAt: Date.now() });
              logEvent({
                stage: "soft",
                kind: "table.keep",
                payload: { id: t.id, title: t.title, kind: t.spec.kind, origin: t.origin },
              });
            }
          }}
          title={
            kept
              ? "Remove from workspace tables"
              : "Keep this table in the workspace (Soft Data → Tables)"
          }
          active={kept}
        >
          {kept ? "✓ kept" : "keep"}
        </CardButton>
        <CardButton
          onClick={() => {
            pushHistory(`replace dataset with table «${t.title}»`);
            setDataset({ ...t.dataset, name: t.title });
            setFilters([]);
            logEvent({ stage: "soft", kind: "table.use", payload: { id: t.id, title: t.title } });
          }}
          title="Make this table the active dataset (undo restores the previous one)"
        >
          use as dataset
        </CardButton>
        {canStage && (
          <CardButton
            onClick={() => setStagedDatasets((prev) => [...prev, { ...t.dataset, name: t.title }])}
            title="Stage beside the active dataset for a combine (join / append)"
          >
            stage for combine
          </CardButton>
        )}
        <CardButton
          onClick={() => downloadCsv(safeFilename(t.title), t.dataset)}
          title="Download as CSV"
        >
          csv
        </CardButton>
        {t.dataset.rows.length > 6 && (
          <CardButton onClick={() => setExpanded((v) => !v)} title="Show more rows">
            {expanded ? "fewer rows" : "more rows"}
          </CardButton>
        )}
      </div>
      {t.notes.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-fg-mute">
          {t.notes.map((n) => (
            <li key={n} className="break-words">
              {n}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({
  tone,
  children,
}: { tone: "ok" | "neutral" | "error"; children: React.ReactNode }) {
  const toneClass =
    tone === "ok"
      ? "border-primary/40 bg-primary/5 text-fg"
      : tone === "error"
        ? "border-error/40 bg-error/5 text-error"
        : "border-border bg-bg-1 text-fg-mute";
  return (
    <div
      className={`my-2 min-w-0 overflow-hidden rounded border ${toneClass} px-3 py-2 font-mono text-[11px] leading-snug`}
    >
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function CardButton({
  children,
  onClick,
  title,
  active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-bg text-fg-mute hover:border-primary hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

// ─── TableIdeasStrip (Soft Data, after upload) ───────────────────────────

export function TableIdeasStrip({
  suggestions,
  onBuild,
  chatId = "soft-stage",
  compact = false,
}: {
  suggestions: TableSuggestion[];
  /** Build immediately (the same path a typed prompt takes). Returns the
   *  assistant-style summary so the strip can flash it. */
  onBuild: (s: TableSuggestion) => string;
  chatId?: string;
  compact?: boolean;
}) {
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showPrompt, setShowPrompt] = useState<Set<string>>(new Set());
  const visible = suggestions.filter((s) => !dismissed.has(s.id));
  if (visible.length === 0) return null;
  return (
    <section className="rounded border border-accent-2/40 bg-accent-2/[0.04] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-accent-2">
            table ideas
          </span>
          <span className="text-[11px] text-fg-mute">
            Scelo read the data and thinks these actuarial tables follow from it. Each comes with a
            prompt — build it, or send the prompt to the chat and adjust it first.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(new Set(suggestions.map((s) => s.id)))}
          className="font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg"
          title="Hide these suggestions"
        >
          dismiss
        </button>
      </div>
      <ul
        className={`mt-2 grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"}`}
      >
        {visible.map((s) => (
          <li
            key={s.id}
            className="flex min-w-0 flex-col gap-1 rounded border border-border bg-bg px-2.5 py-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[12px] text-fg" title={s.title}>
                {s.title}
              </span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                {s.kind}
              </span>
            </div>
            <p className="text-[11px] leading-snug text-fg-mute">
              <InlineCode text={s.why} />
            </p>
            {showPrompt.has(s.id) && (
              <div className="rounded border border-border bg-bg-1 px-2 py-1 font-mono text-[10px] text-fg">
                <InlineCode text={s.prompt} />
              </div>
            )}
            <div className="mt-0.5 flex flex-wrap gap-1.5">
              <CardButton
                onClick={() => {
                  const msg = onBuild(s);
                  setFlash((f) => ({ ...f, [s.id]: msg }));
                }}
                title="Build this table now and keep it in the workspace"
                active
              >
                build
              </CardButton>
              <CardButton
                onClick={() => seedChatDraft(chatId, s.prompt)}
                title="Put this prompt into the chat on the right so you can edit it before sending"
              >
                send prompt to chat
              </CardButton>
              <CardButton
                onClick={() =>
                  setShowPrompt((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                title="Show the prompt text"
              >
                {showPrompt.has(s.id) ? "hide prompt" : "show prompt"}
              </CardButton>
              <CardButton
                onClick={() => setDismissed((prev) => new Set([...prev, s.id]))}
                title="Not this one"
              >
                ×
              </CardButton>
            </div>
            {flash[s.id] && (
              <div className="mt-1 rounded border border-primary/40 bg-primary/5 px-2 py-1 font-mono text-[10px] text-fg-mute">
                {flash[s.id]}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Render `code` spans from a plain string (the suggester marks column
 *  names with backticks). */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className="rounded bg-bg-1 px-1 text-fg">
            {p.slice(1, -1)}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

// ─── TablesShelf (Soft Data) ─────────────────────────────────────────────

export function TablesShelf() {
  const {
    tables,
    removeTable,
    clearTables,
    setDataset,
    pushHistory,
    setFilters,
    logEvent,
    dataset,
    stagedDatasets,
    setStagedDatasets,
  } = useScelo();
  const [open, setOpen] = useState<string | null>(null);
  if (tables.length === 0) return null;
  const canStage = Boolean(dataset) && stagedDatasets.length < 2;
  return (
    <section className="rounded border border-border bg-bg-1 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-primary">
            tables
          </span>
          <span className="text-[11px] text-fg-mute">
            {tables.length} actuarial table{tables.length === 1 ? "" : "s"} built this session —
            kept beside your dataset, not in it.
          </span>
        </div>
        <button
          type="button"
          onClick={clearTables}
          className="font-mono text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg"
          title="Remove all generated tables"
        >
          clear
        </button>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {[...tables].reverse().map((t) => (
          <li key={t.id} className="rounded border border-border bg-bg px-2.5 py-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <button
                type="button"
                onClick={() => setOpen((cur) => (cur === t.id ? null : t.id))}
                className="min-w-0 truncate text-left text-[12px] text-fg hover:text-primary"
                title={open === t.id ? "Collapse" : "Preview"}
              >
                {open === t.id ? "▾" : "▸"} {t.title}
              </button>
              <span className="font-mono text-[9px] uppercase tracking-wider text-fg-dim">
                {t.dataset.rows.length.toLocaleString()} × {t.dataset.columns.length} · {t.origin}
                {t.sourceDataset ? ` · from ${t.sourceDataset}` : ""}
              </span>
              <span className="ml-auto flex flex-wrap gap-1.5">
                <CardButton
                  onClick={() => {
                    pushHistory(`replace dataset with table «${t.title}»`);
                    setDataset({ ...t.dataset, name: t.title });
                    setFilters([]);
                    logEvent({
                      stage: "soft",
                      kind: "table.use",
                      payload: { id: t.id, title: t.title },
                    });
                  }}
                  title="Make this table the active dataset (undo restores the previous one)"
                >
                  use as dataset
                </CardButton>
                {canStage && (
                  <CardButton
                    onClick={() =>
                      setStagedDatasets((prev) => [...prev, { ...t.dataset, name: t.title }])
                    }
                    title="Stage beside the active dataset for a combine"
                  >
                    stage
                  </CardButton>
                )}
                <CardButton
                  onClick={() => downloadCsv(safeFilename(t.title), t.dataset)}
                  title="Download CSV"
                >
                  csv
                </CardButton>
                <CardButton onClick={() => removeTable(t.id)} title="Remove">
                  ×
                </CardButton>
              </span>
            </div>
            {open === t.id && (
              <div className="mt-1.5">
                <TablePreview dataset={t.dataset} maxRows={12} dense />
                <div className="mt-1 font-mono text-[10px] text-fg-dim">{t.basisLabel}</div>
                {t.notes.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[10px] text-fg-mute">
                    {t.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
