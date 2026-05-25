// Outline sidebar tab — calls textDocument/documentSymbol on the
// active editor file and renders a hierarchical clickable tree
// (classes → methods, modules → functions). Click jumps to the
// symbol's range via the existing pendingJump flow.
//
// The two language servers we ship (Pyright + R languageserver) both
// support the hierarchical variant of documentSymbol so we can render a
// real tree instead of the flat SymbolInformation[] fallback. We
// degrade gracefully if either server returns the flat shape.

import { useEffect, useRef, useState } from "react";
import { getLspClient } from "../../lib/lspClient";
import { isDesktopIDE, type LspLang } from "../../lib/sceloIDE";

export interface OutlineNode {
  name: string;
  kind: number;
  detail?: string;
  /** 0-based LSP line of the symbol's NAME (used for go-to). */
  line: number;
  /** Full 0-based LSP range covering the symbol's body (used for the
   *  caret-contains check that drives outline highlighting + the
   *  breadcrumb bar on the editor). */
  range: { startLine: number; endLine: number };
  children: OutlineNode[];
}

interface Props {
  activeFile: string | null;
  onOpenAtLine: (relPath: string, line: number) => void;
  /** 1-based caret line in the active editor; OutlinePanel highlights
   *  the deepest symbol whose range contains it. Null when no editor
   *  is mounted. */
  caretLine?: number | null;
  /** Notified whenever the outline is re-parsed so callers can derive
   *  the breadcrumb path for the caret line. */
  onOutlineChange?: (nodes: OutlineNode[]) => void;
  /** When the parent already holds an outline tree for this file (the
   *  Workspace route fetches it eagerly so Cmd+Shift+P + the breadcrumb
   *  work without OutlinePanel being mounted), pass it in to skip the
   *  duplicate documentSymbol request. */
  externalOutline?: OutlineNode[];
}

const KIND_ICON: Record<number, string> = {
  2: "M",   // Module
  5: "C",   // Class
  6: "m",   // Method
  9: "f",   // Constructor
  10: "E",  // Enum
  11: "I",  // Interface
  12: "ƒ",  // Function
  13: "v",  // Variable
  14: "k",  // Constant
  22: "S",  // Struct
};

export default function OutlinePanel({
  activeFile,
  onOpenAtLine,
  caretLine,
  onOutlineChange,
  externalOutline,
}: Props) {
  const [nodes, setNodes] = useState<OutlineNode[]>(externalOutline ?? []);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | { error: string }>(
    externalOutline && externalOutline.length > 0 ? "ready" : "idle",
  );

  // When the parent already supplies an outline tree, mirror it into
  // local state + flip status; skip the LSP call entirely.
  useEffect(() => {
    if (!externalOutline) return;
    setNodes(externalOutline);
    setStatus(externalOutline.length > 0 ? "ready" : "ready");
  }, [externalOutline]);

  useEffect(() => {
    if (externalOutline) return; // parent owns the outline; nothing to fetch
    if (!isDesktopIDE() || !activeFile) {
      setNodes([]);
      setStatus("idle");
      onOutlineChange?.([]);
      return;
    }
    const lang = langForPath(activeFile);
    if (!lang) {
      setNodes([]);
      setStatus("idle");
      onOutlineChange?.([]);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    const uri = `scelo://workspace/${activeFile.replace(/^\/+/, "")}`;
    getLspClient(lang)
      .request("textDocument/documentSymbol", { textDocument: { uri } })
      .then((result) => {
        if (cancelled) return;
        const tree = parseSymbols(result);
        setNodes(tree);
        setStatus("ready");
        onOutlineChange?.(tree);
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus({ error: String(err) });
        onOutlineChange?.([]);
      });
    return () => {
      cancelled = true;
    };
    // onOutlineChange ref-stable in practice; we don't depend on it to
    // avoid re-issuing documentSymbol on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  // Deepest-symbol-containing-caret path (1-based caret line → 0-based
  // LSP range). Used both to highlight the active node and to surface
  // the breadcrumb in the editor.
  const activePath = caretLine != null ? deepestPath(nodes, caretLine - 1) : [];
  const activeKey = activePath.length > 0 ? activePath[activePath.length - 1] : null;

  // Auto-scroll the tree so the active button stays in view as the
  // caret moves through a large file. `scrollIntoView` with
  // block: "nearest" only scrolls when the element is actually off-
  // screen — no jitter when the active symbol is already visible.
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (activeKey == null) return;
    activeBtnRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeKey]);

  if (!isDesktopIDE()) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Outline is only available inside Scelo IDE.
      </div>
    );
  }

  if (!activeFile) {
    return (
      <div className="p-3 text-xs text-fg-mute">
        Open a file in the editor to see its outline.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg-2 text-fg">
      <div className="border-b border-border px-3 py-1">
        <div className="text-[10px] uppercase tracking-wider text-fg-mute">outline</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-fg-mute">{activeFile}</div>
      </div>
      <div className="flex-1 overflow-auto p-1 text-xs">
        {status === "loading" && <div className="px-2 py-1 text-fg-mute">parsing…</div>}
        {typeof status === "object" && (
          <div className="px-2 py-1 text-adversarial">error: {status.error}</div>
        )}
        {status === "ready" && nodes.length === 0 && (
          <div className="px-2 py-1 text-fg-mute">no symbols in this file</div>
        )}
        {status === "ready" && nodes.length > 0 && (
          <Tree
            nodes={nodes}
            depth={0}
            activeKey={activeKey}
            activeRef={activeBtnRef}
            onClick={(line) => activeFile && onOpenAtLine(activeFile, line)}
          />
        )}
      </div>
    </div>
  );
}

