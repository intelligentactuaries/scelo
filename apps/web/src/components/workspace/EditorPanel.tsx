// Monaco editor panel for the Scelo IDE workspace.
//
// Loads the file via window.scelo.fs.read, edits in Monaco, saves via
// window.scelo.fs.write. Language is inferred from file extension —
// Monaco's catalog covers everything an actuary is likely to open
// (.py, .r, .R, .ipynb, .md, .json, .yaml, .toml, .sql, .ts, .tsx, .csv …).
//
// We don't try to be a full editor experience (no LSP, no linting, no
// snippets) — that's the editor's own follow-up phase. The bar is: open
// a script the user just wrote in the terminal, tweak it, save, re-run
// in the terminal panel below.

import Editor, { DiffEditor, type OnChange, type OnMount } from "@monaco-editor/react";
import type * as monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeApplyToEditor } from "../../lib/applyToEditorBus";
import {
  publishDiagnostics as publishToBus,
  severityFromLsp,
  type Diagnostic as BusDiagnostic,
} from "../../lib/diagnosticsBus";
import { setEditorSelection } from "../../lib/editorSelectionBus";
import { subscribeToggleViewer } from "../../lib/editorViewerBus";
import { getGitStatus, subscribeGit } from "../../lib/gitBus";
import { snippetsFor, type SnippetLang } from "../../lib/snippets";
import { refreshGit } from "../../lib/gitBus";
import { languageFor } from "../../lib/languageFor";
import { getLspClient } from "../../lib/lspClient";
import {
  isDesktopIDE,
  type PyrightDiagnostic,
  type RLintDiagnostic,
} from "../../lib/sceloIDE";
import { emitToast } from "../../lib/toastBus";
import { viewerFor, type ViewerDescriptor } from "./viewers/registry";

interface Props {
  path: string | null;
  /** When set + matches the active path, the editor scrolls to + selects
   *  the line on next render. Cleared via onJumpHandled so the request
   *  fires exactly once. Used by the find-in-files panel to deep-link. */
  jumpToLine?: number | null;
  onJumpHandled?: () => void;
  /** Optional breadcrumb labels rendered above the editor — outermost →
   *  innermost symbol containing the caret. Owned by Workspace.tsx so
   *  it can derive the path from the outline tree. */
  breadcrumb?: string[];
  /** Notified on every cursor-position change. 1-based line. */
  onCaretChange?: (line: number) => void;
  /** Notified on every buffer mutation. Workspace.tsx uses this to:
   *   (a) slice line previews for the Cmd+Shift+P palette, and
   *   (b) debounce-refresh the outline so the breadcrumb tracks
   *       edits-in-progress, not just the last on-disk version. */
  onBufferChange?: (text: string) => void;
}

type Status = "idle" | "loading" | "ready" | "saving" | "saved" | { error: string };

