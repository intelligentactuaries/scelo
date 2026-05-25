// Typed wiki client + a minimal markdown renderer.
//
// We deliberately avoid adding react-markdown as a dependency: the wiki bodies
// use a small subset of Markdown (headings, paragraphs, fenced code, inline
// code, bold/italic, links, ordered/unordered lists, tables, plus inline `$…$`
// and block ```math / $$…$$``` math via KaTeX) and a focused renderer keeps
// the bundle lean. Anything more exotic in an entry will fall through as
// plain text rather than break the page.

import "katex/dist/katex.min.css";
import katex from "katex";

const ENV_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
const BASE = ENV_BASE && ENV_BASE.length > 0 ? ENV_BASE : "/api";

export type WikiEntrySummary = {
  id: string;
  title: string;
  section: string;
  tags: string[];
  last_updated: string;
};

export type WikiRelated = {
  id: string;
  title: string;
  exists: boolean;
};

export type WikiEntry = WikiEntrySummary & {
  body: string;
  related: WikiRelated[];
  authoritative_source: string | null;
  external_references: string[];
  path: string;
};

export type WikiSearchResult = WikiEntrySummary & {
  score: number;
  snippet: string;
};

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

export async function listEntries(): Promise<{
  n_entries: number;
  semantic_available: boolean;
  entries: WikiEntrySummary[];
}> {
  return getJson("/wiki");
}

export async function getEntry(id: string): Promise<WikiEntry> {
  return getJson(`/wiki/${encodeURI(id)}`);
}

export async function searchWiki(
  q: string,
  k = 10,
): Promise<{ query: string; mode: string; n: number; results: WikiSearchResult[] }> {
  return getJson(`/wiki/search?q=${encodeURIComponent(q)}&k=${k}&mode=hybrid`);
}

export async function listSections(): Promise<{ sections: { name: string; count: number }[] }> {
  return getJson("/wiki/sections");
}

// ── markdown rendering ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMath(tex: string): string {
  try {
    return katex.renderToString(tex, { displayMode: false, throwOnError: false });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

function renderBlockMath(tex: string): string {
  try {
    return `<div class="my-3 overflow-x-auto">${katex.renderToString(tex, {
      displayMode: true,
      throwOnError: false,
    })}</div>`;
  } catch {
    return `<pre class="my-3 overflow-x-auto rounded border border-border bg-bg-2 p-3 text-xs"><code>${escapeHtml(tex)}</code></pre>`;
  }
}

function inlineMd(s: string): string {
  // Inline code first so its contents aren't further transformed.
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        const code = escapeHtml(s.slice(i + 1, end));
        out += `<code class="text-primary">${code}</code>`;
        i = end + 1;
        continue;
      }
    }
    // Inline math `$…$` — closing $ must be on the same line and preceded by
    // a non-space character (mirrors the GitHub / MathJax rule). Skips price
    // strings like "Returns $5 to $10" because the $ before/after a number
    // typically has whitespace around it.
    if (s[i] === "$" && i + 1 < s.length && s[i + 1] !== " " && s[i + 1] !== "\t") {
      let end = -1;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === "\n") break;
        if (s[j] === "$" && s[j - 1] !== " " && s[j - 1] !== "\t" && s[j - 1] !== "\\") {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        out += renderInlineMath(s.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    // Markdown link [text](url)
    if (s[i] === "[") {
      const close = s.indexOf("]", i + 1);
      if (close > i && s[close + 1] === "(") {
        const urlEnd = s.indexOf(")", close + 2);
        if (urlEnd > close + 1) {
          const text = inlineFormatting(escapeHtml(s.slice(i + 1, close)));
          const url = s.slice(close + 2, urlEnd);
          // Internal wiki link if it points to another wiki entry id-style.
          const internal = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(url);
          const href = internal ? `#/wiki/${url}` : url;
          const target = internal || url.startsWith("#") ? "" : ' target="_blank" rel="noreferrer"';
          out += `<a href="${href}" class="text-primary hover:underline"${target}>${text}</a>`;
          i = urlEnd + 1;
          continue;
        }
      }
    }
    out += escapeHtml(s[i]);
    i++;
  }
  return inlineFormatting(out, /* alreadyEscaped */ true);
}

