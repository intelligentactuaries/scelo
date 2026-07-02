// Scelo's single data-intake loading primitive. One 'data materialising'
// vocabulary — a skeleton table shimmering in over a hairline rail — reused at
// three prominences across all six upload surfaces:
//   layout="lg"      → the empty-state canvas (the #1 anxiety fix)
//   layout="inline"  → the compact strip under the header (import / staging)
//   layout="overlay" → a dimmed scrim over the grid while combineAll() runs
//
// Determinate where truthful: the CSV streamer writes real byte-% + a rising
// row count into uploadState, so the rail FILLS and the counter ticks up.
// Indeterminate where there is no signal (parquet decode, the combine merge,
// the moment before the first CSV chunk) the rail SCANS. A percentage is never
// invented. Keyframes + reduced-motion live in styles/theme.css.

import { useEffect, useRef, useState } from "react";

export type UploadAccent = "warn" | "accent-2" | "primary";

export type UploadState = {
  /** eyebrow verb: 'parsing' | 'decoding' | 'staging' | 'combining'. */
  verb: string;
  /** filename or, for combine, 'N datasets'. */
  name?: string;
  /** real 0–100 byte-progress (CSV only). Absent ⇒ indeterminate scan. */
  pct?: number;
  /** running row count (CSV only). Absent ⇒ no counter. */
  rowsSeen?: number;
};

const ACCENT_VAR: Record<UploadAccent, string> = {
  warn: "--rgb-warn",
  "accent-2": "--rgb-accent-2",
  primary: "--rgb-primary",
};
const rgb = (v: string) => `rgb(var(${v}))`;

// ── hook: minimum-visible latch ──────────────────────────────────────────────
// Holds the last non-null snapshot on screen for at least `minMs` after the
// source clears, so a sub-100ms parse of a tiny file shows the indicator for
// ~350ms instead of flashing (which reads as 'nothing happened'). Keeps the
// LATEST snapshot live while active so pct/rows update in real time.
export function useMinVisible<T>(value: T | null, minMs = 350): T | null {
  const [held, setHeld] = useState<T | null>(value);
  const shownAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (value != null) {
      if (held == null) shownAt.current = performance.now();
      setHeld(value);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
    } else if (held != null && timer.current == null) {
      const wait = Math.max(0, minMs - (performance.now() - shownAt.current));
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setHeld(null);
      }, wait);
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }
    };
  }, [value, held, minMs]);
  return held;
}

// ── hook: gentle honest count-up ─────────────────────────────────────────────
// Eases the DISPLAYED rows toward the truthful target so digits roll instead of
// jumping on each ~10Hz chunk. Monotonic and never exceeds the real target —
// nothing fabricated. Snaps down on a fresh import.
function useCountUp(target: number | undefined): number | undefined {
  const [display, setDisplay] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (target == null) return;
    if (target <= from.current) {
      from.current = target;
      setDisplay(target);
      return;
    }
    const start = performance.now();
    const base = from.current;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 220);
      const eased = 1 - (1 - k) ** 3;
      const v = Math.min(target, Math.round(base + (target - base) * eased));
      setDisplay(v);
      from.current = v;
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target]);
  return target == null ? undefined : display;
}

// ── visually-hidden polite announcer ─────────────────────────────────────────
// Speaks only when the coarse progress bucket (0/25/50/75/100) or the verb/name
// changes, so a 10Hz repaint never floods assistive tech. Baked into every
// layout so callers can't forget it.
function UploadAnnouncer({ state }: { state: UploadState }) {
  const [msg, setMsg] = useState("");
  const bucket = state.pct === undefined ? -1 : Math.min(4, Math.floor(state.pct / 25));
  const last = useRef<string>("");
  useEffect(() => {
    const key = `${state.verb}|${state.name ?? ""}|${bucket}`;
    if (last.current === key) return;
    last.current = key;
    const pctPart =
      state.pct === undefined ? "" : `, ${Math.min(100, Math.floor(state.pct))} percent`;
    setMsg(`${state.verb}${state.name ? ` ${state.name}` : ""}${pctPart}`);
  }, [state.verb, state.name, bucket, state.pct]);
  // <output> carries an implicit role="status"; keeps it a polite, visually
  // hidden live region without a redundant role attribute.
  return (
    <output className="sr-only" aria-live="polite" aria-busy="true">
      {msg}
    </output>
  );
}

