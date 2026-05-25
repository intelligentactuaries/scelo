// Reproducibility-export modal.
//
// Opens from any process layer (the macro view + the three workstations) and
// presents a 4-tab interface — Python | R | C++ | Prompt — over the activity
// log captured in `sceloContext`. Each tab is a syntax-highlight-free
// preformatted text block with a copy button + a download button. Sized
// to mirror the chat modal (80% × 80%, blurred backdrop) so it feels
// like the rest of Scelo's modal family.

import { useEffect, useMemo, useState } from "react";
import { type Stage, eventsThroughStage } from "./activityLog";
import { useScelo } from "./sceloContext";
import { type ExportLang, fileExtensionFor, generateScript } from "./scriptExporter";

const TAB_LABELS: Record<ExportLang, string> = {
  python: "python",
  r: "r",
  cpp: "c++",
  prompt: "prompt",
};

const TAB_BLURBS: Record<ExportLang, string> = {
  python:
    "pandas + numpy. Paste into a `.py` file; install `chainladder` / `statsmodels` for the model fits flagged as TODO.",
  r: "tidyverse pipeline. Paste into an `.R` file; load `ChainLadder` / `StMoMo` for the model fits flagged as TODO.",
  cpp: "Workflow skeleton (std::vector + std::unordered_map). Actuarial fits are stubbed — wire to a numerics library or hand off to Python via pybind11.",
  prompt:
    "Plain-language reproducible prompt for any LLM. Paste, then ask for code in whichever language you prefer.",
};

const TABS: ExportLang[] = ["python", "r", "cpp", "prompt"];

export function ExportScreen({
  stage,
  open,
  onDismiss,
}: {
  stage: Stage | "macro";
  open: boolean;
  onDismiss: () => void;
}) {
  const { events } = useScelo();
  const [lang, setLang] = useState<ExportLang>("python");
  const [copied, setCopied] = useState(false);

  // Reset copy state when the user switches tab or reopens. `lang` and
  // `open` are intentional triggers — the effect body uses neither value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not reads.
  useEffect(() => {
    setCopied(false);
  }, [lang, open]);

  // ESC closes — matches every other Scelo modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  // For per-stage exports we slice the log down to events at or before
  // that stage in the pipeline. Macro keeps the full log.
  const scoped = useMemo(() => {
    if (stage === "macro") return events;
    return eventsThroughStage(events, stage);
  }, [events, stage]);

  const stageLabel = stage === "macro" ? "macro · all stages" : stage;

  const script = useMemo(
    () => generateScript({ lang, events: scoped, stage: stageLabel }),
    [lang, scoped, stageLabel],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older Safari without permission
    }
  };

  const download = () => {
    const ext = fileExtensionFor(lang);
    const base = stage === "macro" ? "scelo_workflow" : `scelo_${stage}`;
    const blob = new Blob([script], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the document level above.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/30 backdrop-blur-md"
      onClick={onDismiss}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only. */}
      <div
        className="flex h-[80vh] w-[80vw] max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-3 py-2">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary">
              export · reproducible workflow
            </div>
            <h2 className="truncate font-mono text-xs text-fg-mute">
              {stageLabel} · {scoped.length} step{scoped.length === 1 ? "" : "s"} recorded
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="close"
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-error hover:text-error"
          >
            close · esc
          </button>
        </header>

        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg px-2 py-1">
          {TABS.map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setLang(t)}
              className={`rounded border px-2 py-1 font-mono text-[11px] uppercase tracking-wider transition ${
                lang === t
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-fg-mute hover:border-border hover:text-fg"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
          <div className="ml-2 flex-1 truncate font-mono text-[10px] text-fg-dim">
            {TAB_BLURBS[lang]}
          </div>
          <button
            type="button"
            onClick={copy}
            className="rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
          <button
            type="button"
            onClick={download}
            className="rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/20"
          >
            download .{fileExtensionFor(lang)}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-bg p-3">
          {scoped.length === 0 ? (
            <p className="font-mono text-[11px] text-fg-dim">
              No activity recorded yet. Load a dataset (or step through Soft → Tools → Hard) and
              come back — every meaningful action lands in this log.
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-fg-mute">
              {script}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// Toolbar trigger that opens the export screen. Used in every workstation
// header and the macro view's project bar. Renders inline (no portal) — the
// modal itself sits at `fixed inset-0` so layering is fine.
//
// `variant="primary"` is reserved for the macro view's "export the whole
// pipeline" affordance so it reads as a primary CTA rather than a quiet
// toolbar chip. Workstation triggers stick to the default muted styling.
export function ExportButton({
  stage,
  disabled,
  variant = "muted",
  label,
}: {
  stage: Stage | "macro";
  disabled?: boolean;
  variant?: "muted" | "primary";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const chrome =
    variant === "primary"
      ? "rounded border border-primary/60 bg-primary/10 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-primary hover:border-primary hover:bg-primary/20"
      : "rounded border border-border bg-bg-2 px-2 py-1 font-mono text-[11px] text-fg-mute hover:border-primary hover:text-primary";
  const displayLabel = label ?? "export · code";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Export this workflow as Python / R / C++ code or a reproducible LLM prompt"
        className={`${chrome} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {displayLabel}
      </button>
      <ExportScreen stage={stage} open={open} onDismiss={() => setOpen(false)} />
    </>
  );
}
