// Lightweight scientific-notation renderer for short model strings such as
// "α_M / α_T / α_R", "W(M,T,R)", or "x^2". It turns `base_sub` into a real
// <sub> and `base^sup` into a <sup> so the actuarial notation reads
// mathematically instead of showing literal underscores/carets.
//
// Deliberately NOT a full math engine (that's what SceloChatMarkdown + KaTeX
// is for). It only rewrites a marker (`_` or `^`) when it's attached to a
// preceding non-space token, so ordinary prose — and leading snake_case like
// "alpha_m" tags — is left untouched. `{...}` groups carry multi-character
// sub/superscripts (e.g. "x_{ij}").

import type { ReactNode } from "react";

const MARKER = /([_^])(\{[^}]+\}|[A-Za-z0-9]+)/g;

export function SciText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const text = children;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null = MARKER.exec(text);
  while (m !== null) {
    // The "base" is the maximal letter/Greek run ending right before the
    // marker. We only render a sub/superscript for a genuine math base — a
    // single character (x_i, W_t) or anything containing a Greek letter
    // (α_M) — so ordinary snake_case prose ("monte_carlo") is left alone.
    const baseMatch = text.slice(0, m.index).match(/[A-Za-zΑ-Ωα-ω]+$/);
    const base = baseMatch ? baseMatch[0] : "";
    const isMathBase = base.length === 1 || /[Α-Ωα-ω]/.test(base);
    if (base !== "" && isMathBase) {
      nodes.push(text.slice(last, m.index));
      const raw = m[2];
      const inner = raw.startsWith("{") ? raw.slice(1, -1) : raw;
      nodes.push(
        m[1] === "_" ? (
          <sub key={key} className="text-[0.8em]">
            {inner}
          </sub>
        ) : (
          <sup key={key} className="text-[0.8em]">
            {inner}
          </sup>
        ),
      );
      key += 1;
      last = m.index + m[0].length;
    }
    m = MARKER.exec(text);
  }
  nodes.push(text.slice(last));
  return <span className={className}>{nodes}</span>;
}
