// Cmd/Ctrl-T symbol-level palette.
//
// Owns the LSP `workspace/symbol` query (debounced 150 ms; both Python
// + R servers queried in parallel); defers to the shared `<Palette>`
// for the modal shell. Unlike QuickOpen / CommandPalette, the items
// arrive pre-ranked by the server — no client-side fuzzy filter.

import { useEffect, useRef, useState } from "react";
import { getLspClient } from "../../lib/lspClient";
import { isDesktopIDE, type LspLang } from "../../lib/sceloIDE";
import Palette from "./Palette";

interface SymbolHit {
  lang: LspLang;
  name: string;
  kind: number;
  containerName?: string;
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface Props {
  workspacePath: string | null;
  onOpenAtLine: (relPath: string, line: number) => void;
  onClose: () => void;
}

// LSP symbol kinds (subset we care about); see
// https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
const KIND_ICON: Record<number, string> = {
  5: "C",
  6: "M",
  9: "f",
  10: "E",
  11: "I",
  12: "ƒ",
  13: "v",
  14: "k",
  22: "S",
};

export default function SymbolPalette({ workspacePath, onOpenAtLine, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isDesktopIDE() || !workspacePath) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      const langs: LspLang[] = ["python", "r"];
      const all = await Promise.all(
        langs.map(async (lang) => {
          try {
            const result = (await getLspClient(lang).request("workspace/symbol", {
              query,
            })) as null | Array<{
              name: string;
              kind: number;
              containerName?: string;
              location: {
                uri: string;
                range: {
                  start: { line: number; character: number };
                  end: { line: number; character: number };
                };
              };
            }>;
            return (result ?? []).map(
              (s): SymbolHit => ({
                lang,
                name: s.name,
                kind: s.kind,
                containerName: s.containerName,
                uri: s.location.uri,
                range: s.location.range,
              }),
            );
          } catch {
            return [] as SymbolHit[];
          }
        }),
      );
      setResults(all.flat().slice(0, 80));
      setSearching(false);
    }, 150);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query, workspacePath]);

  return (
    <Palette<SymbolHit>
      items={results}
      getKey={(s) => `${s.uri}:${s.range.start.line}:${s.name}`}
      renderItem={(s) => (
        <div className="flex items-baseline gap-2 font-mono">
          <span
            className="inline-block w-4 text-center text-fg-mute"
            title={`LSP kind ${s.kind}`}
          >
            {KIND_ICON[s.kind] ?? "·"}
          </span>
          <span className="text-fg">{s.name}</span>
          {s.containerName && (
            <span className="text-fg-mute opacity-70">in {s.containerName}</span>
          )}
          <span className="ml-auto truncate text-[10px] text-fg-mute opacity-70">
            {uriToRel(s.uri, workspacePath)}:{s.range.start.line + 1}
          </span>
        </div>
      )}
      onSelect={(s) => onOpenAtLine(uriToRel(s.uri, workspacePath), s.range.start.line + 1)}
      onClose={onClose}
      placeholder="Symbol name (Pyright + R languageserver)"
      ariaLabel="Symbol palette"
      onQueryChange={setQuery}
      summary={
        searching
          ? "searching…"
          : !query.trim()
            ? "type to search workspace symbols"
            : results.length === 0
              ? "no matches"
              : `${results.length} symbol${results.length === 1 ? "" : "s"}`
      }
    />
  );
}

function uriToRel(uri: string, workspacePath: string | null): string {
  if (!workspacePath) return uri;
  const stripped = uri.replace(/^file:\/\//, "").replace(/^scelo:\/\/workspace\//, "");
  const trim = workspacePath.endsWith("/") ? workspacePath : workspacePath + "/";
  return stripped.startsWith(trim) ? stripped.slice(trim.length) : stripped;
}
