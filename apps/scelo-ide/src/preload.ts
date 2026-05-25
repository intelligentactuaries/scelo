// Preload — runs in the renderer's isolated world. Exposes a small, typed
// API on `window.scelo` for the renderer to talk to bundled Python / R.
//
// Keep this surface small. Anything we expose here is reachable from any
// page loaded in the BrowserWindow, so we only expose explicit RPCs (not
// the raw ipcRenderer).

import { contextBridge, ipcRenderer } from "electron";

interface ExecRequest {
  script: string;
  argv?: string[];
  stdin?: string;
}

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

interface PackageProbe {
  pkg: string;
  ok: boolean;
  version?: string;
  error?: string;
}

interface StackReport {
  python: { available: boolean; packages: PackageProbe[] | null; stderr: string };
  r: { available: boolean; packages: PackageProbe[] | null; stderr: string };
}

interface SecretListItem {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  keyPreview: string;
  updatedAt: string;
}

interface SecretRecord {
  provider: string;
  apiKey: string;
  model: string | null;
  baseUrl: string | null;
}

interface SecretsStatus {
  available: boolean;
  backend: string;
}

interface StreamExecRequest {
  runtime: "python" | "r" | "shell";
  script?: string;
  command?: string;
  argv?: string[];
  stdin?: string;
  cwd?: string;
}

interface ExecChunk {
  sessionId: string;
  stream: "stdout" | "stderr";
  data: string;
}

interface ExecEnd {
  sessionId: string;
  exitCode: number | null;
  error: string | null;
}

interface FsListEntry {
  name: string;
  isDir: boolean;
  size: number;
}

interface WorkspaceState {
  openTabs: string[];
  activeTab: string | null;
  sidebarTab?:
    | "files"
    | "search"
    | "outline"
    | "git"
    | "problems"
    | "tests"
    | "swarm";
  aiPanelVisible?: boolean;
  aiPanelWidth?: number;
  terminalVisible?: boolean;
  sidebarWidth?: number;
}

interface PyrightDiagnostic {
  file: string;
  severity: "error" | "warning" | "information" | "unusedcode";
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  rule?: string;
}

interface RLintDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "unusedcode";
  message: string;
  rule?: string;
}

interface GitFile {
  path: string;
  index: string;
  worktree: string;
}

interface GitStatus {
  isRepo: boolean;
  gitInstalled: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  error?: string;
}

