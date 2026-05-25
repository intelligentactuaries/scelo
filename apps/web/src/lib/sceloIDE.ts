// Scelo IDE bridge — a tiny typed wrapper around window.scelo, exposed by
// the Electron preload (apps/scelo-ide/src/preload.ts). Outside the IDE
// (regular browser at localhost:5173) all of these return safe defaults
// so existing code paths keep working unchanged.
//
// The single purpose of this file: anywhere in apps/web we want to
// optionally delegate to bundled Python or R, we go through here. That
// way the "do we have a desktop runtime?" check is one centralised
// branch instead of scattered window?.scelo references.

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface RuntimeStatus {
  python: boolean;
  r: boolean;
  resourceDir: string;
}

export interface PackageProbe {
  pkg: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export interface StackReport {
  python: { available: boolean; packages: PackageProbe[] | null; stderr: string };
  r: { available: boolean; packages: PackageProbe[] | null; stderr: string };
}

export interface SecretListItem {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  keyPreview: string;
  updatedAt: string;
}

export interface SecretRecord {
  provider: string;
  apiKey: string;
  model: string | null;
  baseUrl: string | null;
}

export interface SecretsStatus {
  available: boolean;
  backend: string;
}

interface SecretsBridge {
  list(): Promise<Record<string, SecretListItem>>;
  get(provider: string): Promise<SecretRecord | null>;
  set(
    provider: string,
    payload: { apiKey: string; model?: string; baseUrl?: string },
  ): Promise<{ ok: boolean }>;
  clear(provider?: string): Promise<{ ok: boolean }>;
  status(): Promise<SecretsStatus>;
}

export interface StreamExecRequest {
  runtime: "python" | "r" | "shell";
  script?: string;
  command?: string;
  argv?: string[];
  stdin?: string;
  cwd?: string;
}

export interface ExecChunk {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
}

export interface ExecEnd {
  sessionId: string;
  exitCode: number | null;
  error: string | null;
}

export interface FsListEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface ExecBridge {
  start(req: StreamExecRequest): Promise<{ sessionId: string } | { error: string }>;
  write(sessionId: string, data: string): Promise<{ ok: boolean; error?: string }>;
  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: boolean; error?: string }>;
  cancel(sessionId: string): Promise<{ ok: boolean; error?: string }>;
  onChunk(cb: (chunk: ExecChunk) => void): () => void;
  onEnd(cb: (end: ExecEnd) => void): () => void;
}

export interface WorkspaceState {
  openTabs: string[];
  activeTab: string | null;
  /** Last-active sidebar tab. Optional so older state files keep working —
   *  consumer defaults to "files" when missing. */
  sidebarTab?:
    | "files"
    | "search"
    | "outline"
    | "git"
    | "problems"
    | "tests"
    | "swarm";
  /** Whether the right-side AI panel is visible. Added in P28; opt-in
   *  via Cmd-Shift-A so existing installs default to false. */
  aiPanelVisible?: boolean;
  /** Pixel width of the AI panel. Clamped on render. */
  aiPanelWidth?: number;
  /** Terminal panel visibility (hidden by default in P30 follow-up;
   *  session stays alive in the background when hidden). */
  terminalVisible?: boolean;
  /** Last sidebar pixel width. Clamped on render. */
  sidebarWidth?: number;
}

export interface WorkspaceRecord {
  id: string;
  path: string;
  lastActive: number;
}

interface WorkspaceBridge {
  get(): Promise<{ path: string | null; id: string | null }>;
  pick(): Promise<{ path: string | null; id: string | null }>;
  list(rel?: string): Promise<{ entries: FsListEntry[]; error?: string }>;
  registry(): Promise<{ workspaces: WorkspaceRecord[] }>;
  switch(
    id: string,
  ): Promise<{ ok: boolean; path?: string; id?: string; error?: string }>;
  /** Pin THIS window to the given workspace id without changing the
   *  global most-recently-active. Used when a window mounts so the
   *  per-window override is set before any fs / lsp / state IPC fires. */
  setForWindow(
    id: string,
  ): Promise<{ ok: boolean; path?: string; id?: string; error?: string }>;
  remove(id: string): Promise<{ ok: boolean }>;
  /** Scaffold one of the bundled sample workspaces under a user-chosen
   *  parent directory, pin this window to it, and register it. Returns
   *  the new workspace id + absolute path on success. */
  createFromTemplate(
    templateId: string,
  ): Promise<{ ok: boolean; id?: string; path?: string; error?: string }>;
  stateGet(): Promise<WorkspaceState>;
  stateSet(state: WorkspaceState): Promise<{ ok: boolean; error?: string }>;
}