export default function EditorPanel({
  path,
  jumpToLine,
  onJumpHandled,
  breadcrumb,
  onCaretChange,
  onBufferChange,
}: Props) {
  // Toasts now ride a global event bus (lib/toastBus) so non-editor
  // surfaces can fire them too; the single workspace-level ToastTray
  // owns the render + dismiss lifecycle.
  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [lintNote, setLintNote] = useState<string | null>(null);
  // Live ref for the active path so the Monaco selection callback
  // (bound once at mount) can read the *current* path rather than
  // closing over a stale one.
  const pathRef = useRef<string | null>(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  // ── Git diff mode ────────────────────────────────────────────────
  // Diff trumps the rich viewer when both could fire. We only enable
  // the toggle when the active file actually has worktree changes,
  // and we cache the HEAD blob per (path, HEAD sha) so flipping the
  // toggle doesn't re-spawn git on every click.
  const [diffMode, setDiffMode] = useState<boolean>(false);
  const [headContent, setHeadContent] = useState<string | null>(null);
  const headCacheRef = useRef<{ path: string; sha: string; content: string } | null>(null);
  const [gitFiles, setGitFiles] = useState(() => getGitStatus()?.files ?? []);
  useEffect(
    () => subscribeGit((s) => setGitFiles(s?.files ?? [])),
    [],
  );
  // Diff toggle visibility: only when the active path appears in the
  // git status list with a worktree change (or it's a new file: index "?").
  const hasGitChanges =
    !!path &&
    gitFiles.some(
      (f) =>
        f.path === path && (f.worktree !== " " || f.index === "?" || f.index !== " "),
    );
  useEffect(() => {
    // Reset on file switch.
    setDiffMode(false);
    setHeadContent(null);
  }, [path]);
  useEffect(() => {
    if (!diffMode || !path) return;
    // Use cached HEAD if the cache matches; otherwise fetch + cache.
    const cur = getGitStatus();
    const cacheKey = `${path}|${cur?.branch ?? ""}`;
    const cached = headCacheRef.current;
    if (cached && cached.path === path && cached.sha === cacheKey) {
      setHeadContent(cached.content);
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await window.scelo!.git.show(path);
      if (cancelled) return;
      const content = r.content ?? "";
      headCacheRef.current = { path, sha: cacheKey, content };
      setHeadContent(content);
    })();
    return () => {
      cancelled = true;
    };
  }, [diffMode, path]);
  // The active rich viewer for this path (CSV table / MD preview /
  // notebook). null when no viewer registered.
  const viewer: ViewerDescriptor | null = viewerFor(path);
  // For "alt" viewers we default ON (the rich view is the better
  // first impression for CSV / .ipynb). For "preview" (markdown) we
  // default OFF since source editing is the primary use. Resets on
  // every path change.
  const [viewerActive, setViewerActive] = useState<boolean>(
    () => !!viewer && viewer.kind === "alt",
  );
  useEffect(() => {
    setViewerActive(!!viewer && viewer.kind === "alt");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  // Cmd-Shift-V + the "View: Toggle Preview" palette command emit
  // through editorViewerBus; we only flip when this editor has a
  // viewer registered for the path (other extensions ignore the ping).
  useEffect(
    () =>
      subscribeToggleViewer(() => {
        if (viewer) setViewerActive((v) => !v);
      }),
    [viewer],
  );
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monaco | null>(null);

  const onMount: OnMount = (ed, m) => {
    editorRef.current = ed;
    monacoRef.current = m;
    if (isDesktopIDE()) {
      registerLspProviders(m, "python");
      registerLspProviders(m, "r");
    }
    // Emit caret-line changes so the parent (Workspace.tsx) can power
    // the outline-highlight + breadcrumb. Throttled implicitly by
    // Monaco — the event fires per move, not per pixel.
    ed.onDidChangeCursorPosition((e) => {
      onCaretChange?.(e.position.lineNumber);
    });
    // Selection bus : tracks "what's currently selected" so Cmd-L
    // (Send selection to AI) can read it from outside the editor
    // without prop-drilling a callback up to useWorkspaceShell.
    ed.onDidChangeCursorSelection(() => {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (!sel || !model || sel.isEmpty()) {
        setEditorSelection(null);
        return;
      }
      const text = model.getValueInRange(sel);
      setEditorSelection({
        text,
        path: pathRef.current ?? "",
        language: languageFor(pathRef.current),
      });
    });
  };

  // applyToEditorBus subscriber : the AI panel's "Apply latest block"
  // button emits here. We replace the current selection, or insert at
  // the caret when nothing is selected. Save is left to the user.
  useEffect(() => {
    return subscribeApplyToEditor((req) => {
      if (req.targetPath !== path) {
        emitToast(
          `Suggestion targets ${req.targetPath}, but ${path ?? "(none)"} is active.`,
          "info",
        );
        return;
      }
      const ed = editorRef.current;
      const m = monacoRef.current;
      if (!ed || !m) return;
      const sel = ed.getSelection();
      const target =
        sel && !sel.isEmpty()
          ? sel
          : (() => {
              const pos = ed.getPosition();
              return new m.Range(pos!.lineNumber, pos!.column, pos!.lineNumber, pos!.column);
            })();
      ed.executeEdits("scelo-ai-apply", [
        { range: target, text: req.text, forceMoveMarkers: true },
      ]);
      ed.focus();
    });
  }, [path]);

  // Apply Pyright diagnostics as Monaco markers for the active Python file.
  // No-op for non-Python files. Triggered on save (below); could later run
  // on a debounced edit but that requires the model to be flushed to disk
  // first, which we don't do.
  const applyDiagnostics = useCallback(
    async (relPath: string) => {
      if (!isDesktopIDE()) return;
      const m = monacoRef.current;
      const ed = editorRef.current;
      const lower = relPath.toLowerCase();
      // Clear stale markers from BOTH owners regardless of file type so a
      // .py → .R swap doesn't leave squiggles from the previous file.
      if (m && ed && ed.getModel()) {
        m.editor.setModelMarkers(ed.getModel()!, "scelo-pyright", []);
        m.editor.setModelMarkers(ed.getModel()!, "scelo-lintr", []);
      }

      if (lower.endsWith(".py")) {
        const res = await window.scelo!.fs.lintPython(relPath);
        if (!m || !ed || !ed.getModel()) return;
        if (!res.ok) {
          setLintNote(`pyright: ${res.error ?? ""}`);
          return;
        }
        setLintNote(res.note ?? null);
        m.editor.setModelMarkers(
          ed.getModel()!,
          "scelo-pyright",
          res.diagnostics.map((d) => pyDiagnosticToMarker(d, m)),
        );
        return;
      }

      if (lower.endsWith(".r")) {
        const res = await window.scelo!.fs.lintR(relPath);
        if (!m || !ed || !ed.getModel()) return;
        if (!res.ok) {
          setLintNote(`lintr: ${res.error ?? ""}`);
          return;
        }
        setLintNote(res.note ?? null);
        m.editor.setModelMarkers(
          ed.getModel()!,
          "scelo-lintr",
          res.diagnostics.map((d) => rDiagnosticToMarker(d, m)),
        );
        return;
      }

      setLintNote(null);
    },
    [],
  );

  // Reload whenever the active path changes.
  useEffect(() => {
    if (!path || !isDesktopIDE()) {
      setStatus("idle");
      setValue("");
      setOriginal("");
      return;
    }
    setStatus("loading");
    (async () => {
      const r = await window.scelo!.fs.read(path);
      if (!r.ok) {
        setStatus({ error: r.error ?? "read failed" });
        return;
      }
      const onDisk = r.content ?? "";
      // Try to restore any persisted unsaved draft. Main returns
      // present=false when there's no draft OR when the on-disk hash
      // doesn't match what the draft was based on (stale-vs-disk guard).
      const draft = await window.scelo!.fs.loadUnsaved(path);
      setOriginal(onDisk);
      const initial =
        draft.ok && draft.present && draft.content !== undefined ? draft.content : onDisk;
      setValue(initial);
      onBufferChange?.(initial);
      if (!(draft.ok && draft.present && draft.content !== undefined) && draft.dropped) {
        // The IPC drops a draft when the file changed on disk since the
        // draft was saved — surface that so the user knows their dirty
        // buffer disappeared on purpose instead of silently losing work.
        emitToast(`Unsaved draft discarded: ${draft.dropped}`, "info");
      }
      setStatus("ready");
      // Surface any stale-on-disk diagnostics immediately so a freshly
      // opened file already shows red squiggles without waiting for save.
      applyDiagnostics(path);
      // Notify the LSP so it can analyse this buffer and push live
      // diagnostics + power hover/completion/definition/signatureHelp.
      const lang = lspLangForPath(path);
      if (lang) {
        const text = draft.ok && draft.present && draft.content !== undefined
          ? draft.content
          : onDisk;
        getLspClient(lang).openDocument(toLspUri(path), lang, text);
      }
    })();
  }, [path, applyDiagnostics]);

  // Debounced unsaved-draft persistence. Fires 500 ms after the last
  // edit; clears the on-disk draft as soon as the buffer matches the
  // original (the user undid back to disk OR saved).
  useEffect(() => {
    if (!isDesktopIDE() || !path) return;
    const buffersMatch = value === original;
    const t = window.setTimeout(() => {
      if (buffersMatch) {
        window.scelo!.fs.clearUnsaved(path);
      } else {
        window.scelo!.fs.saveUnsaved(path, value);
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [path, value, original]);

  // Stream every edit to the LSP so hover/completion are up-to-date with
  // the in-memory buffer (not just what's on disk).
  useEffect(() => {
    if (!path || !isDesktopIDE()) return;
    const lang = lspLangForPath(path);
    if (!lang) return;
    if (status !== "ready" && status !== "saving" && status !== "saved") return;
    getLspClient(lang).changeDocument(toLspUri(path), value);
  }, [path, value, status]);

  // Search-panel deep-link — scroll to + select the requested line as
  // soon as the editor model is mounted. Fires exactly once per request
  // (onJumpHandled clears the parent's pendingJump).
  useEffect(() => {
    if (!jumpToLine) return;
    if (status !== "ready") return;
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(jumpToLine);
    ed.setPosition({ lineNumber: jumpToLine, column: 1 });
    ed.focus();
    onJumpHandled?.();
  }, [jumpToLine, status, onJumpHandled]);

  const dirty = value !== original;

  const save = useCallback(async () => {
    if (!path || !isDesktopIDE()) return;
    setStatus("saving");
    const r = await window.scelo!.fs.write(path, value);
    if (!r.ok) {
      setStatus({ error: r.error ?? "write failed" });
      return;
    }
    setOriginal(value);
    setStatus("saved");
    setTimeout(() => setStatus("ready"), 1200);
    // Run Pyright after save so the markers reflect what's actually on
    // disk (Pyright reads the file, not the in-memory buffer).
    if (path) applyDiagnostics(path);
    // Save will likely have flipped this file's git status (M / A);
    // ping the bus so the StatusBar + FileBrowser decorations update
    // without waiting for the 30 s tick.
    void refreshGit();
    // The on-disk file now matches the buffer — clear any persisted
    // draft so a future re-open doesn't restore a "dirty" version of
    // what's already saved.
    if (path && isDesktopIDE()) {
      window.scelo!.fs.clearUnsaved(path);
    }
  }, [path, value, applyDiagnostics]);

  // ⌘/Ctrl-S to save — feels native, no menu round-trip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const onChange: OnChange = (v) => {
    const next = v ?? "";
    setValue(next);
    onBufferChange?.(next);
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6 text-center text-xs text-fg-mute">
        Select a file in the workspace sidebar to open it here.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex items-baseline justify-between border-b border-border bg-bg-2 px-3 py-1">
        <span className="font-mono text-[11px] text-fg">
          {path}
          {dirty ? <span className="ml-1 text-dissent">●</span> : null}
          {breadcrumb && breadcrumb.length > 0 && (
            <span className="ml-3 text-fg-mute">
              {breadcrumb.map((label, i) => (
                <span key={`${label}-${i}`}>
                  {i > 0 && <span className="mx-1 opacity-60">›</span>}
                  <span>{label}</span>
                </span>
              ))}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {lintNote && (
            <span className="text-[10px] text-fg-mute" title={lintNote}>
              ⓘ pyright
            </span>
          )}
          <span className="text-[10px] text-fg-mute">{statusLabel(status, dirty)}</span>
          {hasGitChanges && (
            <button
              type="button"
              onClick={() => setDiffMode((d) => !d)}
              className="ia-btn ia-btn-sm ia-btn-secondary"
              title={
                diffMode
                  ? "Hide the HEAD-vs-buffer diff"
                  : "Show a HEAD-vs-buffer diff"
              }
            >
              {diffMode ? "Source" : "Diff"}
            </button>
          )}
          {viewer && !diffMode && (
            <button
              type="button"
              onClick={() => setViewerActive((v) => !v)}
              className="ia-btn ia-btn-sm ia-btn-secondary"
              title={
                viewer.kind === "alt"
                  ? viewerActive
                    ? `Switch to Monaco source (${path})`
                    : `Switch to ${viewer.enableLabel.toLowerCase()} view`
                  : viewerActive
                    ? "Hide the side preview"
                    : "Open a side-by-side rendered preview"
              }
            >
              {viewerActive ? viewer.disableLabel : viewer.enableLabel}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || status === "saving"}
            className="ia-btn ia-btn-sm ia-btn-primary"
            title="⌘/Ctrl-S"
          >
            save
          </button>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        {/* Toasts now render in the global ToastTray mounted in
            Workspace.tsx — see lib/toastBus + components/workspace/ToastTray. */}
        {diffMode ? (
          headContent === null ? (
            <div className="p-4 text-xs text-fg-mute">Reading HEAD…</div>
          ) : (
            <DiffEditor
              height="100%"
              theme={editorTheme()}
              language={languageFor(path) ?? "plaintext"}
              original={headContent}
              modified={value}
              options={{
                fontSize: 12,
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                renderSideBySide: true,
                readOnly: true,
                originalEditable: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          )
        ) : (
          renderBody({
            path,
            viewer,
            viewerActive,
            value,
            onChange,
            onMount,
          })
        )}
      </div>
    </div>
  );
}

interface BodyProps {
  path: string;
  viewer: ViewerDescriptor | null;
  viewerActive: boolean;
  value: string;
  onChange: OnChange;
  onMount: OnMount;
}

function renderBody({
  path,
  viewer,
  viewerActive,
  value,
  onChange,
  onMount,
}: BodyProps): JSX.Element {
  const monacoNode = (
    <Editor
      height="100%"
      theme={editorTheme()}
      language={languageFor(path) ?? "plaintext"}
      value={value}
      onChange={onChange}
      onMount={onMount}
      options={{
        fontSize: 12,
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: "boundary",
        automaticLayout: true,
      }}
    />
  );
  if (!viewer || !viewerActive) return monacoNode;
  const Viewer = viewer.Component;
  if (viewer.kind === "alt") {
    return <Viewer path={path} buffer={value} />;
  }
  // "preview" — side-by-side. Equal columns, vertical divider.
  return (
    <div className="grid h-full" style={{ gridTemplateColumns: "1fr 4px 1fr" }}>
      <div className="min-w-0 overflow-hidden">{monacoNode}</div>
      <div className="bg-border" aria-hidden="true" />
      <div className="min-w-0 overflow-hidden">
        <Viewer path={path} buffer={value} />
      </div>
    </div>
  );
}

/** Pyright → Monaco. Severity mapping mirrors VS Code's: error red,
 *  warning yellow, information / hint blue. */
function pyDiagnosticToMarker(
  d: PyrightDiagnostic,
  m: typeof monaco,
): monaco.editor.IMarkerData {
  return {
    severity: severityFor(d.severity, m),
    message: d.rule ? `${d.message} (${d.rule})` : d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: "pyright",
  };
}

/** lintr → Monaco. lintr emits one-based line/column already; we use the
 *  same range for start and end (lintr doesn't return a span). */
function rDiagnosticToMarker(
  d: RLintDiagnostic,
  m: typeof monaco,
): monaco.editor.IMarkerData {
  return {
    severity: severityFor(d.severity, m),
    message: d.rule ? `${d.message} (${d.rule})` : d.message,
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.line,
    endColumn: d.column + 1,
    source: "lintr",
  };
}

function severityFor(
  s: "error" | "warning" | "information" | "unusedcode",
  m: typeof monaco,
): monaco.MarkerSeverity {
  if (s === "error") return m.MarkerSeverity.Error;
  if (s === "warning") return m.MarkerSeverity.Warning;
  if (s === "unusedcode") return m.MarkerSeverity.Hint;
  return m.MarkerSeverity.Info;
}

// ─── LSP → Monaco glue (Python + R) ───────────────────────────────────
//
// Idempotent per language: registers providers exactly once per Monaco
// instance + language. Wires textDocument/publishDiagnostics → editor
// markers, plus Monaco's completion / hover / definition / signatureHelp
// provider lookups to the LSP.

const _lspRegistered = new Set<string>();

function lspLangForPath(p: string): "python" | "r" | null {
  const lower = p.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".r")) return "r";
  return null;
}

function monacoLangFor(lang: "python" | "r"): string {
  return lang === "python" ? "python" : "r";
}

/** Curated actuarial snippets (`lib/snippets.ts`) surfaced via a
 *  dedicated Snippet-kind completion provider. Monaco merges results
 *  across providers, so these appear alongside Pyright / R-LSP
 *  completions only when the user actively types one of the prefixes. */
function registerSnippetProvider(
  m: typeof monaco,
  lang: SnippetLang,
  monacoLang: string,
): void {
  const snippets = snippetsFor(lang);
  if (snippets.length === 0) return;
  m.languages.registerCompletionItemProvider(monacoLang, {
    // No trigger characters : the snippets fire from the normal "type
    // to filter" flow, so the user gets them by typing `scelo-…`.
    provideCompletionItems: (model, pos) => {
      const word = model.getWordUntilPosition(pos);
      const range: monaco.IRange = {
        startLineNumber: pos.lineNumber,
        endLineNumber: pos.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: snippets.map((s) => ({
          label: s.prefix,
          kind: m.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: s.detail,
          documentation: { value: `Built-in Scelo snippet for ${lang}.` },
          range,
        })),
      };
    },
  });
}

function registerLspProviders(m: typeof monaco, lang: "python" | "r"): void {
  if (_lspRegistered.has(lang)) return;
  _lspRegistered.add(lang);
  const client = getLspClient(lang);
  const monacoLang = monacoLangFor(lang);
  registerSnippetProvider(m, lang, monacoLang);

  // Server-originated workspace/applyEdit — Pyright sends these when a
  // command like organise-imports rewrites the file. We apply the edits
  // to the matching Monaco model and reply with {applied: true}.
  client.onRequest("workspace/applyEdit", (paramsUnknown) => {
    const params = paramsUnknown as {
      label?: string;
      edit?: {
        changes?: Record<
          string,
          Array<{
            range: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            newText: string;
          }>
        >;
      };
    };
    const changes = params.edit?.changes ?? {};
    let applied = false;
    for (const [docUri, edits] of Object.entries(changes)) {
      const target = m.editor
        .getModels()
        .find((mod) => mod.uri.toString() === docUri);
      if (!target) continue;
      target.pushEditOperations(
        [],
        edits.map((e) => ({
          range: {
            startLineNumber: e.range.start.line + 1,
            startColumn: e.range.start.character + 1,
            endLineNumber: e.range.end.line + 1,
            endColumn: e.range.end.character + 1,
          },
          text: e.newText,
        })),
        () => null,
      );
      applied = true;
    }
    return { applied };
  });

  // Diagnostics → Monaco markers on the matching model.
  client.on("textDocument/publishDiagnostics", (paramsUnknown) => {
    const p = paramsUnknown as {
      uri: string;
      diagnostics: Array<{
        severity?: number;
        message: string;
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        source?: string;
        code?: string | number;
      }>;
    };
    const path = fromLspUri(p.uri);
    const allModels = m.editor.getModels();
    const model = allModels.find(
      (mod) => mod.uri.path === path || mod.uri.toString().endsWith(path),
    );
    if (!model) return;
    const markers: monaco.editor.IMarkerData[] = p.diagnostics.map((d) => ({
      severity:
        d.severity === 1
          ? m.MarkerSeverity.Error
          : d.severity === 2
            ? m.MarkerSeverity.Warning
            : d.severity === 4
              ? m.MarkerSeverity.Hint
              : m.MarkerSeverity.Info,
      message: d.code ? `${d.message} (${d.code})` : d.message,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      source: d.source ?? (lang === "python" ? "pyright" : "languageserver"),
    }));
    m.editor.setModelMarkers(model, `scelo-lsp-${lang}`, markers);

    // Mirror onto the workspace-wide diagnostics bus so the Problems
    // panel sees every file the LSP touches, not just the active tab.
    const busEntries: BusDiagnostic[] = p.diagnostics.map((d) => ({
      line: d.range.start.line,
      character: d.range.start.character,
      severity: severityFromLsp(d.severity),
      message: d.message,
      source: d.source ?? (lang === "python" ? "pyright" : "languageserver"),
      code: d.code != null ? String(d.code) : undefined,
    }));
    publishToBus(path, busEntries);
  });

  // Completion provider.
  m.languages.registerCompletionItemProvider(monacoLang, {
    triggerCharacters: [".", "(", "[", "$", "@"],
    provideCompletionItems: async (model, pos) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/completion", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })) as
          | null
          | Array<{ label: string; kind?: number; detail?: string; insertText?: string }>
          | { items?: Array<{ label: string; kind?: number; detail?: string; insertText?: string }> };
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        return {
          suggestions: items.map((it) => ({
            label: it.label,
            kind: it.kind ?? m.languages.CompletionItemKind.Text,
            detail: it.detail,
            insertText: it.insertText ?? it.label,
            range: undefined as unknown as monaco.IRange,
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  // Hover provider.
  m.languages.registerHoverProvider(monacoLang, {
    provideHover: async (model, pos) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/hover", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })) as
          | null
          | { contents: string | { value?: string } | Array<string | { value?: string }> };
        if (!result || !result.contents) return null;
        const md = hoverContentToMarkdown(result.contents);
        if (!md) return null;
        return { contents: [{ value: md }] };
      } catch {
        return null;
      }
    },
  });

  // Definition provider — ⌘/Ctrl-click on a symbol jumps to its source.
  m.languages.registerDefinitionProvider(monacoLang, {
    provideDefinition: async (model, pos) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/definition", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })) as
          | null
          | Array<{
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            }>
          | {
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            };
        if (!result) return null;
        const list = Array.isArray(result) ? result : [result];
        return list.map((loc) => ({
          uri: m.Uri.parse(loc.uri),
          range: {
            startLineNumber: loc.range.start.line + 1,
            startColumn: loc.range.start.character + 1,
            endLineNumber: loc.range.end.line + 1,
            endColumn: loc.range.end.character + 1,
          },
        }));
      } catch {
        return null;
      }
    },
  });

  // Rename (F2 by default in Monaco).
  m.languages.registerRenameProvider(monacoLang, {
    provideRenameEdits: async (model, pos, newName) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/rename", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
          newName,
        })) as
          | null
          | {
              changes?: Record<
                string,
                Array<{
                  range: {
                    start: { line: number; character: number };
                    end: { line: number; character: number };
                  };
                  newText: string;
                }>
              >;
            };
        if (!result || !result.changes) return { edits: [] };
        const edits: monaco.languages.IWorkspaceTextEdit[] = [];
        for (const [docUri, perDoc] of Object.entries(result.changes)) {
          for (const e of perDoc) {
            edits.push({
              resource: m.Uri.parse(docUri),
              versionId: undefined,
              textEdit: {
                text: e.newText,
                range: {
                  startLineNumber: e.range.start.line + 1,
                  startColumn: e.range.start.character + 1,
                  endLineNumber: e.range.end.line + 1,
                  endColumn: e.range.end.character + 1,
                },
              },
            });
          }
        }
        return { edits };
      } catch {
        return { edits: [] };
      }
    },
  });

  // Code actions — lightbulb menu surfaces quick-fixes (add missing
  // import, fix type, organise imports for Python; lintr-driven fixes
  // for R when languageserver exposes them).
  m.languages.registerCodeActionProvider(monacoLang, {
    provideCodeActions: async (model, range, context) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/codeAction", {
          textDocument: { uri },
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          context: {
            diagnostics: (context.markers ?? []).map((mk) => ({
              range: {
                start: { line: mk.startLineNumber - 1, character: mk.startColumn - 1 },
                end: { line: mk.endLineNumber - 1, character: mk.endColumn - 1 },
              },
              severity: monacoToLspSeverity(mk.severity),
              message: mk.message,
              source: mk.source,
              code: typeof mk.code === "object" ? mk.code.value : mk.code,
            })),
            triggerKind: 1, // Invoked
          },
        })) as
          | null
          | Array<{
              title?: string;
              kind?: string;
              command?: { title: string; command: string; arguments?: unknown[] };
              edit?: {
                changes?: Record<
                  string,
                  Array<{
                    range: {
                      start: { line: number; character: number };
                      end: { line: number; character: number };
                    };
                    newText: string;
                  }>
                >;
              };
            }>;
        const actions = (result ?? []).map((a, idx) => {
          const wedits: monaco.languages.IWorkspaceTextEdit[] = [];
          if (a.edit?.changes) {
            for (const [docUri, edits] of Object.entries(a.edit.changes)) {
              for (const e of edits) {
                wedits.push({
                  resource: m.Uri.parse(docUri),
                  versionId: undefined,
                  textEdit: {
                    text: e.newText,
                    range: {
                      startLineNumber: e.range.start.line + 1,
                      startColumn: e.range.start.character + 1,
                      endLineNumber: e.range.end.line + 1,
                      endColumn: e.range.end.character + 1,
                    },
                  },
                });
              }
            }
          }
          // Server-side commands (e.g. Pyright's `pyright.organizeimports`).
          // Monaco's CodeAction.command field gets a synthetic id that we
          // dispatch via editor.addCommand below — the handler forwards
          // to workspace/executeCommand and the LSP applies whatever
          // textEdits / workspaceEdits it wants.
          let command: monaco.languages.Command | undefined;
          if (a.command) {
            const cmdId = `scelo.lsp.${lang}.${a.command.command}`;
            ensureLspCommandRegistered(m, cmdId, lang, a.command.command);
            command = {
              id: cmdId,
              title: a.command.title,
              arguments: a.command.arguments ?? [],
            };
          }
          return {
            title: a.title ?? `action ${idx}`,
            kind: a.kind,
            edit: wedits.length > 0 ? { edits: wedits } : undefined,
            command,
          } as monaco.languages.CodeAction;
        });
        return {
          actions,
          dispose: () => {
            // No resources to release.
          },
        };
      } catch {
        return { actions: [], dispose: () => {} };
      }
    },
  });

  // Whole-document formatting — Pyright forwards to autopep8/black if
  // configured; languageserver uses styler::style_text for R.
  m.languages.registerDocumentFormattingEditProvider(monacoLang, {
    provideDocumentFormattingEdits: async (model) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/formatting", {
          textDocument: { uri },
          options: { tabSize: 2, insertSpaces: true },
        })) as
          | null
          | Array<{
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
              newText: string;
            }>;
        if (!result || result.length === 0) return [];
        return result.map((e) => ({
          range: {
            startLineNumber: e.range.start.line + 1,
            startColumn: e.range.start.character + 1,
            endLineNumber: e.range.end.line + 1,
            endColumn: e.range.end.character + 1,
          },
          text: e.newText,
        }));
      } catch {
        return [];
      }
    },
  });

  // Call hierarchy: declared in our LSP client capabilities so Pyright /
  // languageserver compute it, but Monaco's standalone editor doesn't
  // expose `registerCallHierarchyProvider` in its public API (confirmed
  // through 0.55.1). Reaching into the internal contribution registry
  // would tie us to a specific Monaco version. Punted indefinitely;
  // users who need call-hierarchy can use the LSP's `workspace/symbol`
  // search instead (surfaced via Monaco's command palette).

  // Inlay hints — Pyright surfaces inferred types and parameter names
  // inline. Monaco 0.55's public API DOES expose registerInlayHintsProvider,
  // so this one we can wire through.
  m.languages.registerInlayHintsProvider(monacoLang, {
    provideInlayHints: async (model, range) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/inlayHint", {
          textDocument: { uri },
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
        })) as
          | null
          | Array<{
              position: { line: number; character: number };
              label: string | Array<{ value: string }>;
              kind?: number;       // 1=Type, 2=Parameter
              paddingLeft?: boolean;
              paddingRight?: boolean;
            }>;
        if (!result) return { hints: [], dispose: () => {} };
        return {
          hints: result.map((h) => ({
            position: {
              lineNumber: h.position.line + 1,
              column: h.position.character + 1,
            },
            label:
              typeof h.label === "string"
                ? h.label
                : h.label.map((p) => p.value).join(""),
            kind: h.kind as unknown as monaco.languages.InlayHintKind,
            paddingLeft: h.paddingLeft,
            paddingRight: h.paddingRight,
          })),
          dispose: () => {},
        };
      } catch {
        return { hints: [], dispose: () => {} };
      }
    },
  });

  // References — Shift-F12 lists every occurrence in the workspace.
  // Pyright honours includeDeclaration so the symbol's own definition
  // also shows up in the results.
  m.languages.registerReferenceProvider(monacoLang, {
    provideReferences: async (model, pos, context) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/references", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
          context: { includeDeclaration: context.includeDeclaration ?? true },
        })) as
          | null
          | Array<{
              uri: string;
              range: {
                start: { line: number; character: number };
                end: { line: number; character: number };
              };
            }>;
        if (!result || result.length === 0) return [];
        return result.map((loc) => ({
          uri: m.Uri.parse(loc.uri),
          range: {
            startLineNumber: loc.range.start.line + 1,
            startColumn: loc.range.start.character + 1,
            endLineNumber: loc.range.end.line + 1,
            endColumn: loc.range.end.character + 1,
          },
        }));
      } catch {
        return [];
      }
    },
  });

  // Signature help — surfaces parameter hints when typing inside ().
  m.languages.registerSignatureHelpProvider(monacoLang, {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model, pos) => {
      const uri = lspUriForModel(model);
      try {
        const result = (await client.request("textDocument/signatureHelp", {
          textDocument: { uri },
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })) as
          | null
          | {
              signatures: Array<{
                label: string;
                documentation?: string | { value?: string };
                parameters?: Array<{
                  label: string | [number, number];
                  documentation?: string | { value?: string };
                }>;
              }>;
              activeSignature?: number;
              activeParameter?: number;
            };
        if (!result || !result.signatures || result.signatures.length === 0) return null;
        return {
          value: {
            signatures: result.signatures.map((s) => ({
              label: s.label,
              documentation: extractDocs(s.documentation),
              parameters: (s.parameters ?? []).map((p) => ({
                label: p.label,
                documentation: extractDocs(p.documentation),
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose: () => {
            // No resources to release — Monaco invokes for parity with
            // its own provider API.
          },
        };
      } catch {
        return null;
      }
    },
  });
}

function extractDocs(
  d: string | { value?: string } | undefined,
): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") return d;
  return d.value;
}

function monacoToLspSeverity(sev: monaco.MarkerSeverity): number {
  // Monaco: 8=Error 4=Warning 2=Info 1=Hint → LSP: 1=Error 2=Warning 3=Info 4=Hint
  if (sev === 8) return 1;
  if (sev === 4) return 2;
  if (sev === 1) return 4;
  return 3;
}

/** Register a Monaco-side command that forwards to LSP's
 *  workspace/executeCommand. Idempotent: each (lang, command) pair is
 *  registered exactly once across the editor's lifetime. */
const _registeredLspCommands = new Set<string>();
function ensureLspCommandRegistered(
  m: typeof monaco,
  monacoCmdId: string,
  lang: "python" | "r",
  lspCommand: string,
): void {
  if (_registeredLspCommands.has(monacoCmdId)) return;
  _registeredLspCommands.add(monacoCmdId);
  const client = getLspClient(lang);
  m.editor.registerCommand(monacoCmdId, async (_accessor, ...args: unknown[]) => {
    try {
      await client.request("workspace/executeCommand", {
        command: lspCommand,
        arguments: args,
      });
      // Servers that apply edits via workspace/applyEdit push them back
      // through publishDiagnostics + ApplyEditRequest; that path lands
      // in our notification handler if the renderer needs to react.
    } catch (err) {
      // Soft-fail — the lightbulb menu just becomes a no-op.
      // eslint-disable-next-line no-console
      console.warn("LSP executeCommand failed", lspCommand, err);
    }
  });
}

function lspUriForModel(model: monaco.editor.ITextModel): string {
  // Monaco's model URI is already a `file://…`-shaped string we can ship.
  return model.uri.toString();
}

function toLspUri(workspaceRel: string): string {
  // Use a stable `scelo://workspace/…` URI so diagnostics route correctly
  // regardless of the actual disk path (which the renderer doesn't know).
  return `scelo://workspace/${workspaceRel.replace(/^\/+/, "")}`;
}

function fromLspUri(uri: string): string {
  return uri.replace(/^scelo:\/\/workspace\//, "").replace(/^file:\/\//, "");
}

function hoverContentToMarkdown(
  contents: string | { value?: string } | Array<string | { value?: string }>,
): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : c.value ?? ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return contents.value ?? "";
}

function statusLabel(s: Status, dirty: boolean): string {
  if (typeof s === "object") return `error: ${s.error}`;
  if (s === "loading") return "loading…";
  if (s === "saving") return "saving…";
  if (s === "saved") return "saved ✓";
  return dirty ? "unsaved" : "clean";
}

function editorTheme(): "vs" | "vs-dark" {
  if (typeof document === "undefined") return "vs-dark";
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" ? "vs" : "vs-dark";
}

// languageFor() moved to ../../lib/languageFor.ts so StatusBar can share it.
