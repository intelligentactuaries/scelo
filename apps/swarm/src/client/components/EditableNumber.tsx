// Click-to-edit numeric readout, shared by every slider surface.
//
// A slider alone can only reach values on its step grid, and the coarse steps
// that make dragging pleasant (5% here, 1,000,000 there) are exactly the ones
// that stop you entering the value you actually want. This turns the readout
// into a text field on click while leaving the slider untouched.
//
// The resting state must keep looking like a plain number, not a control —
// see `.slider-readout-button` / `.editable-number` in styles.css for the
// button reset that strips the global pill chrome.

import { useEffect, useRef, useState } from 'react';

/** Clamp into range and strip float dust.
 *
 *  Deliberately does NOT snap to `step`. The reason to type a value is to
 *  reach one the slider's coarse step can't hit — forcing 63% back to 65%,
 *  or 45,500,000 back to 45,000,000, would defeat the whole feature. */
export function snapToRange(n: number, min: number, max: number, step: number): number {
  const c = Math.max(min, Math.min(max, n));
  if (step >= 1) return Math.round(c);
  return Math.round(c * 10_000) / 10_000;
}

/** Tolerant numeric parse for typed input: strips thousands separators,
 *  spaces, and a stray currency prefix so "R 45,000,000" and "45000000"
 *  both work. Returns NaN for anything that isn't a number. */
export function parseLoose(s: string): number {
  const cleaned = s.replace(/[,\s_]/g, '').replace(/^[A-Za-z$€£]+/, '');
  if (cleaned === '' || cleaned === '-') return Number.NaN;
  return Number(cleaned);
}

/** Percent controls hold 0..1 internally but are typed as whole percents —
 *  nobody wants to type "0.66". */
export const pctEdit = {
  toEdit: (v: number) => String(Math.round(v * 100)),
  fromEdit: (s: string) => parseLoose(s) / 100,
};

/** For magnitudes displayed abbreviated ("45.00M"). Editing opens on the
 *  exact integer — which is the point, since the abbreviation hides whether
 *  45.00M is 45,000,000 or 45,004,321 — while accepting the shorthand back
 *  so "45m", "45 000 000" and "45,000,000" all work. */
export const magnitudeEdit = {
  toEdit: (v: number) => String(Math.round(v)),
  fromEdit: (s: string) => {
    const m = /^\s*([-+]?[\d.,\s_]+)\s*([kmb])?\s*$/i.exec(s);
    if (!m) return Number.NaN;
    const n = parseLoose(m[1]);
    if (!Number.isFinite(n)) return Number.NaN;
    const suffix = m[2]?.toLowerCase();
    if (suffix === 'k') return n * 1e3;
    if (suffix === 'm') return n * 1e6;
    if (suffix === 'b') return n * 1e9;
    return n;
  },
};

export function EditableNumber({
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
  toEdit,
  fromEdit,
  ariaLabel,
  className = '',
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Display form when not editing (may carry units: "±14y", "66%"). */
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
  /** Internal value → the bare number typed. Defaults to identity. */
  toEdit?: (v: number) => string;
  /** Typed text → internal value. Defaults to a tolerant numeric parse. */
  fromEdit?: (s: string) => number;
  ariaLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const view = toEdit ?? ((v: number) => String(v));
  const parse = fromEdit ?? parseLoose;

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // A disabled control (mid-run) must not be left sitting in edit mode.
  useEffect(() => {
    if (disabled) setEditing(false);
  }, [disabled]);

  const commit = () => {
    setEditing(false);
    const raw = draft.trim();
    // Empty or unparseable input keeps the previous value rather than
    // collapsing to 0 / NaN — a half-typed number that loses focus should
    // not silently destroy the setting.
    if (raw === '') return;
    const n = parse(raw);
    if (!Number.isFinite(n)) return;
    const next = snapToRange(n, min, max, step);
    if (next !== value) onChange(next);
  };

  const nudge = (dir: 1 | -1) => {
    // The empty-string check matters: for percent controls `parse('')` is
    // `NaN / 100`, but for the default parse a cleared field would otherwise
    // read as 0 and jump the value to the minimum.
    const typed = draft.trim() === '' ? Number.NaN : parse(draft);
    const current = Number.isFinite(typed) ? typed : value;
    setDraft(view(snapToRange(current + dir * step, min, max, step)));
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-number-input ${className}`}
        // `text` + inputMode rather than type="number": these readouts sit in
        // ~40px cells and native spinner arrows eat most of that. Arrow keys
        // are handled below so stepping still works.
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false); // discard
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(-1);
          }
        }}
        aria-label={ariaLabel}
      />
    );
  }

  return (
    <button
      type="button"
      className={`editable-number ${className}`}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        setDraft(view(value));
        setEditing(true);
      }}
      title={disabled ? undefined : `Click to type an exact value (${format(min)}–${format(max)})`}
    >
      {format(value)}
    </button>
  );
}