export interface PyrightDiagnostic {
  file: string;
  severity: "error" | "warning" | "information" | "unusedcode";
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rule?: string;
}

export interface RLintDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "unusedcode";
  message: string;
  rule?: string;
}

interface FsBridge {
  read(
    rel: string,
  ): Promise<{ ok: boolean; content?: string; size?: number; error?: string }>;
  write(rel: string, content: string): Promise<{ ok: boolean; error?: string }>;
  /** Apply a literal-string replacement to every (lineNumber, start, end)
   *  triple. Sorted server-side so out-of-order offsets don't corrupt
   *  the line. Returns count of files actually rewritten + total matches
   *  replaced; matches are skipped silently when the line / offset no
   *  longer fits (file changed between search and replace). */
  replace(
    files: Array<{
      path: string;
      edits: Array<{ lineNumber: number; start: number; end: number }>;
    }>,
    replacement: string,
  ): Promise<{ ok: boolean; filesWritten: number; matchesReplaced: number; error?: string }>;
  lintPython(
    rel: string,
  ): Promise<{
    ok: boolean;
    diagnostics: PyrightDiagnostic[];
    error?: string;
    note?: string;
  }>;
  lintR(
    rel: string,
  ): Promise<{
    ok: boolean;
    diagnostics: RLintDiagnostic[];
    error?: string;
    note?: string;
  }>;
  /** Persist the in-memory buffer for `rel` so a reload / crash doesn't
   *  lose unsaved edits. Stored per-workspace under userData/unsaved/. */
  saveUnsaved(rel: string, content: string): Promise<{ ok: boolean; error?: string }>;
  /** Returns the persisted unsaved buffer for `rel` if one exists AND
   *  the on-disk file hasn't changed since the draft was saved. */
  loadUnsaved(rel: string): Promise<{
    ok: boolean;
    present?: boolean;
    content?: string;
    savedAt?: string;
    dropped?: string;
    error?: string;
  }>;
  clearUnsaved(rel: string): Promise<{ ok: boolean; error?: string }>;
}

interface UpdaterBridge {
  getChannel(): Promise<{ channel: "latest" | "beta" }>;
  setChannel(channel: "latest" | "beta"): Promise<{ channel: string }>;
}

export type LspLang = "python" | "r";

interface LspBridge {
  start(lang: LspLang): Promise<{ ok: boolean; error?: string }>;
  stop(lang?: LspLang): Promise<{ ok: boolean }>;
  send(lang: LspLang, message: unknown): Promise<{ ok: boolean; error?: string }>;
  onMessage(cb: (lang: LspLang, m: unknown) => void): () => void;
}

interface ToolsBridge {
  /** Absolute path to the bundled ripgrep binary, or null if the
   *  @vscode/ripgrep package didn't load on this platform. */
  ripgrepPath(): Promise<{ path: string | null }>;
}

export interface DatasetSpec {
  id: string;
  label: string;
  blurb: string;
  url: string;
  filename: string;
  approxBytes: number;
  usedBy: string;
}

export interface DatasetStatus {
  available: boolean;
  sizeBytes: number;
  path: string | null;
  /** Where the dataset is allowed to extract on-disk artefacts (e.g.
   *  ChEMBL's unpacked SQLite). Under user cache so it can be safely
   *  purged without touching the registered .tar.gz archive. */
  extractedDir: string;
  /** Bytes already written to the `.partial` file from a previous,
   *  cancelled or interrupted download attempt. When >0 and !available,
   *  the next download() request will resume via HTTP Range. */
  partialBytes: number;
  error?: string;
}