// ── the hairline rail ────────────────────────────────────────────────────────
function Rail({
  state,
  accentVar,
  className,
}: {
  state: UploadState;
  accentVar: string;
  className: string;
}) {
  const determinate = typeof state.pct === "number";
  const pct = determinate ? Math.min(100, Math.max(0, state.pct as number)) : 0;
  return (
    <span aria-hidden className={`ia-rail ${className}`}>
      {determinate ? (
        <span
          className="ia-rail-fill"
          // 2% seed so the bar is visibly alive on the very first paint.
          style={{ width: `${Math.max(2, pct)}%`, background: rgb(accentVar) }}
        />
      ) : (
        <span
          className="ia-rail-scan"
          style={{
            background: `linear-gradient(90deg, transparent, ${rgb(accentVar)} 50%, transparent)`,
          }}
        />
      )}
    </span>
  );
}

// ── the skeleton grid ────────────────────────────────────────────────────────
function SkeletonGrid({ rows, cols, cellH }: { rows: number; cols: number; cellH: number }) {
  return (
    <div
      aria-hidden
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: rows * cols }).map((_, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const delay = ((r + c) % (rows + cols)) * 90; // diagonal materialise wave (ms)
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size decorative skeleton, cells never reorder.
            key={i}
            className={`ia-skel-cell${r === 0 ? " ia-skel-head" : ""}`}
            style={{ height: r === 0 ? cellH + 2 : cellH, animationDelay: `${delay}ms` }}
          />
        );
      })}
    </div>
  );
}

// ── the primitive ───────────────────────────────────────────────────────────
export function UploadIndicator({
  state,
  layout = "inline",
  accent = "warn",
}: {
  state: UploadState;
  layout?: "lg" | "inline" | "overlay";
  accent?: UploadAccent;
}) {
  const accentVar = ACCENT_VAR[accent];
  const determinate = typeof state.pct === "number";
  const pct = determinate ? Math.min(100, Math.max(0, state.pct as number)) : 0;
  const rolled = useCountUp(state.rowsSeen);

  const pip = <span className="ia-pip ia-load-pip" style={{ background: rgb(accentVar) }} />;

  // ── inline strip: header import / staging (dataset already on screen) ──
  if (layout === "inline") {
    return (
      <div
        aria-busy="true"
        className="flex min-h-[26px] shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-3 py-1 font-mono text-[10px] text-fg-mute"
      >
        {pip}
        <span>{state.verb}</span>
        {state.name && (
          <>
            <span className="text-fg-dim">·</span>
            <span className="max-w-[38%] truncate">{state.name}</span>
          </>
        )}
        {rolled !== undefined && (
          <>
            <span className="text-fg-dim">·</span>
            <span className="ia-num shrink-0">{rolled.toLocaleString()} rows</span>
          </>
        )}
        {determinate && (
          <span className="ia-num ml-auto shrink-0 text-right" style={{ minWidth: "2.75ch" }}>
            {Math.floor(pct)}%
          </span>
        )}
        <Rail
          state={state}
          accentVar={accentVar}
          className={determinate ? "h-1 w-24 shrink-0" : "ml-auto h-1 w-24 shrink-0"}
        />
        <UploadAnnouncer state={state} />
      </div>
    );
  }

  // ── overlay scrim: combine execution (dimmed, over the grid) ──
  if (layout === "overlay") {
    return (
      <div
        aria-busy="true"
        className="absolute inset-0 z-30 flex items-center justify-center bg-bg/70 backdrop-blur-[1.5px]"
      >
        <div className="w-full max-w-[320px] px-6">
          <SkeletonGrid rows={5} cols={8} cellH={9} />
          <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-fg-mute">
            {pip}
            <span className="tracking-[0.12em]">{state.verb}</span>
            {state.name && (
              <>
                <span className="text-fg-dim">·</span>
                <span className="min-w-0 truncate text-fg">{state.name}</span>
              </>
            )}
          </div>
          <div className="mt-2">
            <Rail state={state} accentVar={accentVar} className="h-[3px] w-full" />
          </div>
        </div>
        <UploadAnnouncer state={state} />
      </div>
    );
  }

  // ── lg card: the empty-state stage. Same flex-centered footprint as
  //    <EmptyState/>, so swapping one for the other is zero-CLS. ──
  return (
    <div aria-busy="true" className="flex h-full items-center justify-center">
      <div className="w-full max-w-[320px] px-6">
        <SkeletonGrid rows={5} cols={8} cellH={9} />
        <div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-fg-mute">
          {pip}
          <span className="tracking-[0.12em]">{state.verb}</span>
          {state.name && (
            <>
              <span className="text-fg-dim">·</span>
              <span className="min-w-0 truncate text-fg">{state.name}</span>
            </>
          )}
          {rolled !== undefined && (
            <span className="ia-num ml-auto shrink-0 text-fg-mute">
              {rolled.toLocaleString()} rows
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Rail state={state} accentVar={accentVar} className="h-[3px] flex-1" />
          {determinate && (
            <span className="ia-num shrink-0 text-[11px] text-fg-mute">{Math.floor(pct)}%</span>
          )}
        </div>
        <UploadAnnouncer state={state} />
      </div>
    </div>
  );
}