contextBridge.exposeInMainWorld("scelo", {
  runPython: (req: ExecRequest): Promise<ExecResult> =>
    ipcRenderer.invoke("scelo:runPython", req),
  runR: (req: ExecRequest): Promise<ExecResult> =>
    ipcRenderer.invoke("scelo:runR", req),
  runtimeStatus: (): Promise<RuntimeStatus> =>
    ipcRenderer.invoke("scelo:runtimeStatus"),
  stackProbe: (): Promise<StackReport> =>
    ipcRenderer.invoke("scelo:stackProbe"),
  secrets: {
    list: (): Promise<Record<string, SecretListItem>> =>
      ipcRenderer.invoke("scelo:secrets:list"),
    get: (provider: string): Promise<SecretRecord | null> =>
      ipcRenderer.invoke("scelo:secrets:get", provider),
    set: (
      provider: string,
      payload: { apiKey: string; model?: string; baseUrl?: string },
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("scelo:secrets:set", provider, payload),
    clear: (provider?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("scelo:secrets:clear", provider),
    status: (): Promise<SecretsStatus> =>
      ipcRenderer.invoke("scelo:secrets:status"),
  },
  exec: {
    start: (req: StreamExecRequest): Promise<{ sessionId: string } | { error: string }> =>
      ipcRenderer.invoke("scelo:exec:start", req),
    write: (sessionId: string, data: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:exec:write", sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:exec:resize", sessionId, cols, rows),
    cancel: (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:exec:cancel", sessionId),
    onChunk: (cb: (chunk: ExecChunk) => void) => {
      const listener = (_e: unknown, chunk: ExecChunk) => cb(chunk);
      ipcRenderer.on("scelo:exec:chunk", listener);
      return () => ipcRenderer.removeListener("scelo:exec:chunk", listener);
    },
    onEnd: (cb: (end: ExecEnd) => void) => {
      const listener = (_e: unknown, end: ExecEnd) => cb(end);
      ipcRenderer.on("scelo:exec:end", listener);
      return () => ipcRenderer.removeListener("scelo:exec:end", listener);
    },
  },
  workspace: {
    get: (): Promise<{ path: string | null; id: string | null }> =>
      ipcRenderer.invoke("scelo:workspace:get"),
    pick: (): Promise<{ path: string | null; id: string | null }> =>
      ipcRenderer.invoke("scelo:workspace:pick"),
    list: (rel?: string): Promise<{ entries: FsListEntry[]; error?: string }> =>
      ipcRenderer.invoke("scelo:workspace:list", rel),
    registry: (): Promise<{
      workspaces: Array<{ id: string; path: string; lastActive: number }>;
    }> => ipcRenderer.invoke("scelo:workspace:registry"),
    switch: (
      id: string,
    ): Promise<{ ok: boolean; path?: string; id?: string; error?: string }> =>
      ipcRenderer.invoke("scelo:workspace:switch", id),
    setForWindow: (
      id: string,
    ): Promise<{ ok: boolean; path?: string; id?: string; error?: string }> =>
      ipcRenderer.invoke("scelo:workspace:setForWindow", id),
    remove: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("scelo:workspace:remove", id),
    createFromTemplate: (
      templateId: string,
    ): Promise<{ ok: boolean; id?: string; path?: string; error?: string }> =>
      ipcRenderer.invoke("scelo:workspace:create-from-template", templateId),
    stateGet: (): Promise<WorkspaceState> =>
      ipcRenderer.invoke("scelo:workspace:state:get"),
    stateSet: (state: WorkspaceState): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:workspace:state:set", state),
  },
  tests: {
    discover: (): Promise<{
      ok: boolean;
      tests: Array<{ id: string; file: string; framework: "pytest" | "testthat" }>;
      errors: Array<{ framework: "pytest" | "testthat"; message: string }>;
    }> => ipcRenderer.invoke("scelo:tests:discover"),
  },
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke("scelo:git:status"),
    stage: (paths: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:git:stage", paths),
    unstage: (paths: string[]): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:git:unstage", paths),
    commit: (message: string): Promise<{ ok: boolean; sha?: string; error?: string }> =>
      ipcRenderer.invoke("scelo:git:commit", message),
    show: (
      relPath: string,
    ): Promise<{ ok: boolean; content?: string; sha?: string; error?: string }> =>
      ipcRenderer.invoke("scelo:git:show", relPath),
  },
  fs: {
    read: (
      rel: string,
    ): Promise<{ ok: boolean; content?: string; size?: number; error?: string }> =>
      ipcRenderer.invoke("scelo:fs:read", rel),
    write: (rel: string, content: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:fs:write", rel, content),
    replace: (
      files: Array<{ path: string; edits: Array<{ lineNumber: number; start: number; end: number }> }>,
      replacement: string,
    ): Promise<{ ok: boolean; filesWritten: number; matchesReplaced: number; error?: string }> =>
      ipcRenderer.invoke("scelo:fs:replace", files, replacement),
    lintPython: (
      rel: string,
    ): Promise<{ ok: boolean; diagnostics: PyrightDiagnostic[]; error?: string; note?: string }> =>
      ipcRenderer.invoke("scelo:fs:lintPython", rel),
    lintR: (
      rel: string,
    ): Promise<{ ok: boolean; diagnostics: RLintDiagnostic[]; error?: string; note?: string }> =>
      ipcRenderer.invoke("scelo:fs:lintR", rel),
    saveUnsaved: (
      rel: string,
      content: string,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:fs:saveUnsaved", rel, content),
    loadUnsaved: (
      rel: string,
    ): Promise<{
      ok: boolean;
      present?: boolean;
      content?: string;
      savedAt?: string;
      dropped?: string;
      error?: string;
    }> => ipcRenderer.invoke("scelo:fs:loadUnsaved", rel),
    clearUnsaved: (rel: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:fs:clearUnsaved", rel),
  },
  updater: {
    getChannel: (): Promise<{ channel: "latest" | "beta" }> =>
      ipcRenderer.invoke("scelo:updater:channel:get"),
    setChannel: (channel: "latest" | "beta"): Promise<{ channel: string }> =>
      ipcRenderer.invoke("scelo:updater:channel:set", channel),
  },
  data: {
    list: (): Promise<{
      datasets: Array<{
        id: string;
        label: string;
        blurb: string;
        url: string;
        filename: string;
        approxBytes: number;
        usedBy: string;
      }>;
    }> => ipcRenderer.invoke("scelo:data:list"),
    status: (
      id: string,
    ): Promise<{
      available: boolean;
      sizeBytes: number;
      path: string | null;
      extractedDir: string;
      partialBytes: number;
      error?: string;
    }> => ipcRenderer.invoke("scelo:data:status", id),
    download: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:data:download", id),
    cancel: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("scelo:data:cancel", id),
    purge: (id: string): Promise<{ ok: boolean; removedBytes?: number; error?: string }> =>
      ipcRenderer.invoke("scelo:data:purge", id),
    onProgress: (
      cb: (p: {
        id: string;
        receivedBytes: number;
        totalBytes: number;
        done?: boolean;
        error?: string;
      }) => void,
    ) => {
      const listener = (
        _e: unknown,
        p: {
          id: string;
          receivedBytes: number;
          totalBytes: number;
          done?: boolean;
          error?: string;
        },
      ) => cb(p);
      ipcRenderer.on("scelo:data:progress", listener);
      return () => ipcRenderer.removeListener("scelo:data:progress", listener);
    },
  },
  tools: {
    ripgrepPath: (): Promise<{ path: string | null }> =>
      ipcRenderer.invoke("scelo:tools:ripgrepPath"),
  },
  lsp: {
    start: (lang: "python" | "r"): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:lsp:start", lang),
    stop: (lang?: "python" | "r"): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("scelo:lsp:stop", lang),
    send: (lang: "python" | "r", message: unknown): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("scelo:lsp:send", lang, message),
    onMessage: (cb: (lang: "python" | "r", m: unknown) => void) => {
      const listener = (_e: unknown, lang: "python" | "r", m: unknown) => cb(lang, m);
      ipcRenderer.on("scelo:lsp:message", listener);
      return () => ipcRenderer.removeListener("scelo:lsp:message", listener);
    },
  },
});