function inlineFormatting(s: string, alreadyEscaped = false): string {
  let t = alreadyEscaped ? s : escapeHtml(s);
  // **bold**
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-fg">$1</strong>');
  // _italic_ (avoid clashing with words containing underscores in code-like text — already handled because code went first)
  t = t.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
  // *italic* (single asterisk, narrow)
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return t;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "pre"; code: string; lang: string }
  | { kind: "math"; tex: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;
  const flushParagraph = (buf: string[]) => {
    if (buf.length === 0) return;
    out.push({ kind: "p", text: buf.join(" ") });
    buf.length = 0;
  };

  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    // Fenced code (or fenced math when lang === "math")
    if (line.startsWith("```")) {
      flushParagraph(para);
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      if (lang === "math") {
        out.push({ kind: "math", tex: codeLines.join("\n") });
      } else {
        out.push({ kind: "pre", code: codeLines.join("\n"), lang });
      }
      continue;
    }
    // Display math `$$…$$` block — supports either single-line `$$X$$` or
    // multi-line. Must be on its own line (no leading prose) to avoid
    // catching mid-paragraph dollar pairs.
    if (line.startsWith("$$")) {
      flushParagraph(para);
      const trimmed = line.trim();
      if (trimmed.length >= 4 && trimmed.endsWith("$$")) {
        // Single-line $$X$$
        out.push({ kind: "math", tex: trimmed.slice(2, -2).trim() });
        i++;
        continue;
      }
      // Multi-line: collect until a line ending with $$
      const texLines: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trimEnd().endsWith("$$")) {
          texLines.push(l.trimEnd().slice(0, -2));
          i++;
          break;
        }
        texLines.push(l);
        i++;
      }
      out.push({ kind: "math", tex: texLines.join("\n").trim() });
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushParagraph(para);
      out.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // hr
    if (/^---+\s*$/.test(line)) {
      flushParagraph(para);
      out.push({ kind: "hr" });
      i++;
      continue;
    }
    // Table — header | --- |
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      flushParagraph(para);
      const split = (s: string) =>
        s
          .replace(/^\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim());
      const head = split(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(split(lines[i]));
        i++;
      }
      out.push({ kind: "table", head, rows });
      continue;
    }
    // List
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph(para);
      const isUl = !!ul;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = isUl ? /^[-*]\s+(.*)$/.exec(l) : /^\d+\.\s+(.*)$/.exec(l);
        if (m) {
          items.push(m[1]);
          i++;
        } else if (l.startsWith("  ") && items.length > 0) {
          // continuation of previous item
          items[items.length - 1] += ` ${l.trim()}`;
          i++;
        } else {
          break;
        }
      }
      out.push(isUl ? { kind: "ul", items } : { kind: "ol", items });
      continue;
    }
    // Blank line
    if (line.trim() === "") {
      flushParagraph(para);
      i++;
      continue;
    }
    // Paragraph accumulator
    para.push(line);
    i++;
  }
  flushParagraph(para);
  return out;
}

export function renderMarkdownHtml(md: string): string {
  const blocks = parseBlocks(md);
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h":
        parts.push(
          `<h${b.level} class="mt-6 mb-2 ${b.level === 1 ? "text-xl" : b.level === 2 ? "text-lg" : "text-base"} text-fg">${inlineMd(b.text)}</h${b.level}>`,
        );
        break;
      case "p":
        parts.push(`<p class="my-2 leading-relaxed">${inlineMd(b.text)}</p>`);
        break;
      case "pre":
        parts.push(
          `<pre class="my-3 overflow-x-auto rounded border border-border bg-bg-2 p-3 text-xs"><code>${escapeHtml(b.code)}</code></pre>`,
        );
        break;
      case "math":
        parts.push(renderBlockMath(b.tex));
        break;
      case "ul":
        parts.push(
          `<ul class="my-2 ml-5 list-disc space-y-1">${b.items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ul>`,
        );
        break;
      case "ol":
        parts.push(
          `<ol class="my-2 ml-5 list-decimal space-y-1">${b.items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</ol>`,
        );
        break;
      case "table":
        parts.push(
          `<table class="my-3 w-full border-collapse text-sm"><thead><tr>${b.head
            .map(
              (h) =>
                `<th class="border-b border-border px-2 py-1 text-left text-fg-mute">${inlineMd(h)}</th>`,
            )
            .join("")}</tr></thead><tbody>${b.rows
            .map(
              (r) =>
                `<tr>${r.map((c) => `<td class="border-b border-border/50 px-2 py-1">${inlineMd(c)}</td>`).join("")}</tr>`,
            )
            .join("")}</tbody></table>`,
        );
        break;
      case "hr":
        parts.push('<hr class="my-4 border-border" />');
        break;
    }
  }
  return parts.join("\n");
}

export function highlightSnippet(snippet: string, query: string): string {
  if (!query.trim()) return escapeHtml(snippet);
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  let html = escapeHtml(snippet);
  for (const t of tokens) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, '<mark class="bg-primary/20 text-primary">$1</mark>');
  }
  return html;
}
