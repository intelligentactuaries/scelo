import { useEffect, useRef } from 'react';
import katex from 'katex';
import { ACTUARIAL_MACROS } from '../lib/actuarialMacros';

type Props = {
  text: string;
};

// The Actuary "applied" line is a mix of plain English and math —
// e.g. "With $i = 0.085$ and $n = 7$, PV factor = $(1 - 1.085^{-7})/0.085 = 4.92$
// per unit of annual cashflow.". This component splits on `$…$`
// delimiters and renders math segments inline via KaTeX, plain
// segments as-is. Falls back to plain text if no delimiters are
// present (handles older runs that didn't get the prompt update).
export function AppliedLine({ text }: Props) {
  const segments = splitMath(text);
  return (
    <span>
      {segments.map((seg, i) =>
        seg.kind === 'math' ? (
          <InlineMath key={i} latex={seg.value} />
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </span>
  );
}

type Segment = { kind: 'text' | 'math'; value: string };

// Strategy:
//   1. If the string contains any `$`, treat it as the model's intentional
//      `$math$` markup (new prompt format) and split on those.
//   2. Otherwise auto-detect math fragments by regex — needed for legacy
//      cached runs whose `applied` lines were generated before the prompt
//      added the dollar-delimiter rule.
export function splitMath(s: string): Segment[] {
  if (s.indexOf('$') >= 0) return splitDelimited(s);
  return splitAuto(s);
}

// $...$ delimited splitter. Backslash-escaped `\$` is a literal $.
// Unterminated trailing $ becomes plain text — never throws.
function splitDelimited(s: string): Segment[] {
  const out: Segment[] = [];
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    if (c !== '$') {
      buf += c;
      i++;
      continue;
    }
    const close = findClose(s, i + 1);
    if (close < 0) {
      buf += s.slice(i);
      i = s.length;
      break;
    }
    if (buf.length > 0) {
      out.push({ kind: 'text', value: buf });
      buf = '';
    }
    out.push({ kind: 'math', value: s.slice(i + 1, close) });
    i = close + 1;
  }
  if (buf.length > 0) out.push({ kind: 'text', value: buf });
  return out;
}

function findClose(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '$') return i;
  }
  return -1;
}

// Heuristic math-fragment detector for un-delimited legacy strings. Catches
// the four shapes the actuary model emits in practice:
//   - backslash macros:                \annimm{n}
//   - exponentiation with braces:      1.085^{-7}
//   - parenthesised expressions with operators (and an optional result):
//     (1 - 1.085^{-7})/0.085 = 4.92
//   - single-letter var = number:      i = 0.085  ·  n = 7
// Multi-letter words like "PV factor" or "Endowment" are NOT matched (the
// `\b` + single-letter constraint on the var=num pattern is the guard).
function splitAuto(s: string): Segment[] {
  const re =
    /\\[a-zA-Z]+(?:\{[^}]*\})*|\([^()]*\d[^()]*\)(?:\s*[/*+\-]\s*[-+]?[\d.()]+)*(?:\s*=\s*[-+]?[\d.]+)?|[\w.()]+\^\{[^}]+\}|\b[a-zA-Z]\s*=\s*[-+]?[\d.]+\b/g;
  const out: Segment[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > pos) {
      out.push({ kind: 'text', value: s.slice(pos, m.index) });
    }
    out.push({ kind: 'math', value: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < s.length) out.push({ kind: 'text', value: s.slice(pos) });
  // If nothing matched, return the whole string as one text segment.
  return out.length > 0 ? out : [{ kind: 'text', value: s }];
}

function InlineMath({ latex }: { latex: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(latex, ref.current, {
        throwOnError: false,
        displayMode: false,
        strict: 'ignore',
        output: 'html',
        macros: { ...ACTUARIAL_MACROS },
      });
    } catch {
      if (ref.current) ref.current.textContent = latex;
    }
  }, [latex]);
  return <span className="math-inline" ref={ref} />;
}
