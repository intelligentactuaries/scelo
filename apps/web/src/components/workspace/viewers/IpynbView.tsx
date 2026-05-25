// Read-only Jupyter notebook viewer. Parses the .ipynb JSON and
// renders each cell as either:
//   * markdown cell  : rendered via MarkdownBlock
//   * code cell      : highlighted source + text/stream outputs below
//
// Image outputs (PNG, JPEG) and rich HTML/JS outputs are out of scope
// for this phase; those cells get a "[image output omitted]" /
// "[rich output omitted]" placeholder so the user knows the cell
// isn't broken.
//
// Editing is not supported : "Source" mode in the editor toggle is
// the escape hatch for fields like execution counts and cell IDs.

import { useMemo } from "react";
import { MarkdownBlock } from "../../Message/MarkdownBlock";

interface Props {
  path: string;
  buffer: string;
}

interface Cell {
  cell_type: "code" | "markdown" | "raw";
  source: string[] | string;
  execution_count?: number | null;
  outputs?: Output[];
}

interface Output {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: string;
  text?: string[] | string;
  data?: Record<string, string[] | string>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Notebook {
  cells?: Cell[];
  metadata?: {
    kernelspec?: { name?: string; display_name?: string; language?: string };
    language_info?: { name?: string };
  };
}

export default function IpynbView({ buffer }: Props) {
  const parsed = useMemo<{ nb: Notebook | null; error: string | null }>(
    () => {
      try {
        return { nb: JSON.parse(buffer) as Notebook, error: null };
      } catch (e) {
        return { nb: null, error: String(e) };
      }
    },
    [buffer],
  );

  if (parsed.error) {
    return (
      <div className="p-4 text-xs text-error">
        Failed to parse notebook JSON: {parsed.error}
      </div>
    );
  }
  const nb = parsed.nb!;
  const lang =
    nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "python";
  const cells = nb.cells ?? [];

  return (
    <div className="h-full overflow-auto bg-bg">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <header className="flex items-baseline justify-between border-b border-border pb-2">
          <span className="font-mono text-[11px] text-fg-mute">
            {cells.length} cell{cells.length === 1 ? "" : "s"}
          </span>
          <span className="font-mono text-[11px] text-fg-mute">
            kernel: {nb.metadata?.kernelspec?.display_name ?? lang}
          </span>
        </header>
        {cells.map((cell, i) => (
          <CellView key={i} cell={cell} language={lang} index={i} />
        ))}
      </div>
    </div>
  );
}

function CellView({
  cell,
  language,
  index,
}: {
  cell: Cell;
  language: string;
  index: number;
}) {
  const src = sourceToString(cell.source);
  if (cell.cell_type === "markdown") {
    return (
      <article className="rounded border border-transparent px-2 py-1 hover:border-border">
        <MarkdownBlock>{src}</MarkdownBlock>
      </article>
    );
  }
  if (cell.cell_type === "raw") {
    return (
      <pre className="rounded border border-border bg-bg-2 p-3 text-[11px] text-fg-mute">
        {src}
      </pre>
    );
  }
  // code
  return (
    <article className="rounded border border-border bg-bg-2">
      <header className="flex items-baseline justify-between border-b border-border px-2 py-1 font-mono text-[10px] text-fg-mute">
        <span>
          [{cell.execution_count == null ? " " : cell.execution_count}] cell {index + 1}
        </span>
        <span>{language}</span>
      </header>
      <pre className="m-0 overflow-auto px-3 py-2 font-mono text-[11px] text-fg">
        {src}
      </pre>
      {cell.outputs && cell.outputs.length > 0 && (
        <section className="border-t border-border bg-bg px-3 py-2 text-[11px]">
          {cell.outputs.map((o, i) => (
            <OutputView key={i} output={o} />
          ))}
        </section>
      )}
    </article>
  );
}

function OutputView({ output }: { output: Output }) {
  switch (output.output_type) {
    case "stream": {
      const stream = sourceToString(output.text ?? "");
      const color = output.name === "stderr" ? "text-error" : "text-fg";
      return <pre className={`m-0 whitespace-pre-wrap font-mono ${color}`}>{stream}</pre>;
    }
    case "error": {
      const tb = (output.traceback ?? []).join("\n");
      return (
        <pre className="m-0 whitespace-pre-wrap font-mono text-error">
          {output.ename}: {output.evalue}
          {tb && `\n${stripAnsi(tb)}`}
        </pre>
      );
    }
    case "execute_result":
    case "display_data": {
      const data = output.data ?? {};
      // Jupyter precedence : richer wins, then fall back. We diverge
      // slightly from Jupyter Lab by preferring images over text/plain
      // (a matplotlib cell typically ships both; the image is what
      // the user wants).
      if (data["image/png"]) {
        return <ImgOutput mime="image/png" data={data["image/png"]} />;
      }
      if (data["image/jpeg"]) {
        return <ImgOutput mime="image/jpeg" data={data["image/jpeg"]} />;
      }
      if (data["image/svg+xml"]) {
        return <SvgOutput svg={sourceToString(data["image/svg+xml"])} />;
      }
      if (data["text/html"]) {
        return <HtmlOutput html={sourceToString(data["text/html"])} />;
      }
      if (data["text/plain"]) {
        return (
          <pre className="m-0 whitespace-pre-wrap font-mono text-fg">
            {sourceToString(data["text/plain"])}
          </pre>
        );
      }
      const mimes = Object.keys(data).join(", ") || "no data";
      return (
        <p className="m-0 italic text-fg-mute">
          [unsupported output mimetype : {mimes}]
        </p>
      );
    }
    default:
      return null;
  }
}

function ImgOutput({ mime, data }: { mime: string; data: string[] | string }) {
  // Notebook image payloads are already base64 with no `data:` prefix;
  // we add it here so <img> can render directly.
  const b64 = sourceToString(data).replace(/\s+/g, "");
  return (
    <img
      src={`data:${mime};base64,${b64}`}
      alt="notebook output"
      className="m-0 max-w-full bg-white"
    />
  );
}

function SvgOutput({ svg }: { svg: string }) {
  // Inline SVG is markup, not base64. Wrap with a div + dangerouslySet
  // : svg is the "trusted" image mimetype in Jupyter's typeset, no
  // sandbox needed beyond keeping it inside the div.
  return (
    <div
      className="m-0 max-w-full bg-white"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: notebook SVGs are inert markup
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function HtmlOutput({ html }: { html: string }) {
  // text/html in a notebook can contain <script>, third-party JS,
  // tracking pixels — anything. Sandbox via srcdoc + `sandbox=""`
  // (an empty sandbox attribute is the most restrictive setting :
  // no scripts, no same-origin, no popups) so a malicious / merely
  // weird notebook can't reach the IDE renderer.
  return (
    <iframe
      title="notebook html output"
      srcDoc={html}
      sandbox=""
      className="m-0 h-48 w-full border border-border bg-white"
    />
  );
}

function sourceToString(s: string[] | string): string {
  return Array.isArray(s) ? s.join("") : s;
}

// Notebook tracebacks come pre-formatted with ANSI escape sequences;
// strip them so the plain-text rendering doesn't look like garbage.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}