export interface DatasetProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  done?: boolean;
  error?: string;
}

interface DataBridge {
  list(): Promise<{ datasets: DatasetSpec[] }>;
  status(id: string): Promise<DatasetStatus>;
  download(id: string): Promise<{ ok: boolean; error?: string }>;
  cancel(id: string): Promise<{ ok: boolean }>;
  purge(id: string): Promise<{ ok: boolean; removedBytes?: number; error?: string }>;
  onProgress(cb: (p: DatasetProgress) => void): () => void;
}

export interface GitFile {
  path: string;
  /** Index status char (porcelain v2). M / A / D / R / U / ? for untracked. */
  index: string;
  /** Worktree status char (porcelain v2). */
  worktree: string;
}

export interface GitStatus {
  isRepo: boolean;
  gitInstalled: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  error?: string;
}

export interface DiscoveredTest {
  /** Node id : pass to `pytest <id>` or `testthat::test_file(<id>)`. */
  id: string;
  file: string;
  framework: "pytest" | "testthat";
}

export interface DiscoverTestsResult {
  ok: boolean;
  tests: DiscoveredTest[];
  errors: Array<{ framework: "pytest" | "testthat"; message: string }>;
}

interface TestsBridge {
  discover(): Promise<DiscoverTestsResult>;
}

interface GitBridge {
  status(): Promise<GitStatus>;
  stage(paths: string[]): Promise<{ ok: boolean; error?: string }>;
  unstage(paths: string[]): Promise<{ ok: boolean; error?: string }>;
  commit(message: string): Promise<{ ok: boolean; sha?: string; error?: string }>;
  /** `git show HEAD:<path>` — returns the blob at HEAD so the diff
   *  viewer can render against the in-memory buffer. Empty string when
   *  the file is new (no HEAD entry). */
  show(
    relPath: string,
  ): Promise<{ ok: boolean; content?: string; sha?: string; error?: string }>;
}

interface SceloBridge {
  runPython(req: { script: string; argv?: string[]; stdin?: string }): Promise<ExecResult>;
  runR(req: { script: string; argv?: string[]; stdin?: string }): Promise<ExecResult>;
  runtimeStatus(): Promise<RuntimeStatus>;
  stackProbe(): Promise<StackReport>;
  secrets: SecretsBridge;
  exec: ExecBridge;
  workspace: WorkspaceBridge;
  git: GitBridge;
  tests: TestsBridge;
  fs: FsBridge;
  updater: UpdaterBridge;
  lsp: LspBridge;
  data: DataBridge;
  tools: ToolsBridge;
}

declare global {
  interface Window {
    scelo?: SceloBridge;
  }
}

export function isDesktopIDE(): boolean {
  return typeof window !== "undefined" && typeof window.scelo !== "undefined";
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isDesktopIDE()) {
    return { python: false, r: false, resourceDir: "" };
  }
  return window.scelo!.runtimeStatus();
}

export async function runPython(
  script: string,
  opts?: { argv?: string[]; stdin?: string },
): Promise<ExecResult> {
  if (!isDesktopIDE()) {
    return {
      ok: false,
      stdout: "",
      stderr: "Not running inside Scelo IDE — bundled Python unavailable.",
      exitCode: null,
    };
  }
  return window.scelo!.runPython({ script, argv: opts?.argv, stdin: opts?.stdin });
}

export async function runR(
  script: string,
  opts?: { argv?: string[]; stdin?: string },
): Promise<ExecResult> {
  if (!isDesktopIDE()) {
    return {
      ok: false,
      stdout: "",
      stderr: "Not running inside Scelo IDE — bundled R unavailable.",
      exitCode: null,
    };
  }
  return window.scelo!.runR({ script, argv: opts?.argv, stdin: opts?.stdin });
}

export async function probeStack(): Promise<StackReport | null> {
  if (!isDesktopIDE()) return null;
  return window.scelo!.stackProbe();
}
