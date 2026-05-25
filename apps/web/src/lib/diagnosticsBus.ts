// Workspace-wide diagnostics roll-up. EditorPanel still does the
// authoritative `setModelMarkers` for the active file; this bus is a
// parallel pub/sub that lets the Problems panel render every file's
// diagnostics in one list without having to mount Monaco models for
// each one.
//
// Keys are workspace-relative paths (matching how the editor exposes
// them everywhere else). Empty arrays are kept so consumers can tell
// "lsp ran and reported clean" from "no data yet".

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  /** 0-indexed, matching LSP. Consumers add 1 for display. */
  line: number;
  /** 0-indexed character offset on `line`. */
  character: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Originating LSP, e.g. "pyright" / "languageserver". */
  source: string;
  /** Optional rule id, e.g. "reportMissingImports". */
  code?: string;
}

type Listener = (snap: Map<string, Diagnostic[]>) => void;

const snapshot = new Map<string, Diagnostic[]>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn(snapshot);
}

export function publishDiagnostics(path: string, diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0 && !snapshot.has(path)) return;
  snapshot.set(path, diagnostics);
  emit();
}

export function getAllDiagnostics(): Map<string, Diagnostic[]> {
  return snapshot;
}

export function subscribeDiagnostics(fn: Listener): () => void {
  listeners.add(fn);
  fn(snapshot);
  return () => {
    listeners.delete(fn);
  };
}

/** Drop everything we've collected. Called on workspace switch so the
 *  previous repo's diagnostics don't show in the next one's panel. */
export function resetDiagnostics(): void {
  if (snapshot.size === 0) return;
  snapshot.clear();
  emit();
}

export function severityFromLsp(n: number | undefined): DiagnosticSeverity {
  switch (n) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 4:
      return "hint";
    default:
      return "info";
  }
}