function Tree({
  nodes,
  depth,
  activeKey,
  activeRef,
  onClick,
}: {
  nodes: OutlineNode[];
  depth: number;
  activeKey: string | null;
  activeRef: React.MutableRefObject<HTMLButtonElement | null>;
  onClick: (line: number) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((n, i) => {
        const key = nodeKey(n, i, depth);
        const isActive = key === activeKey;
        return (
          <li key={key}>
            <button
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => onClick(n.line + 1)}
              className={`flex w-full items-baseline gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-bg ${
                isActive ? "bg-bg ring-1 ring-fg/40" : ""
              }`}
              style={{ paddingLeft: `${depth * 10 + 4}px` }}
            >
              <span className="inline-block w-3 text-center text-fg-mute" title={`kind ${n.kind}`}>
                {KIND_ICON[n.kind] ?? "·"}
              </span>
              <span className={`font-mono ${isActive ? "font-medium text-fg" : "text-fg"}`}>
                {n.name}
              </span>
              {n.detail && (
                <span className="ml-1 truncate font-mono text-[10px] text-fg-mute opacity-70">
                  {n.detail}
                </span>
              )}
            </button>
            {n.children.length > 0 && (
              <Tree
                nodes={n.children}
                depth={depth + 1}
                activeKey={activeKey}
                activeRef={activeRef}
                onClick={onClick}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function nodeKey(n: OutlineNode, i: number, depth: number): string {
  return `${depth}:${n.line}:${n.name}:${i}`;
}

/** Walk the tree, return the keys of the deepest containment chain
 *  for the given 0-based caret line. Empty array = caret is outside
 *  any symbol's range. */
function deepestPath(nodes: OutlineNode[], caretLine0: number): string[] {
  const acc: string[] = [];
  walk(nodes, 0, acc);
  return acc;

  function walk(level: OutlineNode[], depth: number, out: string[]): void {
    for (let i = 0; i < level.length; i++) {
      const n = level[i];
      if (caretLine0 < n.range.startLine || caretLine0 > n.range.endLine) continue;
      out.push(nodeKey(n, i, depth));
      if (n.children.length > 0) walk(n.children, depth + 1, out);
      return; // first containing sibling wins at this level
    }
  }
}

/** Public for Workspace.tsx: derive the breadcrumb labels for the caret
 *  line. Returns names from outermost → innermost. */
export function breadcrumbFor(nodes: OutlineNode[], caretLine1: number): string[] {
  const labels: string[] = [];
  const caretLine0 = caretLine1 - 1;
  let level: OutlineNode[] = nodes;
  while (true) {
    const hit = level.find(
      (n) => caretLine0 >= n.range.startLine && caretLine0 <= n.range.endLine,
    );
    if (!hit) break;
    labels.push(hit.name);
    level = hit.children;
  }
  return labels;
}

function langForPath(p: string): LspLang | null {
  const lower = p.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".r")) return "r";
  return null;
}

/** Parse either the hierarchical (DocumentSymbol[]) or flat
 *  (SymbolInformation[]) shape the LSP can return. Both go into the
 *  same OutlineNode tree so the renderer doesn't care which arrived. */
function parseSymbols(result: unknown): OutlineNode[] {
  if (!Array.isArray(result)) return [];
  // Hierarchical entries carry a top-level `range` per the spec and
  // optional `children`. SymbolInformation has a `location.uri` instead.
  const first = result[0] as Record<string, unknown> | undefined;
  if (first && "range" in first) {
    return (result as Array<DocumentSymbolWire>).map(toNode);
  }
  // Flat SymbolInformation[] — group by containerName so we still get a
  // (best-effort) two-level tree. Pyright + languageserver both go
  // hierarchical so this branch is mostly a safety net.
  const byContainer = new Map<string, OutlineNode[]>();
  for (const raw of result as Array<SymbolInformationWire>) {
    const node: OutlineNode = {
      name: raw.name,
      kind: raw.kind,
      line: raw.location.range.start.line,
      range: {
        startLine: raw.location.range.start.line,
        endLine: raw.location.range.end.line,
      },
      children: [],
    };
    const key = raw.containerName ?? "";
    const arr = byContainer.get(key);
    if (arr) arr.push(node);
    else byContainer.set(key, [node]);
  }
  const root = byContainer.get("") ?? [];
  for (const n of root) {
    n.children = byContainer.get(n.name) ?? [];
  }
  return root;
}

interface DocumentSymbolWire {
  name: string;
  kind: number;
  detail?: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: DocumentSymbolWire[];
}

interface SymbolInformationWire {
  name: string;
  kind: number;
  containerName?: string;
  location: {
    uri: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  };
}

function toNode(d: DocumentSymbolWire): OutlineNode {
  return {
    name: d.name,
    kind: d.kind,
    detail: d.detail,
    line: (d.selectionRange ?? d.range).start.line,
    range: { startLine: d.range.start.line, endLine: d.range.end.line },
    children: (d.children ?? []).map(toNode),
  };
}
