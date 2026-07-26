// Click-to-edit numeric readout for slider controls.
//
// A slider can only reach values on its step grid, and the coarse steps that
// make dragging pleasant (20 agents at a time here) are exactly the ones that
// stop you entering the value you actually want. This turns the readout into
// a text field on click, leaving the slider itself untouched.
//
// Mirrors the swarm client's component of the same name so the two apps
// behave identically; the logic below is the tested copy (the swarm repo has
// no test runner).

import { useEffect, useRef, useState } from "react";

/** Clamp into range and strip float dust.
 *
 *  Deliberately does NOT snap to `step`. The reason to type a value is to
 *  reach one the slider's coarse step can't hit — forcing 250 back to 240
 *  would defeat the whole feature. */
export function snapToRange(n: number, min: number, max: number, step: number): number {
  const c = Math.max(min, Math.min(max, n));
  if (step >= 1) return Math.round(c);
  return Math.round(c * 10_000) / 10_000;
}

/** Tolerant numeric parse: strips thousands separators, spaces, and a stray
 *  currency prefix so "R 45,000" and "45000" both work. NaN for non-numbers. */
export function parseLoose(s: string): number {
  const cleaned = s.replace(/[,\s_]/g, "").replace(/^[A-Za-z$€£]+/, "");
  if (cleaned === "" || cleaned === "-") return Number.NaN;
  return Number(cleaned);
}

/** Percent controls hold 0..1 internally but are typed as whole percents. */
export const pctEdit = {
  toEdit: (v: number) => String(Math.round(v * 100)),
  fromEdit: (s: string) => parseLoose(s) / 100,
};

/** For magnitudes displayed abbreviated ("45.00M"): edits open on the exact
 *  integer, and accept "45m" / "45,000,000" / "45 000 000" back. */
export const magnitudeEdit = {
  toEdit: (v: number) => String(Math.round(v)),
  fromEdit: (s: string) => {
    const m = /^\s*([-+]?[\d.,\s_]+)\s*([kmb])?\s*$/i.exec(s);
    if (!m) return Number.NaN;
    const n = parseLoose(m[1]);
    if (!Number.isFinite(n)) return Number.NaN;
    const suffix = m[2]?.toLowerCase();
    if (suffix === "k") return n * 1e3;
    if (suffix === "m") return n * 1e6;
    if (suffix === "b") return n * 1e9;
    return n;
  },
};

export function EditableNumber({
  value,
  min,
  max,
  step,
  format = String,
  onChange,
  disabled,
  toEdit,
  fromEdit,
  ariaLabel,
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
  toEdit?: (v: number) => string;
  fromEdit?: (s: string) => number;
  ariaLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const view = toEdit ?? ((v: number) => String(v));
  const parse = fromEdit ?? parseLoose;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // A control disabled mid-run must not be left sitting in edit mode.
  useEffect(() => {
    if (disabled) setEditing(false);
  }, [disabled]);

  const commit = () => {
    setEditing(false);
    const raw = draft.trim();
    // Empty or unparseable input keeps the previous value rather than
    // collapsing to 0 / NaN — a half-typed number that loses focus should
    // not silently destroy the setting.
    if (raw === "") return;
    const n = parse(raw);
    if (!Number.isFinite(n)) return;
    const next = snapToRange(n, min, max, step);
    if (next !== value) onChange(next);
  };

  const nudge = (dir: 1 | -1) => {
    // The empty-string check matters: a cleared field would otherwise parse
    // as 0 and jump the value to the minimum instead of stepping.
    const typed = draft.trim() === "" ? Number.NaN : parse(draft);
    const current = Number.isFinite(typed) ? typed : value;
    setDraft(view(snapToRange(current + dir * step, min, max, step)));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        // `text` + inputMode rather than type="number": native spinner arrows
        // crowd a readout this small. Arrow keys are handled below instead.
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false); // discard
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            nudge(1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            nudge(-1);
          }
        }}
        aria-label={ariaLabel}
        className={`w-16 rounded border border-primary bg-bg px-1 py-0 text-center font-mono text-[10px] text-fg outline-none ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        setDraft(view(value));
        setEditing(true);
      }}
      title={disabled ? undefined : `Click to type an exact value (${format(min)}–${format(max)})`}
      // Underline-on-hover rather than a box: the resting state has to keep
      // reading as a plain number in the label line, not as a button.
      className={`cursor-text rounded font-mono text-[10px] text-fg underline decoration-dotted decoration-transparent underline-offset-2 transition hover:decoration-fg-dim focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {format(value)}
    </button>
  );
}
