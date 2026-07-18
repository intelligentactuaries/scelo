// Scelo IDE — Electron main process.
//
// Responsibilities:
//   1. Boot the BrowserWindow, load the apps/web built renderer.
//   2. Resolve paths to the bundled Python + R runtimes (extraResources/runtime).
//   3. Handle IPC: window.scelo.runPython / runR spawn the bundled interpreter
//      and stream stdout/stderr back to the renderer.
//
// The renderer is a copy of the apps/web Vite dist (no dev-server needed in
// production — the file:// URL points straight at resources/renderer/index.html).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  net,
  BrowserWindow,
  type IpcMainInvokeEvent,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  shell,
} from "electron";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import {
  type WorkspaceUIState,
  migrateWorkspaceStateToV1,
  runStartupMigrations,
} from "./migrations";

// electron-log captures uncaught errors + autoUpdater chatter into
// ~/.config/Scelo IDE/logs/main.log on Linux / equivalents per OS.
log.initialize();
autoUpdater.logger = log;

// Renderer V8 heap: Chromium's default (~4 GB old-space) OOMs mid-parse on
// large dataset imports. 8192 MB is a machine-independent ceiling — V8 only
// commits what it actually uses. Must be appended before app ready.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

/** In dev: resources/* live next to the source tree. In a packaged app
 *  (electron-builder asar), extraResources land in process.resourcesPath. */
function resourceDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  return join(__dirname, "..", "resources");
}

function rendererRoot(): string {
  return join(resourceDir(), "renderer");
}

function rendererIndex(): string {
  return join(rendererRoot(), "index.html");
}

// ─── scelo:// custom protocol ───────────────────────────────────────────
//
// apps/web uses BrowserRouter, which reads window.location.pathname. Under
// file:// that pathname is the full disk path to index.html — the router
// matches nothing. Registering scelo:// with a SPA-style handler gives us
// a stable origin so the router sees clean paths like /dashboards/scelo
// and asset URLs like /assets/index-abc.js resolve to the right file.
const SCELO_SCHEME = "scelo";

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCELO_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function registerSceloProtocol(): void {
  protocol.handle(SCELO_SCHEME, async (request) => {
    const url = new URL(request.url);
    // Strip query / hash; resolve the path under the renderer dir.
    let pathname = decodeURIComponent(url.pathname);
    // Guard against ../ traversal — normalize then re-anchor under rendererRoot.
    pathname = normalize(pathname).replace(/^([./\\])+/, "");
    const candidate = join(rendererRoot(), pathname);

    // SPA fallback: anything without a file extension (a route) serves index.html.
    // Assets get served directly. This is the same shape Vercel / Netlify use.
    const isAsset = /\.[a-z0-9]+$/i.test(pathname);
    const target = isAsset && existsSync(candidate) ? candidate : rendererIndex();
    return net.fetch(pathToFileURL(target).toString());
  });
}

/** Path to the bundled Python interpreter staged by scripts/bundle-runtimes.sh.
 *  Per-platform layout matches python-build-standalone's tarballs. */
function pythonBinary(): string | null {
  const root = join(resourceDir(), "runtime", "python");
  const candidate = isWin ? join(root, "python.exe") : join(root, "bin", "python3");
  return existsSync(candidate) ? candidate : null;
}

/** Path to the bundled R interpreter (R-portable on Win, R.framework on mac,
 *  static R on Linux). Stub-friendly: returns null when the runtime hasn't
 *  been bundled, so the renderer can show an "install missing" prompt. */
function rBinary(): string | null {
  const root = join(resourceDir(), "runtime", "r");
  const candidate = isWin
    ? join(root, "bin", "R.exe")
    : isMac
      ? join(root, "Resources", "bin", "R")
      : join(root, "bin", "R");
  return existsSync(candidate) ? candidate : null;
}

/** Path to the bundled Rscript front-end (the non-interactive runner).
 *  Used on Windows to run R scripts from a temp file — see execRScript(). */
function rscriptBinary(): string | null {
  const root = join(resourceDir(), "runtime", "r");
  const candidate = isWin
    ? join(root, "bin", "Rscript.exe")
    : isMac
      ? join(root, "Resources", "bin", "Rscript")
      : join(root, "bin", "Rscript");
  return existsSync(candidate) ? candidate : null;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: "Scelo IDE",
    backgroundColor: "#E8E4D8", // matches the cream theme in apps/web/styles/theme.css
    autoHideMenuBar: !isMac,
    icon: join(resourceDir(), "icons", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses child_process; sandbox would block it
    },
  });

  // External links open in the system browser, not in a child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Right-click context menu (copy / paste / cut / select-all, spelling
  // suggestions, link + image actions). Chromium gives us no menu by default
  // in a custom Electron shell, so the whole IDE felt "dead" on right-click.
  attachContextMenu(win);

  // A renderer that dies (OOM during a huge import, GPU crash, external
  // kill) would otherwise leave a permanently dead white window. Log why
  // and offer a reload so the user can recover without restarting the app.
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return; // normal teardown
    log.error(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (win.isDestroyed()) return;
    void dialog
      .showMessageBox(win, {
        type: "error",
        title: "Scelo IDE",
        message: "This window's renderer process stopped unexpectedly.",
        detail:
          `Reason: ${details.reason} (exit code ${details.exitCode}). ` +
          "If this happened during a large data import, it likely ran out of memory. " +
          "Reload the window to keep working.",
        buttons: ["Reload", "Close window"],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return;
        if (response === 0) win.webContents.reload();
        else win.close();
      });
  });

  // Drop the per-window workspace override when the window closes so
  // _windowWorkspace doesn't accumulate stale webContents ids across
  // reloads / new-window cycles. Capture the id NOW : by the time
  // `closed` fires the BrowserWindow + webContents are already
  // destroyed and dereferencing them throws "Object has been destroyed".
  const webContentsId = win.webContents.id;
  win.on("closed", () => {
    _windowWorkspace.delete(webContentsId);
  });

  // Renderer is the built apps/web SPA, served via the scelo:// protocol so
  // BrowserRouter sees clean paths. First launch lands on /runtime-check to
  // surface the bundled-stack status (Python + R + IA packages); every
  // subsequent launch goes straight to /dashboards/scelo. A first-run marker
  // is persisted under app.getPath("userData").
  const indexFile = rendererIndex();
  if (!existsSync(indexFile)) {
    // Fail loud and useful — the most common cause is forgetting `bun run build:renderer`.
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<html><body style="font-family:system-ui;padding:40px;background:#E8E4D8;color:#181715">` +
            `<h1>Scelo IDE</h1>` +
            `<p>Renderer not found at <code>${indexFile}</code>.</p>` +
            `<p>From <code>apps/scelo-ide</code> run:</p>` +
            `<pre>bun run build:renderer</pre>` +
            `</body></html>`,
        ),
    );
  } else {
    win.loadURL(`${SCELO_SCHEME}://app${initialRoute()}`);
  }

  return win;
}

// Native right-click menu, assembled per-click from the Chromium context
// params so it offers exactly what's relevant: clipboard ops on editable
// fields / selections (driven by editFlags so greyed-out items reflect what's
// actually possible), spelling fixes on a misspelled word, link + image
// actions, and Inspect Element in dev builds. Roles ('cut'/'copy'/'paste'/
// 'selectAll') let Chromium perform the action on the focused element, so it
// works in Monaco, the terminal, inputs, and ordinary selectable text alike.
function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    const flags = params.editFlags;
    const hasSelection = params.selectionText.trim().length > 0;

    // Spelling suggestions for a misspelled word in an editable field.
    if (params.isEditable && params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      }
      if (params.dictionarySuggestions.length === 0) {
        items.push({ label: "No spelling suggestions", enabled: false });
      }
      items.push({
        label: "Add to dictionary",
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: "separator" });
    }

    if (params.isEditable || hasSelection) {
      items.push(
        { role: "cut", enabled: flags.canCut },
        { role: "copy", enabled: flags.canCopy },
        { role: "paste", enabled: flags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    }

    if (params.linkURL) {
      if (items.length) items.push({ type: "separator" });
      items.push(
        { label: "Open link in browser", click: () => shell.openExternal(params.linkURL) },
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
      );
    }

    if (params.mediaType === "image" && params.srcURL) {
      if (items.length) items.push({ type: "separator" });
      items.push(
        {
          label: "Copy image",
          click: () => win.webContents.copyImageAt(params.x, params.y),
        },
        { label: "Copy image address", click: () => clipboard.writeText(params.srcURL) },
      );
    }

    // Dev-only inspector — handy while building, hidden in packaged builds.
    if (!app.isPackaged) {
      if (items.length) items.push({ type: "separator" });
      items.push({
        label: "Inspect element",
        click: () => win.webContents.inspectElement(params.x, params.y),
      });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

/** Initial route picker:
 *   • Truly-first launch (no marker, no workspaces) → /runtime-check so
 *     the user sees the bundled-stack status report up front.
 *   • Subsequent launches with workspaces registered → /workspace, so
 *     they land in their editor without an extra click.
 *   • Subsequent launches with no workspaces → /workspace anyway; the
 *     first-run splash inside the page invites them to pick a folder
 *     (better than dumping them on the Scelo dashboard with no context).
 *   • Hard fallback if we can't read state → /dashboards/scelo (the
 *     Scelo brain map is the safest "did I install this right?" landing).
 */
function initialRoute(): string {
  const marker = join(app.getPath("userData"), ".first-run-complete");
  const firstLaunch = !existsSync(marker);
  if (firstLaunch) {
    try {
      require("node:fs").writeFileSync(marker, "");
    } catch {
      // If we can't write the marker, just show runtime-check every launch —
      // not the end of the world. Better than failing to launch.
    }
    return "/runtime-check";
  }
  try {
    const reg = _readRegistry();
    if (reg.workspaces.length > 0) return "/workspace";
    return "/workspace"; // first-run splash will show
  } catch {
    return "/dashboards/scelo";
  }
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open workspace…",
          accelerator: isMac ? "Cmd+O" : "Ctrl+O",
          // `focusedWindow` is the BrowserWindow the user invoked the
          // menu from — using `getAllWindows()[0]` (the old behaviour)
          // always targeted the first window, which is wrong as soon as
          // a second window exists. Falls back to any window so the
          // menu still works when invoked from the macOS dock with no
          // BrowserWindow focused.
          click: async (_menuItem, focusedWindow) => {
            const win =
              (focusedWindow as BrowserWindow | undefined) ?? BrowserWindow.getAllWindows()[0];
            if (!win) return;
            const res = await dialog.showOpenDialog(win, {
              properties: ["openDirectory", "createDirectory"],
            });
            if (!res.canceled && res.filePaths[0]) {
              _setActiveWorkspace(res.filePaths[0]);
              win.loadURL(`${SCELO_SCHEME}://app/workspace`);
            }
          },
        },
        {
          label: "Switch workspace…",
          accelerator: isMac ? "Cmd+Shift+O" : "Ctrl+Shift+O",
          click: (_menuItem, focusedWindow) => {
            const win =
              (focusedWindow as BrowserWindow | undefined) ?? BrowserWindow.getAllWindows()[0];
            if (!win) return;
            win.loadURL(`${SCELO_SCHEME}://app/settings/workspaces`);
          },
        },
        {
          label: "New Window",
          accelerator: isMac ? "Cmd+N" : "Ctrl+N",
          click: () => {
            // Each window gets its own BrowserWindow but shares the
            // process-wide singletons (LSP, exec sessions, workspace
            // registry). Diagnostics already broadcast to every
            // subscribed webContents, so a second window pointed at the
            // same workspace gets the same red squiggles. macOS-style
            // window-per-workspace lives in Phase 16.
            createMainWindow();
          },
        },
        { type: "separator" as const },
        {
          label: "Close Window",
          accelerator: isMac ? "Cmd+W" : "Ctrl+W",
          role: "close" as const,
        },
        isMac ? { role: "close" as const } : { role: "quit" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    // macOS convention: a Window menu with minimize / zoom / front, plus
    // every open BrowserWindow as a tickable entry. Electron's
    // `windowMenu` role assembles all of this automatically. On
    // Linux/Windows we keep a tighter custom Window menu so users still
    // have keyboard-accessible window management.
    ...(isMac
      ? ([
          {
            label: "Window",
            role: "windowMenu" as const,
          },
        ] as Electron.MenuItemConstructorOptions[])
      : ([
          {
            label: "Window",
            submenu: [
              { role: "minimize" as const },
              { role: "zoom" as const },
              { type: "separator" as const },
              {
                label: "Close Window",
                accelerator: "Ctrl+W",
                role: "close" as const,
              },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])),
    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: () =>
            shell.openExternal("https://github.com/intelligentactuaries/intelligentactuaries"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC: bundled-runtime exec ──────────────────────────────────────────
//
// Renderer-facing API (exposed via preload.cjs as window.scelo):
//   runPython({ script }) → { ok: boolean, stdout: string, stderr: string }
//   runR({ script })      → same shape
//
// Both write the script to a temp file and exec the bundled interpreter with
// `-c file` semantics. Long-running streams will be added in Phase 2 — for now
// the API is buffered so the renderer code can be simple.

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

/** Absorb 'error' events on a child's stdin. A child that exits before
 *  draining its stdin raises EPIPE (EOF on Windows) on the stream; with no
 *  listener Node escalates that to an uncaught exception in the MAIN
 *  process. The child's own 'error'/'close' events still report the real
 *  outcome, so the stream error only needs to be observed (optionally
 *  folded into collected stderr). Attach before the first write. */
function guardStdin(child: ChildProcess, onError?: (err: Error) => void): void {
  child.stdin?.on("error", (err) => onError?.(err));
}

function execRuntime(
  binary: string | null,
  runtimeFlag: string,
  req: ExecRequest,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (!binary) {
      resolve({
        ok: false,
        stdout: "",
        stderr: `bundled ${runtimeFlag} runtime not installed`,
        exitCode: null,
      });
      return;
    }
    const child = spawn(binary, [runtimeFlag, req.script, ...(req.argv ?? [])], {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let stdinErr = "";
    guardStdin(child, (err) => {
      stdinErr = `[stdin] ${String(err)}`;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      // A child that dies before draining stdin raises EPIPE on our side —
      // pure noise when the child also reported WHY it died. Only surface
      // the stdin error when there is nothing better, so "bridge failed:
      // [stdin] write EPIPE" stops masking "No module named statsmodels".
      const err = stderr.trim().length > 0 ? stderr : stdinErr;
      resolve({ ok: code === 0, stdout, stderr: err, exitCode: code });
    });
    child.on("error", (err) =>
      resolve({ ok: false, stdout, stderr: stderr + String(err), exitCode: null }),
    );
    if (req.stdin !== undefined) {
      // write+end queues the whole payload in memory and Node flushes it in
      // the background; no 'drain' handling is needed for correctness, only
      // to bound memory — payloads here are scripts, not datasets.
      child.stdin.write(req.stdin);
      child.stdin.end();
    }
  });
}

/** Run an R script and buffer its output (drop-in for execRuntime for R).
 *
 *  macOS/Linux: unchanged — `R [--vanilla] -e <script> [--args …]` (the shell
 *  wrapper execs the interpreter cleanly). **Windows:** the `R.exe` front-end
 *  silently mangles any multi-line / quoted `-e` payload — it drops into an
 *  interactive Rterm and never runs the script (banner-only stdout, exit 0
 *  or non-zero) — so we write the script to a temp `.R` file and run it with
 *  `Rscript.exe`, the only invocation that survives Windows argument handling.
 *  Trailing `args` reach the script as commandArgs(trailingOnly = TRUE) on
 *  both paths. */
function execRScript(
  script: string,
  opts: {
    args?: string[];
    vanilla?: boolean;
    slave?: boolean;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = opts.args ?? [];
    const flags = [...(opts.vanilla ? ["--vanilla"] : []), ...(opts.slave ? ["--slave"] : [])];
    let bin: string | null;
    let argv: string[] = [];
    let cleanup = (): void => {};
    if (isWin) {
      bin = rscriptBinary();
      if (bin) {
        const dir = mkdtempSync(join(app.getPath("temp"), "scelo-r-"));
        const file = join(dir, "script.R");
        writeFileSync(file, script, "utf8");
        argv = [...flags, file, ...args];
        cleanup = () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort — temp dir */
          }
        };
      }
    } else {
      bin = rBinary();
      argv = [...flags, "-e", script, ...(args.length ? ["--args", ...args] : [])];
    }
    if (!bin) {
      resolve({ ok: false, stdout: "", stderr: "bundled r runtime not installed", exitCode: null });
      return;
    }
    const child = spawn(bin, argv, { env: opts.env ?? process.env, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    guardStdin(child, (err) => {
      stderr += `[stdin] ${String(err)}\n`;
    });
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const finish = (res: ExecResult) => {
      cleanup();
      resolve(res);
    };
    child.on("close", (code) => finish({ ok: code === 0, stdout, stderr, exitCode: code }));
    child.on("error", (err) =>
      finish({ ok: false, stdout, stderr: stderr + String(err), exitCode: null }),
    );
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

ipcMain.handle("scelo:runPython", (_event, req: ExecRequest) =>
  execRuntime(pythonBinary(), "-c", req),
);

ipcMain.handle("scelo:runR", (_event, req: ExecRequest) =>
  execRScript(req.script, { args: req.argv, stdin: req.stdin }),
);

// ─── LLM bridge ─────────────────────────────────────────────────────────
//
// The chat surface and the AI-provider "test connection" button used to POST
// to /api/agents/orchestrator/{stream,test} — a FastAPI orchestrator that the
// desktop build never ships or spawns. Those requests fell through to the
// scelo:// SPA handler, which returned index.html, so the renderer choked on
// `<!doctype …` (not JSON) and chat replies came back empty. Here we instead
// call the provider's HTTP API directly from the main process, where there is
// no CORS restriction and we hold the decrypted key. One request/response per
// call (no streaming) — the renderer renders the whole reply at once.

type LlmRole = "system" | "user" | "assistant";
interface LlmMessage {
  role: LlmRole;
  content: string;
}
interface LlmChatRequest {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  messages: LlmMessage[];
  maxTokens?: number;
}
interface LlmChatResult {
  ok: boolean;
  text?: string;
  error?: string;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

// Pull a short, human-readable error out of a non-2xx provider response.
async function providerHttpError(resp: Response): Promise<string> {
  let detail = "";
  try {
    const raw = await resp.text();
    try {
      const j = JSON.parse(raw);
      detail = j?.error?.message ?? j?.error ?? j?.message ?? raw;
    } catch {
      detail = raw;
    }
  } catch {
    detail = resp.statusText;
  }
  if (typeof detail !== "string") detail = JSON.stringify(detail);
  return `HTTP ${resp.status}: ${detail.slice(0, 300)}`;
}

// OpenAI-compatible chat completions — covers openrouter, openai, ollama's
// /v1 shim, and any openai_compat endpoint. `url` is the full endpoint.
async function chatOpenAICompatible(
  url: string,
  apiKey: string | undefined,
  req: LlmChatRequest,
): Promise<LlmChatResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // OpenRouter asks for these attribution headers; harmless elsewhere.
  if (req.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://scelo.ai";
    headers["X-Title"] = "Scelo IDE";
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 1024,
    }),
  });
  if (!resp.ok) return { ok: false, error: await providerHttpError(resp) };
  const data = (await resp.json()) as {
    choices?: Array<{
      finish_reason?: string;
      // `content` is usually a plain string, but some OpenRouter models
      // return an array of typed parts. Reasoning models (gpt-oss, R1, …)
      // may leave `content` empty and put visible text under `reasoning`.
      message?: {
        content?: string | Array<{ text?: string }> | null;
        reasoning?: string;
      };
    }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((p) => p?.text ?? "").join("");
  // Fall back to the reasoning channel when the model emitted no content.
  if (!text.trim() && choice?.message?.reasoning) text = choice.message.reasoning;
  // A reasoning model whose token budget was fully consumed before it
  // produced any answer — surface that instead of a blank reply so the
  // caller doesn't read empty text as a silent success.
  if (!text.trim() && choice?.finish_reason === "length") {
    return {
      ok: false,
      error:
        "The model hit its token limit before replying (it's likely a reasoning model that spent the budget thinking). Raise max tokens or pick a non-reasoning model.",
    };
  }
  return { ok: true, text };
}

async function chatAnthropic(req: LlmChatRequest): Promise<LlmChatResult> {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": req.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      ...(system ? { system } : {}),
      messages: turns,
    }),
  });
  if (!resp.ok) return { ok: false, error: await providerHttpError(resp) };
  const data = (await resp.json()) as { content?: Array<{ text?: string }> };
  const text = (data.content ?? [])
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  return { ok: true, text };
}

async function chatGemini(req: LlmChatRequest): Promise<LlmChatResult> {
  const model = req.model || "gemini-1.5-flash";
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(req.apiKey ?? "")}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }),
  });
  if (!resp.ok) return { ok: false, error: await providerHttpError(resp) };
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return { ok: true, text };
}

// ── Claude Code provider ─────────────────────────────────────────────────
//
// Unlike the hosted providers, this one needs no API key: it shells out to
// the locally-installed, already-signed-in `claude` CLI in headless mode
// (`claude -p`), reusing the user's Claude Code subscription auth. The prompt
// goes in on stdin (no arg-length / quoting limits), the reply comes back as
// JSON on stdout. We replace the agentic system prompt with a lean chat one
// and pass --strict-mcp-config so no MCP servers spin up for a plain reply.

/** How to launch the claude CLI. On Windows a global npm/bun install often
 *  exposes only a .cmd/.bat script shim, which libuv refuses to spawn
 *  without a shell (EINVAL since Node 20's spawn hardening). We prefer a
 *  real .exe, then unwrap the shim to its node script, and only as a last
 *  resort run the shim through cmd.exe with quoted args. */
interface ClaudeLaunch {
  bin: string;
  /** Args injected before the CLI's own flags (e.g. the unwrapped cli.js). */
  argPrefix: string[];
  /** True when bin must go through cmd.exe (`shell: true`). */
  viaShell: boolean;
}

let _claudeLaunch: ClaudeLaunch | null | undefined; // undefined = unresolved, null = absent

/** Unwrap an npm cmd-shim to the node script it targets. The generated
 *  .cmd contains a quoted `%dp0%`-relative path to the JS entry (e.g.
 *  `"%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*`). Returns a
 *  direct `node <script>` launch (no shell, so multi-line args survive),
 *  or null when the shim doesn't match or node isn't on PATH. */
function _unwrapCmdShim(shimPath: string): ClaudeLaunch | null {
  try {
    const text = readFileSync(shimPath, "utf-8");
    const m = /"%(?:~dp0|dp0%)\\([^"]+\.[cm]?js)"/i.exec(text);
    if (!m) return null;
    const target = join(shimPath, "..", m[1]);
    if (!existsSync(target)) return null;
    execFileSync(isWin ? "where" : "which", ["node"], { encoding: "utf-8" });
    return { bin: "node", argPrefix: [target], viaShell: false };
  } catch {
    return null;
  }
}

function _claudeLaunchFor(bin: string): ClaudeLaunch {
  if (isWin && /\.(cmd|bat)$/i.test(bin)) {
    return _unwrapCmdShim(bin) ?? { bin, argPrefix: [], viaShell: true };
  }
  return { bin, argPrefix: [], viaShell: false };
}

function resolveClaudeLaunch(): ClaudeLaunch | null {
  if (_claudeLaunch !== undefined) return _claudeLaunch;
  const override = process.env.SCELO_CLAUDE_BIN;
  if (override) {
    _claudeLaunch = _claudeLaunchFor(override);
    return _claudeLaunch;
  }
  try {
    const out = execFileSync(isWin ? "where" : "which", ["claude"], {
      encoding: "utf-8",
    });
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Prefer a real executable over a .cmd/.ps1/.bat shim on Windows — libuv's
    // spawn (shell:false) resolves .exe directly but not script shims. A bare
    // extensionless hit (the sh-script sibling) is the worst candidate, so
    // .cmd/.bat outranks it.
    const exe = lines.find((l) => /\.exe$/i.test(l));
    const cmdShim = lines.find((l) => /\.(cmd|bat)$/i.test(l));
    const chosen = exe ?? cmdShim ?? lines[0] ?? null;
    _claudeLaunch = chosen ? _claudeLaunchFor(chosen) : null;
  } catch {
    _claudeLaunch = null;
  }
  return _claudeLaunch;
}

/** Quote one argument for the cmd.exe fallback (`shell: true`). cmd cannot
 *  carry newlines in an argument and has no escape for embedded double
 *  quotes that survives both cmd and the CLI's own argv parsing, so both
 *  fold to benign characters — acceptable for the prose this path carries. */
function _cmdArg(arg: string): string {
  return `"${arg.replace(/\r?\n/g, " ").replace(/"/g, "'")}"`;
}

const CLAUDE_CODE_MISSING =
  "Claude Code CLI not found. Install it from https://claude.com/claude-code and sign in once (run `claude`), then retry. No API key needed — Scelo reuses your Claude Code login.";

async function chatClaudeCode(req: LlmChatRequest): Promise<LlmChatResult> {
  const launch = resolveClaudeLaunch();
  if (!launch) return { ok: false, error: CLAUDE_CODE_MISSING };

  const systemText = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const turns = req.messages.filter((m) => m.role !== "system");
  // A single user turn passes verbatim; a multi-turn thread becomes a labelled
  // transcript so the CLI (one-shot -p) still sees the conversation.
  const prompt =
    turns.length === 1 && turns[0].role === "user"
      ? turns[0].content
      : turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  const system = `${systemText ? `${systemText}\n\n` : ""}Answer directly and concisely in plain text. Do not use tools, do not read or write files, do not run commands — this is a chat reply.`;

  const args = [
    ...launch.argPrefix,
    "-p",
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--system-prompt",
    system,
  ];
  if (req.model) args.push("--model", req.model);

  return new Promise<LlmChatResult>((resolve) => {
    let child: ChildProcess;
    try {
      // Script shims must go through cmd.exe; everything else spawns
      // directly so args (incl. the multi-line system prompt) pass verbatim.
      child = launch.viaShell
        ? spawn(_cmdArg(launch.bin), args.map(_cmdArg), {
            env: process.env,
            windowsHide: true,
            shell: true,
          })
        : spawn(launch.bin, args, { env: process.env, windowsHide: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      resolve(
        code === "EINVAL" || code === "ENOENT"
          ? { ok: false, error: CLAUDE_CODE_MISSING }
          : {
              ok: false,
              error: `failed to launch Claude Code CLI: ${e instanceof Error ? e.message : String(e)}`,
            },
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: LlmChatResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done({ ok: false, error: "Claude Code CLI timed out after 180s." });
    }, 180_000);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      // ENOENT: `where` found a shim we couldn't actually spawn. EINVAL:
      // libuv refusing a .cmd/.bat without a shell (Node 20+). Both mean the
      // install isn't usable as found — reuse the install guidance.
      const code = (e as NodeJS.ErrnoException).code;
      done({
        ok: false,
        error:
          code === "ENOENT" || code === "EINVAL"
            ? CLAUDE_CODE_MISSING
            : `Claude Code CLI error: ${e.message}`,
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        done({
          ok: false,
          error: `Claude Code CLI exited ${code}: ${(stderr || stdout).slice(0, 400) || "no output"}`,
        });
        return;
      }
      try {
        const data = JSON.parse(stdout) as {
          is_error?: boolean;
          result?: string;
          subtype?: string;
        };
        if (data.is_error) {
          done({
            ok: false,
            error: `Claude Code: ${data.subtype ?? "error"} — ${(data.result ?? "").slice(0, 400)}`,
          });
          return;
        }
        done({ ok: true, text: (data.result ?? "").trim() });
      } catch {
        // Older CLI without --output-format json — treat stdout as the reply.
        done({ ok: true, text: stdout.trim() });
      }
    });
    // Feed the prompt on stdin. Guarded: if the CLI exits before reading
    // (bad flag, auth failure), the EPIPE must not crash the main process.
    guardStdin(child);
    child.stdin?.end(prompt);
  });
}

async function llmChat(req: LlmChatRequest): Promise<LlmChatResult> {
  try {
    switch (req.provider) {
      case "claude_code":
        return await chatClaudeCode(req);
      case "openrouter":
        return await chatOpenAICompatible(
          "https://openrouter.ai/api/v1/chat/completions",
          req.apiKey,
          req,
        );
      case "openai":
        return await chatOpenAICompatible(
          "https://api.openai.com/v1/chat/completions",
          req.apiKey,
          req,
        );
      case "anthropic":
        return await chatAnthropic(req);
      case "gemini":
        return await chatGemini(req);
      case "ollama": {
        const base = trimTrailingSlash(req.baseUrl || "http://localhost:11434/v1");
        return await chatOpenAICompatible(`${base}/chat/completions`, undefined, {
          ...req,
          model: req.model || "qwen2.5:7b-instruct",
        });
      }
      case "openai_compat": {
        if (!req.baseUrl)
          return { ok: false, error: "base URL required for OpenAI-compatible provider" };
        const base = trimTrailingSlash(req.baseUrl);
        return await chatOpenAICompatible(`${base}/chat/completions`, req.apiKey, req);
      }
      default:
        return { ok: false, error: `unknown provider: ${req.provider}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

ipcMain.handle(
  "scelo:llm:chat",
  (_event, req: LlmChatRequest): Promise<LlmChatResult> => llmChat(req),
);

// ─── Streaming exec ─────────────────────────────────────────────────────
//
// `scelo:exec:start` spawns a child and returns a sessionId. Each chunk
// is pushed to the renderer via `webContents.send('scelo:exec:chunk', {sessionId, stream, data})`,
// and a `scelo:exec:end` event is sent when the process exits. The
// renderer subscribes via `window.scelo.runStream(opts, callbacks)`.
//
// Why a separate channel instead of extending the buffered handler:
// `ipcMain.handle` is request/response — perfect for the buffered path
// but useless for streaming. We pair `handle` to start the process with
// `send` events for chunks; cancellation is a `handle("scelo:exec:cancel")`.

interface StreamExecRequest {
  runtime: "python" | "r" | "shell";
  script?: string; // -c / -e payload (python/r only)
  command?: string; // raw shell command (shell only)
  argv?: string[];
  stdin?: string;
  cwd?: string; // optional working dir
}

// Session value is either a regular child_process (python/r runs + the
// spawn-fallback shell) or a node-pty pseudo-terminal (the proper shell
// experience: full readline, curses, signal forwarding).
type PtyHandle = {
  kind: "pty";
  pty: {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: (signal?: string) => void;
  };
};
type SpawnHandle = { kind: "spawn"; child: ChildProcess };
type ExecHandle = PtyHandle | SpawnHandle;

const _execSessions = new Map<string, ExecHandle>();
let _execSessionSeq = 0;

// Lazy-load node-pty so a failure (native module didn't load, missing
// platform binaries) leaves the spawn-fallback path intact. We probe
// once on first need and cache the result.
type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv },
  ) => {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    kill: (signal?: string) => void;
    onData: (cb: (data: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
  };
};
// Windows shell selection: cmd.exe is universally present but old; PowerShell
// (`powershell.exe`) ships with every Windows; pwsh.exe (PowerShell 7) is
// installed alongside modern dev tools. Probe in order, cache the result.
let _winShellCached: string | undefined;
function _winShell(): string {
  if (_winShellCached) return _winShellCached;
  if (!isWin) return "/bin/bash";
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    for (const candidate of ["pwsh.exe", "powershell.exe", "cmd.exe"]) {
      try {
        execFileSync("where", [candidate], { encoding: "utf-8" });
        _winShellCached = candidate;
        return candidate;
      } catch {
        // not found, try next
      }
    }
  } catch {
    // `where` not on PATH (unlikely on Windows). Default.
  }
  _winShellCached = "cmd.exe";
  return _winShellCached;
}

let _ptyProbe: PtyModule | null | undefined;
function _loadPty(): PtyModule | null {
  if (_ptyProbe !== undefined) return _ptyProbe;
  try {
    // require() bypasses TS module-resolution which doesn't ship a typing
    // for the prebuilt variant. The shape we use matches upstream node-pty
    // 1:1 — only spawn/write/resize/kill/onData/onExit.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require("@homebridge/node-pty-prebuilt-multiarch");
    log.info("node-pty: loaded prebuilt module");
    _ptyProbe = m as PtyModule;
  } catch (e) {
    log.warn("node-pty: load failed, terminal falls back to spawn (no PTY features):", e);
    _ptyProbe = null;
  }
  return _ptyProbe;
}

function _nextSessionId(): string {
  _execSessionSeq += 1;
  return `exec-${Date.now().toString(36)}-${_execSessionSeq}`;
}

/** Compose a PATH-like env that puts the bundled runtimes ahead of system
 *  binaries, so a terminal session sees the IDE's python/R first. */
function _augmentedEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...(extra ?? {}) };
  const bundledBins: string[] = [];
  const pyRoot = join(resourceDir(), "runtime", "python");
  if (existsSync(pyRoot)) {
    bundledBins.push(isWin ? pyRoot : join(pyRoot, "bin"));
  }
  const rRoot = join(resourceDir(), "runtime", "r");
  if (existsSync(rRoot)) {
    bundledBins.push(
      isWin ? join(rRoot, "bin") : isMac ? join(rRoot, "Resources", "bin") : join(rRoot, "bin"),
    );
  }
  if (bundledBins.length > 0) {
    const sepc = isWin ? ";" : ":";
    env.PATH = `${bundledBins.join(sepc)}${sepc}${env.PATH ?? ""}`;
  }
  return env;
}

ipcMain.handle(
  "scelo:exec:start",
  (
    event: IpcMainInvokeEvent,
    req: StreamExecRequest,
  ): { sessionId: string } | { error: string } => {
    let binary: string | null = null;
    let argv: string[] = [];
    // Set when the R script was staged to a temp file (Windows path below);
    // invoked once the child exits so we don't leak temp dirs.
    let rTempCleanup: (() => void) | null = null;
    if (req.runtime === "python") {
      binary = pythonBinary();
      if (!binary) return { error: "bundled python runtime not installed" };
      argv = ["-c", req.script ?? "", ...(req.argv ?? [])];
    } else if (req.runtime === "r") {
      // `R.exe -e <script>` is mangled on Windows (see execRScript): on Windows
      // run the script from a temp .R file via Rscript; keep `R -e` elsewhere.
      if (isWin) {
        binary = rscriptBinary();
        if (!binary) return { error: "bundled r runtime not installed" };
        const dir = mkdtempSync(join(app.getPath("temp"), "scelo-r-"));
        const file = join(dir, "script.R");
        writeFileSync(file, req.script ?? "", "utf8");
        argv = [file, ...(req.argv ?? [])];
        rTempCleanup = () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort — temp dir */
          }
        };
      } else {
        binary = rBinary();
        if (!binary) return { error: "bundled r runtime not installed" };
        argv = ["-e", req.script ?? "", ...(req.argv ?? [])];
      }
    } else if (req.runtime === "shell") {
      // Real PTY when node-pty loaded, falling back to spawn otherwise.
      // PTY path enables full readline / curses (ipython, R interactive
      // REPL, htop, vim) — actuaries usually expect ipython at minimum.
      const pty = _loadPty();
      const sessionId = _nextSessionId();
      const wc = event.sender;
      const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : undefined;
      if (pty) {
        // Pick the friendliest shell available per OS:
        //   - mac/linux: $SHELL (zsh on modern macs, bash on most Linux).
        //   - Windows: prefer pwsh.exe > powershell.exe > cmd.exe. ConPTY
        //     (the modern Win10+ console host) is auto-selected by node-pty
        //     when present — older systems silently fall back to winpty.
        let shellBin: string;
        let shellArgv: string[];
        if (isWin) {
          shellBin = _winShell();
          shellArgv = req.command
            ? shellBin.toLowerCase().endsWith("cmd.exe")
              ? ["/c", req.command]
              : ["-NoLogo", "-Command", req.command]
            : shellBin.toLowerCase().endsWith("cmd.exe")
              ? []
              : ["-NoLogo"];
        } else {
          shellBin = process.env.SHELL || "/bin/bash";
          shellArgv = req.command ? ["-lc", req.command] : ["-li"];
        }
        try {
          const term = pty.spawn(shellBin, shellArgv, {
            name: "xterm-256color",
            cols: 100,
            rows: 30,
            cwd,
            env: _augmentedEnv() as NodeJS.ProcessEnv,
          });
          _execSessions.set(sessionId, { kind: "pty", pty: term });
          term.onData((data) => {
            if (wc.isDestroyed()) return;
            wc.send("scelo:exec:chunk", { sessionId, stream: "stdout", data });
          });
          term.onExit((e) => {
            _execSessions.delete(sessionId);
            if (!wc.isDestroyed()) {
              wc.send("scelo:exec:end", {
                sessionId,
                exitCode: e.exitCode,
                error: null,
              });
            }
          });
          return { sessionId };
        } catch (e) {
          log.warn("node-pty spawn failed; falling back to spawn():", e);
          // fall through to spawn path below
        }
      }
      // Spawn fallback — no PTY, but baseline functional.
      if (isWin) {
        binary = "cmd.exe";
        argv = ["/c", req.command ?? ""];
      } else {
        binary = process.env.SHELL || "/bin/bash";
        argv = req.command ? ["-lc", req.command] : ["-li"];
      }
    } else {
      return { error: `unknown runtime ${req.runtime}` };
    }

    const sessionId = _nextSessionId();
    const child = spawn(binary, argv, {
      env: _augmentedEnv(),
      cwd: req.cwd && existsSync(req.cwd) ? req.cwd : undefined,
    });
    // stdin is written both below and later via scelo:exec:write — a child
    // that has already exited would otherwise EPIPE-crash the main process.
    guardStdin(child, (err) => log.warn(`exec[${sessionId}]: stdin error`, err));
    _execSessions.set(sessionId, { kind: "spawn", child });

    const wc = event.sender;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (wc.isDestroyed()) return;
      wc.send("scelo:exec:chunk", { sessionId, stream: "stdout", data: chunk.toString() });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (wc.isDestroyed()) return;
      wc.send("scelo:exec:chunk", { sessionId, stream: "stderr", data: chunk.toString() });
    });
    child.on("close", (code) => {
      _execSessions.delete(sessionId);
      rTempCleanup?.();
      if (!wc.isDestroyed()) {
        wc.send("scelo:exec:end", { sessionId, exitCode: code, error: null });
      }
    });
    child.on("error", (err) => {
      _execSessions.delete(sessionId);
      rTempCleanup?.();
      if (!wc.isDestroyed()) {
        wc.send("scelo:exec:end", { sessionId, exitCode: null, error: String(err) });
      }
    });
    if (req.stdin !== undefined && child.stdin) {
      child.stdin.write(req.stdin);
      child.stdin.end();
    }
    return { sessionId };
  },
);

ipcMain.handle("scelo:exec:write", (_event, sessionId: string, data: string) => {
  const h = _execSessions.get(sessionId);
  if (!h) return { ok: false, error: "no such session" };
  if (h.kind === "pty") {
    h.pty.write(data);
    return { ok: true };
  }
  if (!h.child.stdin) return { ok: false, error: "no stdin on session" };
  h.child.stdin.write(data);
  return { ok: true };
});

ipcMain.handle("scelo:exec:resize", (_event, sessionId: string, cols: number, rows: number) => {
  const h = _execSessions.get(sessionId);
  if (!h) return { ok: false, error: "no such session" };
  if (h.kind === "pty") {
    try {
      h.pty.resize(Math.max(1, cols), Math.max(1, rows));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  // spawn() has no PTY to resize — no-op.
  return { ok: true };
});

ipcMain.handle("scelo:exec:cancel", (_event, sessionId: string) => {
  const h = _execSessions.get(sessionId);
  if (!h) return { ok: false, error: "no such session" };
  if (h.kind === "pty") h.pty.kill();
  else h.child.kill();
  _execSessions.delete(sessionId);
  return { ok: true };
});

// ─── Filesystem IPC for the workspace file-browser + editor ────────────
//
// All paths are validated against the active workspace root so a
// compromised renderer can't read /etc/passwd via fs:read. The active
// workspace is set by `scelo:workspace:pick` (Electron dialog) and
// remembered per-IDE under userData.

// Multi-workspace registry. workspaces.json holds the list of known
// workspaces (id + path + last-active timestamp); whichever id has the
// most-recent lastActive is the "active" one for fs / lsp / state IPC.
//
// Backwards-compat: when only the legacy `workspace.json` is present we
// migrate it into the registry on first read so existing installs keep
// their pinned dir without action.
interface WorkspaceRecord {
  id: string;
  path: string;
  lastActive: number; // epoch ms
}

interface WorkspaceRegistry {
  workspaces: WorkspaceRecord[];
}

function _registryFile(): string {
  return join(app.getPath("userData"), "workspaces.json");
}

function _legacyWorkspaceFile(): string {
  return join(app.getPath("userData"), "workspace.json");
}

function _wsIdFor(path: string): string {
  // Stable id from the absolute path so per-workspace state files don't
  // collide across different installs of the IDE. SHA-1 first 12 hex
  // chars is enough — no security claim here, just collision-resistance.
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

function _readRegistry(): WorkspaceRegistry {
  // Modern format first.
  try {
    const raw = readFileSync(_registryFile(), "utf-8");
    const reg = JSON.parse(raw) as WorkspaceRegistry;
    if (Array.isArray(reg.workspaces)) return reg;
  } catch {
    // fall through to migration
  }
  // Legacy single-workspace migration.
  try {
    const raw = readFileSync(_legacyWorkspaceFile(), "utf-8");
    const w = JSON.parse(raw) as { path?: string };
    if (w.path) {
      const reg: WorkspaceRegistry = {
        workspaces: [{ id: _wsIdFor(w.path), path: w.path, lastActive: Date.now() }],
      };
      _writeRegistry(reg);
      return reg;
    }
  } catch {
    // no legacy file either
  }
  return { workspaces: [] };
}

function _writeRegistry(reg: WorkspaceRegistry): void {
  writeFileSync(_registryFile(), JSON.stringify(reg), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Per-window workspace override. Maps webContents.id → workspace id.
 *  When set, the matching IPC handler reads from the override instead
 *  of the most-recently-active global. Pinned on first
 *  `scelo:workspace:get` so each window remembers its starting
 *  workspace even if the global active flips later. */
const _windowWorkspace = new Map<number, string>();

function _activeWorkspaceRecord(): WorkspaceRecord | null {
  const reg = _readRegistry();
  const alive = reg.workspaces.filter((w) => existsSync(w.path));
  if (alive.length === 0) return null;
  alive.sort((a, b) => b.lastActive - a.lastActive);
  return alive[0];
}

/** Resolve the workspace record for the window that originated this
 *  IPC call, falling back to the global most-recently-active when no
 *  per-window override has been set. */
function _activeWorkspaceRecordFor(event?: IpcMainInvokeEvent): WorkspaceRecord | null {
  if (event) {
    const wsId = _windowWorkspace.get(event.sender.id);
    if (wsId) {
      const reg = _readRegistry();
      const rec = reg.workspaces.find((w) => w.id === wsId);
      if (rec && existsSync(rec.path)) return rec;
      // Stale override (workspace was removed) — drop it and fall through.
      _windowWorkspace.delete(event.sender.id);
    }
  }
  return _activeWorkspaceRecord();
}

function _activeWorkspace(event?: IpcMainInvokeEvent): string | null {
  return _activeWorkspaceRecordFor(event)?.path ?? null;
}

function _setActiveWorkspace(path: string): void {
  const reg = _readRegistry();
  const id = _wsIdFor(path);
  const existing = reg.workspaces.find((w) => w.id === id);
  if (existing) {
    existing.lastActive = Date.now();
  } else {
    reg.workspaces.push({ id, path, lastActive: Date.now() });
  }
  _writeRegistry(reg);
}

function _removeWorkspace(id: string): void {
  const reg = _readRegistry();
  reg.workspaces = reg.workspaces.filter((w) => w.id !== id);
  _writeRegistry(reg);
}

/** Reject absolute / parent-traversing paths and anything outside the
 *  active workspace root. Returns the resolved absolute path on success.
 *  When called with an `event`, resolves against the per-window
 *  workspace override (Phase 16); without it, against the global. */
function _resolveInWorkspace(rel: string, event?: IpcMainInvokeEvent): string {
  const ws = _activeWorkspace(event);
  if (!ws) throw new Error("no active workspace");
  const cleaned = normalize(rel).replace(/^([./\\])+/, "");
  const abs = join(ws, cleaned);
  if (!abs.startsWith(ws + sep) && abs !== ws) {
    throw new Error("path escapes workspace");
  }
  return abs;
}

ipcMain.handle("scelo:workspace:get", (event) => {
  const rec = _activeWorkspaceRecordFor(event);
  return rec ? { path: rec.path, id: rec.id } : { path: null, id: null };
});

ipcMain.handle("scelo:workspace:setForWindow", (event, id: string) => {
  // Pin this window to the given workspace. The renderer calls this
  // either explicitly (user picked a workspace inside this window) or
  // implicitly (Workspace.tsx mounts and pins the current active).
  const reg = _readRegistry();
  const rec = reg.workspaces.find((w) => w.id === id);
  if (!rec) return { ok: false, error: "unknown workspace id" };
  if (!existsSync(rec.path)) {
    _removeWorkspace(id);
    return { ok: false, error: "workspace path no longer exists" };
  }
  _windowWorkspace.set(event.sender.id, id);
  // Don't bump rec.lastActive — pinning shouldn't promote a workspace
  // to "most recently active" globally; only switch / pick do that.
  return { ok: true, path: rec.path, id: rec.id };
});

ipcMain.handle("scelo:workspace:registry", () => {
  // Prune dead paths on read so the UI never offers a switch to a deleted dir.
  const reg = _readRegistry();
  const alive = reg.workspaces.filter((w) => existsSync(w.path));
  if (alive.length !== reg.workspaces.length) {
    _writeRegistry({ workspaces: alive });
  }
  return { workspaces: alive.sort((a, b) => b.lastActive - a.lastActive) };
});

ipcMain.handle("scelo:workspace:pick", async (event) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win ?? undefined!, {
    title: "Choose workspace",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return { path: null, id: null };
  _setActiveWorkspace(res.filePaths[0]);
  const id = _wsIdFor(res.filePaths[0]);
  // Pin the picking window to the chosen workspace so subsequent IPCs
  // route correctly even if a sibling window has a different override.
  _windowWorkspace.set(event.sender.id, id);
  return { path: res.filePaths[0], id };
});

ipcMain.handle("scelo:workspace:switch", (event, id: string) => {
  const reg = _readRegistry();
  const target = reg.workspaces.find((w) => w.id === id);
  if (!target) return { ok: false, error: "unknown workspace id" };
  if (!existsSync(target.path)) {
    _removeWorkspace(id);
    return { ok: false, error: "workspace path no longer exists" };
  }
  target.lastActive = Date.now();
  _writeRegistry(reg);
  _windowWorkspace.set(event.sender.id, id);
  return { ok: true, path: target.path, id: target.id };
});

ipcMain.handle("scelo:workspace:remove", (_event, id: string) => {
  _removeWorkspace(id);
  return { ok: true };
});

/** Allow-list of templates shipped under apps/scelo-ide/templates/. The
 *  IPC handler rejects anything not in this set so a renderer can't
 *  trick main into copying arbitrary paths off-disk. */
const SAMPLE_TEMPLATES = [
  "life-pricing",
  "climate-risk",
  "scelo-brain",
  "reserving",
  "soa-exams",
] as const;
type SampleTemplateId = (typeof SAMPLE_TEMPLATES)[number];

function _templatesDir(): string {
  // app.getAppPath() returns the asar root in production (templates/ is
  // bundled alongside src/) and the project root in dev.
  return join(app.getAppPath(), "templates");
}

ipcMain.handle("scelo:workspace:create-from-template", async (event, templateId: string) => {
  if (!SAMPLE_TEMPLATES.includes(templateId as SampleTemplateId)) {
    return { ok: false, error: `unknown template: ${templateId}` };
  }
  const srcDir = join(_templatesDir(), templateId);
  if (!existsSync(srcDir)) {
    return { ok: false, error: `template missing on disk: ${srcDir}` };
  }
  const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
  const picked = await dialog.showOpenDialog(win ?? undefined!, {
    title: `Choose parent folder for the ${templateId} workspace`,
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) {
    return { ok: false, error: "cancelled" };
  }
  const parentDir = picked.filePaths[0];
  const destDir = join(parentDir, templateId);
  if (existsSync(destDir)) {
    return {
      ok: false,
      error: `${destDir} already exists; pick a different parent folder or rename the existing directory.`,
    };
  }
  try {
    await mkdir(destDir, { recursive: true });
    await cp(srcDir, destDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `copy failed: ${String(e)}` };
  }
  // Best-effort git init so the user can `git status` from day one.
  // Skipped silently when git isn't on PATH.
  try {
    await new Promise<void>((resolve) => {
      const p = spawn("git", ["init", "--quiet"], { cwd: destDir });
      p.on("error", () => resolve());
      p.on("exit", () => resolve());
    });
  } catch {
    // best-effort
  }
  _setActiveWorkspace(destDir);
  const id = _wsIdFor(destDir);
  _windowWorkspace.set(event.sender.id, id);
  return { ok: true, id, path: destDir };
});

// ─── Git ───────────────────────────────────────────────────────────────
//
// Minimal source-control surface: status (parsed porcelain v2 +
// branch), stage / unstage, commit. We spawn the system `git` from
// the active workspace cwd; no JS git library is bundled (saves the
// asar weight, and ensures we use the user's exact git version /
// credential helper / config).

interface GitFile {
  path: string;
  /** Status of the index entry. Single porcelain-v2 char (M/A/D/R/?/U). */
  index: string;
  /** Status of the worktree entry. Single porcelain-v2 char. */
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

function _runGit(
  cwd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  spawnError?: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const child = spawn("git", args, { cwd, env: process.env });
    guardStdin(child, (err) => {
      stderr += `[stdin] ${String(err)}\n`;
    });
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      const e = err as NodeJS.ErrnoException;
      resolve({
        ok: false,
        stdout,
        stderr,
        code: null,
        spawnError: e.code === "ENOENT" ? "git-not-installed" : String(err),
      });
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

function _parseGitStatus(stdout: string): Omit<GitStatus, "isRepo" | "gitInstalled"> {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim();
      branch = v === "(detached)" ? null : v;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.slice("# branch.ab ".length).match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number.parseInt(m[1], 10);
        behind = Number.parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("u ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "  ";
      const pathStart = line.startsWith("1 ") ? 8 : 10;
      const path = parts.slice(pathStart).join(" ");
      if (path) files.push({ path, index: xy[0], worktree: xy[1] });
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "  ";
      const tail = parts.slice(9).join(" ");
      const [newPath] = tail.split("\t");
      if (newPath) files.push({ path: newPath, index: xy[0], worktree: xy[1] });
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), index: "?", worktree: "?" });
    }
    // "! " (ignored) intentionally skipped.
  }
  return { branch, upstream, ahead, behind, files };
}

ipcMain.handle("scelo:git:status", async (event): Promise<GitStatus> => {
  const ws = _activeWorkspace(event);
  if (!ws) {
    return {
      isRepo: false,
      gitInstalled: true,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      error: "no active workspace",
    };
  }
  const r = await _runGit(ws, ["status", "--porcelain=v2", "--branch"]);
  if (r.spawnError === "git-not-installed") {
    return {
      isRepo: false,
      gitInstalled: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      error: "git not installed on PATH",
    };
  }
  if (!r.ok) {
    // Most likely "not a git repository" — surface non-error to caller.
    return {
      isRepo: false,
      gitInstalled: true,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      error: r.stderr.trim() || "git status failed",
    };
  }
  return { isRepo: true, gitInstalled: true, ..._parseGitStatus(r.stdout) };
});

ipcMain.handle(
  "scelo:git:stage",
  async (event, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    const ws = _activeWorkspace(event);
    if (!ws) return { ok: false, error: "no active workspace" };
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: "no paths" };
    }
    const r = await _runGit(ws, ["add", "--", ...paths]);
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "git add failed" };
  },
);

ipcMain.handle(
  "scelo:git:unstage",
  async (event, paths: string[]): Promise<{ ok: boolean; error?: string }> => {
    const ws = _activeWorkspace(event);
    if (!ws) return { ok: false, error: "no active workspace" };
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: "no paths" };
    }
    // Use `git restore --staged` (Git 2.23+); falls back to `git reset HEAD --`
    // if restore isn't available. The bundled git in modern OSes is ≥2.30,
    // so the restore form is the common path.
    const r = await _runGit(ws, ["restore", "--staged", "--", ...paths]);
    if (r.ok) return { ok: true };
    const fb = await _runGit(ws, ["reset", "HEAD", "--", ...paths]);
    return fb.ok
      ? { ok: true }
      : { ok: false, error: fb.stderr.trim() || r.stderr.trim() || "git unstage failed" };
  },
);

ipcMain.handle(
  "scelo:git:commit",
  async (event, message: string): Promise<{ ok: boolean; sha?: string; error?: string }> => {
    const ws = _activeWorkspace(event);
    if (!ws) return { ok: false, error: "no active workspace" };
    if (typeof message !== "string" || !message.trim()) {
      return { ok: false, error: "commit message is empty" };
    }
    const r = await _runGit(ws, ["commit", "-m", message]);
    if (!r.ok) {
      return { ok: false, error: r.stderr.trim() || r.stdout.trim() || "git commit failed" };
    }
    // Grab the new HEAD sha so the caller can echo it in a toast.
    const sha = await _runGit(ws, ["rev-parse", "--short", "HEAD"]);
    return { ok: true, sha: sha.ok ? sha.stdout.trim() : undefined };
  },
);

interface ReplaceEdit {
  lineNumber: number; // 1-indexed (matches rg output)
  start: number;
  end: number;
}

interface ReplaceFileSpec {
  path: string;
  edits: ReplaceEdit[];
}

ipcMain.handle(
  "scelo:fs:replace",
  async (
    event,
    files: ReplaceFileSpec[],
    replacement: string,
  ): Promise<{ ok: boolean; filesWritten: number; matchesReplaced: number; error?: string }> => {
    if (!Array.isArray(files) || files.length === 0) {
      return { ok: false, filesWritten: 0, matchesReplaced: 0, error: "no files" };
    }
    if (typeof replacement !== "string") {
      return {
        ok: false,
        filesWritten: 0,
        matchesReplaced: 0,
        error: "replacement must be a string",
      };
    }
    let filesWritten = 0;
    let matchesReplaced = 0;
    for (const spec of files) {
      try {
        const abs = _resolveInWorkspace(spec.path, event);
        const original = await readFile(abs, "utf-8");
        const lines = original.split("\n");
        // Sort edits by line desc, then by start desc within line, so we
        // never shift earlier offsets out from under later replacements.
        const sorted = [...spec.edits].sort(
          (a, b) => b.lineNumber - a.lineNumber || b.start - a.start,
        );
        for (const e of sorted) {
          const idx = e.lineNumber - 1;
          if (idx < 0 || idx >= lines.length) continue;
          const line = lines[idx];
          if (e.start < 0 || e.end > line.length || e.start >= e.end) continue;
          lines[idx] = line.slice(0, e.start) + replacement + line.slice(e.end);
          matchesReplaced++;
        }
        const next = lines.join("\n");
        if (next !== original) {
          await writeFile(abs, next, "utf-8");
          filesWritten++;
        }
      } catch (err) {
        return {
          ok: false,
          filesWritten,
          matchesReplaced,
          error: `${spec.path}: ${String(err)}`,
        };
      }
    }
    return { ok: true, filesWritten, matchesReplaced };
  },
);

// ─── Tests discovery ──────────────────────────────────────────────────
//
// `scelo:tests:discover` collects pytest + testthat test ids without
// running them. The renderer's tests panel uses the result to render a
// tree; running a test pipes a pytest / Rscript invocation into the
// long-lived terminal shell (terminalBus) so the user keeps the same
// scrollback as their interactive work.

interface DiscoveredTest {
  /** Test node id : the string you pass to pytest / testthat to run
   *  just this case. */
  id: string;
  file: string;
  /** Per-framework key so the panel can group + colour-code. */
  framework: "pytest" | "testthat";
}

interface DiscoverResult {
  ok: boolean;
  tests: DiscoveredTest[];
  errors: Array<{ framework: "pytest" | "testthat"; message: string }>;
}

function _parsePytestCollect(stdout: string): DiscoveredTest[] {
  // `pytest --collect-only -q` prints one id per line, e.g.
  //   tests/test_mortality.py::test_qx_monotone
  //   tests/test_mortality.py::test_ex_at_birth
  // followed by a summary line ("N tests collected in X.YYs"). Skip
  // anything that doesn't look like a node id.
  const out: DiscoveredTest[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes("::")) continue;
    if (/^\d+\s+test/.test(t)) continue;
    const file = t.split("::")[0];
    out.push({ id: t, file, framework: "pytest" });
  }
  return out;
}

function _parseTestthatFiles(stdout: string): DiscoveredTest[] {
  // Our Rscript probe just lists test-*.R files; each file's `test_that`
  // calls are run together when invoked, so we emit one node per file.
  const out: DiscoveredTest[] = [];
  for (const line of stdout.split("\n")) {
    const file = line.trim();
    if (!file) continue;
    out.push({ id: file, file, framework: "testthat" });
  }
  return out;
}

ipcMain.handle("scelo:tests:discover", async (event): Promise<DiscoverResult> => {
  const ws = _activeWorkspace(event);
  if (!ws)
    return {
      ok: false,
      tests: [],
      errors: [{ framework: "pytest", message: "no active workspace" }],
    };
  const tests: DiscoveredTest[] = [];
  const errors: DiscoverResult["errors"] = [];

  // pytest discovery : let pytest pick up tests via its own config
  // (pyproject.toml / pytest.ini / conftest.py) rather than hard-
  // coding a tests/ path.
  await new Promise<void>((resolve) => {
    const child = spawn("pytest", ["--collect-only", "-q"], { cwd: ws, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      errors.push({
        framework: "pytest",
        message: e.code === "ENOENT" ? "pytest not on PATH" : String(err),
      });
      resolve();
    });
    child.on("close", () => {
      tests.push(..._parsePytestCollect(stdout));
      if (tests.length === 0 && stderr.trim()) {
        errors.push({
          framework: "pytest",
          message: stderr.trim().split("\n").slice(0, 3).join(" / "),
        });
      }
      resolve();
    });
  });

  // testthat discovery : the standard layout is tests/testthat/test-*.R.
  // We list those files directly; running a file invokes its test_that()
  // calls together.
  // `R.exe -e <script>` is mangled on Windows (see execRScript); execRScript
  // runs the discovery script from a temp file via Rscript there, `R -e` else.
  const rAvailable = isWin ? rscriptBinary() : rBinary();
  if (rAvailable) {
    const rres = await execRScript(
      'cat(list.files("tests/testthat", pattern="test-.*\\\\.R$", full.names=TRUE), sep="\\n")',
      { vanilla: true, slave: true, cwd: ws },
    );
    tests.push(..._parseTestthatFiles(rres.stdout));
    if (rres.exitCode !== 0 && rres.stderr) {
      errors.push({ framework: "testthat", message: rres.stderr.slice(0, 200) });
    }
  } else {
    errors.push({ framework: "testthat", message: "bundled R runtime missing" });
  }

  return { ok: true, tests, errors };
});

ipcMain.handle(
  "scelo:git:show",
  async (
    event,
    relPath: string,
  ): Promise<{ ok: boolean; content?: string; sha?: string; error?: string }> => {
    const ws = _activeWorkspace(event);
    if (!ws) return { ok: false, error: "no active workspace" };
    if (typeof relPath !== "string" || !relPath) {
      return { ok: false, error: "no path" };
    }
    // `git show HEAD:<path>` prints the blob; failure (missing in HEAD,
    // never committed, etc.) is treated as "empty file at HEAD" so the
    // diff view shows the whole buffer as added rather than erroring.
    const r = await _runGit(ws, ["show", `HEAD:${relPath}`]);
    if (!r.ok) {
      // Distinguish "no HEAD yet" from "deleted from HEAD" via a second
      // probe — useful for future UI but for now both collapse to "".
      return { ok: true, content: "", sha: undefined };
    }
    const sha = await _runGit(ws, ["rev-parse", "--short", "HEAD"]);
    return {
      ok: true,
      content: r.stdout,
      sha: sha.ok ? sha.stdout.trim() : undefined,
    };
  },
);

ipcMain.handle("scelo:workspace:list", async (event, rel?: string) => {
  const ws = _activeWorkspace(event);
  if (!ws) return { entries: [], error: "no active workspace" };
  const target = rel ? _resolveInWorkspace(rel, event) : ws;
  try {
    const names = await readdir(target);
    const entries = await Promise.all(
      names.map(async (name) => {
        const abs = join(target, name);
        try {
          const s = await stat(abs);
          return {
            name,
            isDir: s.isDirectory(),
            size: s.size,
            // Hide common noise so the tree stays useful.
            hidden:
              name.startsWith(".") ||
              name === "node_modules" ||
              name === "__pycache__" ||
              name === ".venv",
          };
        } catch {
          return { name, isDir: false, size: 0, hidden: false };
        }
      }),
    );
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { entries: entries.filter((e) => !e.hidden) };
  } catch (e) {
    return { entries: [], error: String(e) };
  }
});

// Workspace UI state: open tabs + active tab. Persisted per-IDE so the
// user re-launches into the same view. Stored alongside the workspace
// pointer; pruned to entries that still exist on disk on load.
// WorkspaceUIState shape + migrator now live in `./migrations/workspaceState.ts`.
// Imported at the top so IPC handlers below can call
// `migrateWorkspaceStateToV1(raw)` directly.

function _workspaceStateFile(event?: IpcMainInvokeEvent): string {
  // Per-workspace state file so switching workspaces preserves each
  // one's open tabs / active tab. Keyed by the hashed workspace id of
  // the window's active workspace (per-window since Phase 16) so two
  // windows pointed at two different repos each get their own state.
  const rec = _activeWorkspaceRecordFor(event);
  const tag = rec ? rec.id : "default";
  return join(app.getPath("userData"), `workspace-state-${tag}.json`);
}

ipcMain.handle("scelo:workspace:state:get", (event) => {
  const ws = _activeWorkspace(event);
  if (!ws) {
    return { version: 1, openTabs: [], activeTab: null } satisfies WorkspaceUIState;
  }
  try {
    const raw = readFileSync(_workspaceStateFile(event), "utf-8");
    const parsed = JSON.parse(raw);
    const s = migrateWorkspaceStateToV1(parsed);
    // Prune any tab whose file no longer exists or escapes the workspace.
    const surviving: string[] = [];
    for (const t of s.openTabs ?? []) {
      try {
        const abs = _resolveInWorkspace(t, event);
        if (existsSync(abs) && statSync(abs).isFile()) surviving.push(t);
      } catch {
        // Skipped — invalid path.
      }
    }
    const active = surviving.includes(s.activeTab ?? "") ? s.activeTab : (surviving[0] ?? null);
    return {
      version: 1,
      openTabs: surviving,
      activeTab: active,
      sidebarTab: s.sidebarTab,
      sidebarWidth: s.sidebarWidth,
    } satisfies WorkspaceUIState;
  } catch {
    return { version: 1, openTabs: [], activeTab: null } satisfies WorkspaceUIState;
  }
});

ipcMain.handle("scelo:workspace:state:set", (event, state: WorkspaceUIState) => {
  try {
    // Always pin `version: 1` on write so the persisted shape never
    // ages out — even if the renderer somehow sends a partial / v0
    // payload, what lands on disk is a current-version document.
    const normalised: WorkspaceUIState = { ...state, version: 1 };
    writeFileSync(_workspaceStateFile(event), JSON.stringify(normalised), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Hard cap for whole-file reads AND per-call ranged reads. The editor
// buffers the whole string in the renderer, so anything bigger belongs in
// a streaming path (Soft Data import), not a single IPC payload.
const FS_READ_MAX_BYTES = 5 * 1024 * 1024;

ipcMain.handle("scelo:fs:read", async (event, rel: string) => {
  try {
    const abs = _resolveInWorkspace(rel, event);
    const s = await stat(abs);
    if (s.size > FS_READ_MAX_BYTES) {
      const mb = (s.size / 1024 ** 2).toFixed(1);
      // Structured refusal, not a bare failure: the renderer shows `error`
      // verbatim today, and `tooLarge`/`size` let a future preview page
      // through the file via scelo:fs:readRange instead.
      return {
        ok: false,
        tooLarge: true,
        size: s.size,
        error:
          `This file is ${mb} MB — too large to open in the editor (5 MB limit). ` +
          "For CSV and other datasets, use the Soft Data workstation's import instead: it streams the file without loading it whole.",
      };
    }
    const buf = await readFile(abs);
    // Best-effort UTF-8 decode; binary files surface mojibake but won't crash.
    return { ok: true, content: buf.toString("utf-8"), size: s.size };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Ranged read for paging through files the whole-file handler refuses.
// Same workspace-root validation as every other fs IPC; the per-call cap
// keeps a single IPC payload bounded no matter what length is asked for.
ipcMain.handle("scelo:fs:readRange", async (event, rel: string, offset: number, length: number) => {
  try {
    const abs = _resolveInWorkspace(rel, event);
    const s = await stat(abs);
    const start = Math.min(Math.max(0, Math.floor(offset) || 0), s.size);
    const want = Math.min(Math.max(0, Math.floor(length) || 0), FS_READ_MAX_BYTES);
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(want, s.size - start));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      // Best-effort UTF-8 decode, as in fs:read. A byte range can split a
      // multibyte character at either edge; callers paging text should
      // trim to line breaks before rendering.
      return {
        ok: true,
        content: buf.subarray(0, bytesRead).toString("utf-8"),
        offset: start,
        bytesRead,
        size: s.size,
        eof: start + bytesRead >= s.size,
      };
    } finally {
      await fh.close();
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ─── Optional reference-data downloads (dataset registry) ──────────────
//
// Each registered dataset is a single file (or .zip) hosted at a stable
// upstream URL. The renderer talks to a single set of IPCs parameterised
// by dataset id:
//
//   scelo:data:list                                  → DatasetSpec[]
//   scelo:data:status(id)                            → { available, sizeBytes, path? }
//   scelo:data:download(id)                          → { ok }
//   scelo:data:cancel(id)                            → { ok }
//   scelo:data:progress (send-from-main)             → { id, receivedBytes, totalBytes, done?, error? }
//
// The IBTrACS-specific IPC channels (scelo:climada:ibtracs:*) are kept
// as aliases below so existing renderer code keeps working.

interface DatasetSpec {
  id: string;
  label: string;
  blurb: string;
  url: string;
  filename: string; // basename under userData
  approxBytes: number; // for the UI summary; not enforced
  usedBy: string; // which Scelo Tool benefits
  /** Hex sha256 of the expected file. When set, the download is
   *  verified after streaming completes — mismatch deletes the temp
   *  file and surfaces an error instead of atomic-renaming a broken
   *  archive into place. Big-dataset hygiene; small files can skip. */
  expectedSha256?: string;
}

const DATASETS: DatasetSpec[] = [
  {
    id: "ibtracs",
    label: "IBTrACS · NOAA tropical-cyclone best-track archive",
    blurb:
      "Used by the climada Tool for the canonical tropical-cyclone hazard set. NetCDF v04r00, since-1980 satellite-era coverage.",
    url: "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r00/access/netcdf/IBTrACS.since1980.v04r00.nc",
    filename: "ibtracs.nc",
    approxBytes: 3 * 1024 ** 3,
    usedBy: "climada",
  },
  {
    id: "who-life-tables",
    label: "WHO Global Health Observatory · age-specific death rates (qx)",
    blurb:
      "WHO indicator LIFE_0000000031 — probability of dying between ages x and x+n per 1000, by sex, for every member state and vintage. CSV, ~5 MB. Used by the mortality Tools to ground country-specific qx priors and as a sanity check for fitted life tables.",
    url: "https://ghoapi.azureedge.net/api/LIFE_0000000031?$format=csv",
    filename: "who-life-tables.csv",
    approxBytes: 5 * 1024 ** 2,
    usedBy: "mortality + simulator",
  },
  {
    id: "nfip",
    label: "OpenFEMA NFIP · National Flood Insurance Program claims",
    blurb:
      "Per-policy + per-claim records of the US flood insurance scheme since 1978. CSV, ~700 MB. Used by climate flood Tools and as a back-test for the climada flood-hazard pipeline.",
    url: "https://www.fema.gov/api/open/v2/FimaNfipClaims.csv",
    filename: "nfip-claims.csv",
    approxBytes: 700 * 1024 ** 2,
    usedBy: "climate (flood)",
  },
  {
    id: "chembl",
    label: "ChEMBL 34 · bioactivity database (SQLite)",
    blurb:
      "EMBL-EBI manually-curated bioactivity database. Used by drug-pricing + mortality bridges to look up half-life, AE rates, and approved-indication metadata for compounds named in scenarios. SQLite, ~7 GB compressed; expand on disk to ~24 GB.",
    url: "https://ftp.ebi.ac.uk/pub/databases/chembl/ChEMBLdb/releases/chembl_34/chembl_34_sqlite.tar.gz",
    filename: "chembl_34_sqlite.tar.gz",
    approxBytes: 7 * 1024 ** 3,
    usedBy: "drug-pricing + mortality",
    expectedSha256: "67a3f4f6a02d3e8d3f87b1a4c66f1eecaa84a3a8c3c0f4b8b8a8a0a4e8b3c8d4",
    // Note: the sha256 above is a placeholder. Production deploys must
    // pin a real digest from the EMBL-EBI manifest (the digest file is
    // listed alongside the archive in the same FTP dir).
  },
];

function _datasetPath(spec: DatasetSpec): string {
  return join(app.getPath("userData"), spec.filename);
}

/** Where a dataset is allowed to extract on-disk artefacts. For
 *  ChEMBL: the .tar.gz from the registry stays alongside, the unpacked
 *  SQLite (~24 GB) lives under a dedicated `extracted/<id>/` so the
 *  Purge button can wipe it without touching the registered archive,
 *  and so disk-backup tools can skip the whole subtree. Electron's
 *  `app.getPath("userCache")` isn't in the public typedef across all
 *  versions, so we put it under userData/extracted/<id>/ which is
 *  consistent on Linux / macOS / Windows. */
function _datasetExtractedDir(spec: DatasetSpec): string {
  return join(app.getPath("userData"), "extracted", spec.id);
}

// Startup migrations live under `./migrations/`. The runner is called
// from `app.whenReady()`; per-migration logic + marker bookkeeping is
// owned by the registry there. Add new one-shots by editing
// `migrations/index.ts` rather than adding code here.

const _datasetAborts = new Map<string, AbortController>();

ipcMain.handle("scelo:data:list", () => ({ datasets: DATASETS }));

ipcMain.handle("scelo:data:status", (_event, id: string) => {
  const spec = DATASETS.find((d) => d.id === id);
  if (!spec) {
    return {
      available: false,
      sizeBytes: 0,
      path: null,
      partialBytes: 0,
      error: "unknown dataset",
    };
  }
  const p = _datasetPath(spec);
  const tmp = `${p}.partial`;
  const extracted = _datasetExtractedDir(spec);
  // Surface any half-downloaded partial so the UI can show
  // "(N MB downloaded — will resume)" rather than acting as if no
  // progress had ever been made.
  let partialBytes = 0;
  if (existsSync(tmp)) {
    try {
      partialBytes = statSync(tmp).size;
    } catch {
      partialBytes = 0;
    }
  }
  if (!existsSync(p)) {
    return { available: false, sizeBytes: 0, path: null, extractedDir: extracted, partialBytes };
  }
  try {
    const s = statSync(p);
    return {
      available: true,
      sizeBytes: s.size,
      path: p,
      extractedDir: extracted,
      partialBytes,
    };
  } catch {
    return { available: false, sizeBytes: 0, path: null, extractedDir: extracted, partialBytes };
  }
});

ipcMain.handle("scelo:data:download", async (event, id: string) => {
  const spec = DATASETS.find((d) => d.id === id);
  if (!spec) return { ok: false, error: "unknown dataset" };
  if (_datasetAborts.has(id)) return { ok: false, error: "download already in progress" };
  const wc = event.sender;
  const ac = new AbortController();
  _datasetAborts.set(id, ac);
  const dest = _datasetPath(spec);
  const tmp = `${dest}.partial`;
  const send = (payload: {
    receivedBytes: number;
    totalBytes: number;
    done?: boolean;
    error?: string;
  }) => {
    if (!wc.isDestroyed()) wc.send("scelo:data:progress", { id, ...payload });
  };
  try {
    // Resume support: if a .partial file from a previous attempt exists,
    // send Range: bytes=N- and append rather than overwriting. Big-dataset
    // hygiene — a cancelled 7 GB ChEMBL download stays useful.
    const {
      existsSync: _existsSync,
      createReadStream,
      createWriteStream,
      statSync: _statSync,
      unlinkSync,
    } = require("node:fs") as typeof import("node:fs");
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    let resumeFrom = 0;
    if (_existsSync(tmp)) {
      try {
        resumeFrom = _statSync(tmp).size;
      } catch {
        resumeFrom = 0;
      }
    }

    const headers: Record<string, string> = {};
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
    const resp = await fetch(spec.url, { signal: ac.signal, headers });
    if (resp.status !== 200 && resp.status !== 206) {
      send({ receivedBytes: resumeFrom, totalBytes: 0, error: `HTTP ${resp.status}` });
      _datasetAborts.delete(id);
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    // 206 = server honoured Range, append. 200 = server ignored Range
    // (or no Range was sent), restart from byte 0. Truncate the existing
    // .partial in the 200 case so the file size matches what we'll write.
    const rangeHonoured = resp.status === 206 && resumeFrom > 0;
    if (!rangeHonoured && resumeFrom > 0) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      resumeFrom = 0;
    }
    // Hash: created AFTER the Range-honoured decision so we don't waste
    // I/O re-reading the partial in the restart case. When resuming we
    // rehash the on-disk bytes first so the final digest covers the
    // whole file, not just the resumed tail.
    const hash = spec.expectedSha256 ? createHash("sha256") : null;
    if (hash && rangeHonoured) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(tmp);
        rs.on("data", (chunk) => hash.update(chunk as Buffer));
        rs.on("end", () => resolve());
        rs.on("error", reject);
      });
    }
    if (!resp.body) {
      send({ receivedBytes: resumeFrom, totalBytes: 0, error: "no response body" });
      _datasetAborts.delete(id);
      return { ok: false, error: "no response body" };
    }
    const contentLength = Number(resp.headers.get("content-length") ?? 0);
    const total = rangeHonoured ? resumeFrom + contentLength : contentLength;
    const fileStream = createWriteStream(tmp, { flags: rangeHonoured ? "a" : "w" });
    let received = resumeFrom;
    const reader = resp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      fileStream.write(buf);
      hash?.update(buf);
      received += value.length;
      send({ receivedBytes: received, totalBytes: total });
    }
    fileStream.end();
    await new Promise<void>((resolve) => fileStream.on("finish", () => resolve()));
    // Checksum verification before atomic rename — refuse to publish a
    // file whose content doesn't match the pinned digest.
    if (hash && spec.expectedSha256) {
      const actual = hash.digest("hex");
      if (actual.toLowerCase() !== spec.expectedSha256.toLowerCase()) {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore — leave the temp file for inspection
        }
        const msg = `sha256 mismatch: expected ${spec.expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`;
        send({ receivedBytes: received, totalBytes: total || received, error: msg });
        _datasetAborts.delete(id);
        return { ok: false, error: msg };
      }
    }
    const { renameSync } = require("node:fs") as typeof import("node:fs");
    if (_existsSync(dest)) {
      // Previous successful download is being replaced by a re-download.
      try {
        unlinkSync(dest);
      } catch {
        // Best-effort — rename below will fail loudly if this matters.
      }
    }
    renameSync(tmp, dest);
    send({ receivedBytes: received, totalBytes: total || received, done: true });
    _datasetAborts.delete(id);
    return { ok: true };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      send({ receivedBytes: 0, totalBytes: 0, error: "cancelled" });
      _datasetAborts.delete(id);
      return { ok: false, error: "cancelled" };
    }
    send({ receivedBytes: 0, totalBytes: 0, error: String(e) });
    _datasetAborts.delete(id);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("scelo:data:cancel", (_event, id: string) => {
  const ac = _datasetAborts.get(id);
  if (!ac) return { ok: true };
  ac.abort();
  _datasetAborts.delete(id);
  return { ok: true };
});

ipcMain.handle("scelo:data:purge", async (_event, id: string) => {
  const spec = DATASETS.find((d) => d.id === id);
  if (!spec) return { ok: false, error: "unknown dataset" };
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  const dest = _datasetPath(spec);
  const tmp = `${dest}.partial`;
  const extracted = _datasetExtractedDir(spec);
  let removedBytes = 0;
  for (const p of [dest, tmp, extracted]) {
    try {
      if (!existsSync(p)) continue;
      const s = statSync(p);
      if (s.isDirectory()) {
        // Sum directory size before removal so the UI can report what
        // was freed.
        const walk = (dir: string): number => {
          let bytes = 0;
          try {
            const names = require("node:fs").readdirSync(dir, { withFileTypes: true });
            for (const ent of names) {
              const fp = join(dir, ent.name);
              try {
                if (ent.isDirectory()) bytes += walk(fp);
                else bytes += statSync(fp).size;
              } catch {
                // skip
              }
            }
          } catch {
            // skip
          }
          return bytes;
        };
        removedBytes += walk(p);
        rmSync(p, { recursive: true, force: true });
      } else {
        removedBytes += s.size;
        rmSync(p, { force: true });
      }
    } catch (e) {
      log.warn(`data:purge: removing ${p} failed`, e);
    }
  }
  return { ok: true, removedBytes };
});

// The old `scelo:climada:ibtracs:*` IPCs are subsumed by the generic
// `scelo:data:*` channels above. Renderers call `data.status("ibtracs")`,
// `data.download("ibtracs")`, etc., and subscribe to `data:progress` with
// a per-event id filter.

// ─── Persistent LSP servers (per language) ─────────────────────────────
//
// We keep one long-lived child process per language id (currently
// "python" → pyright-langserver, "r" → R languageserver). Renderer
// interacts via four IPC channels, each parameterised by language:
//
//   scelo:lsp:start(lang)            invoke → { ok }                    spawn server
//   scelo:lsp:send(lang, message)    invoke → { ok }                    raw LSP JSON → server stdin
//   scelo:lsp:message(lang, message) send-from-main                     parsed LSP JSON ← server stdout
//   scelo:lsp:stop(lang)             invoke → { ok }                    kill server
//
// We frame-decode the LSP wire format (Content-Length: N\r\n\r\n<json>)
// inside main; the renderer ships and receives whole JSON objects.
//
// Why a minimal in-house client instead of monaco-languageclient: bundle
// size + Monaco version coupling. ~150 LOC of glue versus ~3 MB of deps.

type LspLang = "python" | "r";

interface LspProcess {
  lang: LspLang;
  child: ChildProcess;
  buffer: Buffer;
  contentLength: number | null;
  webContents: Set<Electron.WebContents>;
}

const _lspProcs: Map<LspLang, LspProcess> = new Map();

function _findPyrightLangServer(): string | null {
  // 1. bundled python's bin.
  const py = pythonBinary();
  if (py) {
    const dir = isWin ? join(py, "..", "Scripts") : join(py, "..");
    const candidate = isWin ? join(dir, "pyright-langserver.exe") : join(dir, "pyright-langserver");
    if (existsSync(candidate)) return candidate;
  }
  // 2. PATH lookup.
  const which = isWin ? "where" : "which";
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(which, ["pyright-langserver"], { encoding: "utf-8" })
      .toString()
      .trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    // not on path
  }
  return null;
}

function _dispatchLspChunk(proc: LspProcess, chunk: Buffer): void {
  proc.buffer = Buffer.concat([proc.buffer, chunk]);
  // Parse zero or more complete LSP frames out of the buffer.
  // Frame: `Content-Length: N\r\n\r\n` + N bytes of JSON.
  while (proc.buffer.length > 0) {
    if (proc.contentLength === null) {
      const headerEnd = proc.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // need more bytes
      const header = proc.buffer.subarray(0, headerEnd).toString("utf-8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        log.warn(`LSP[${proc.lang}]: malformed header, dropping frame`);
        proc.buffer = proc.buffer.subarray(headerEnd + 4);
        continue;
      }
      proc.contentLength = Number.parseInt(m[1], 10);
      proc.buffer = proc.buffer.subarray(headerEnd + 4);
    }
    if (proc.buffer.length < proc.contentLength) return; // wait for body
    const bodyRaw = proc.buffer.subarray(0, proc.contentLength).toString("utf-8");
    proc.buffer = proc.buffer.subarray(proc.contentLength);
    proc.contentLength = null;
    try {
      const json = JSON.parse(bodyRaw);
      for (const wc of proc.webContents) {
        if (!wc.isDestroyed()) wc.send("scelo:lsp:message", proc.lang, json);
      }
    } catch (e) {
      log.warn(`LSP[${proc.lang}]: body JSON parse failed:`, e, bodyRaw.slice(0, 200));
    }
  }
}

/** Resolve (binary, argv) for a given language. Returns null when the
 *  bundled runtime can't host that LSP — caller surfaces a clear error
 *  to the renderer so the editor falls back to lint-on-save. */
function _resolveLspCommand(lang: LspLang): { bin: string; argv: string[] } | null {
  if (lang === "python") {
    const bin = _findPyrightLangServer();
    return bin ? { bin, argv: ["--stdio"] } : null;
  }
  if (lang === "r") {
    const r = rBinary();
    if (!r) return null;
    // R `languageserver` exposes its LSP via the run() entry point. We
    // start a vanilla R process and immediately load + run it. --slave
    // suppresses the banner so the first stdout bytes are LSP frames.
    return {
      bin: r,
      argv: ["--slave", "--no-save", "-e", "languageserver::run()"],
    };
  }
  return null;
}

function _startLsp(lang: LspLang): { ok: boolean; error?: string } {
  if (_lspProcs.has(lang)) return { ok: true };
  const resolved = _resolveLspCommand(lang);
  if (!resolved) {
    return {
      ok: false,
      error:
        lang === "python"
          ? "pyright-langserver not found on this install"
          : "bundled R or its `languageserver` package not available",
    };
  }
  try {
    const child = spawn(resolved.bin, resolved.argv, { env: _augmentedEnv() });
    // scelo:lsp:send writes frames to stdin for the server's whole life —
    // an exiting server would otherwise EPIPE-crash the main process.
    guardStdin(child, (err) => log.warn(`LSP[${lang}]: stdin error`, err));
    const proc: LspProcess = {
      lang,
      child,
      buffer: Buffer.alloc(0),
      contentLength: null,
      webContents: new Set(),
    };
    child.stdout?.on("data", (chunk: Buffer) => _dispatchLspChunk(proc, chunk));
    child.stderr?.on("data", (chunk: Buffer) =>
      log.warn(`[lsp/${lang}/stderr]`, chunk.toString().slice(0, 300)),
    );
    child.on("close", (code) => {
      log.info(`LSP[${lang}]: server exited with code`, code);
      _lspProcs.delete(lang);
    });
    child.on("error", (err) => {
      log.warn(`LSP[${lang}]: spawn error`, err);
      _lspProcs.delete(lang);
    });
    _lspProcs.set(lang, proc);
    log.info(`LSP[${lang}]: server started`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function _stopLsp(lang?: LspLang): { ok: boolean } {
  const langs: LspLang[] = lang ? [lang] : Array.from(_lspProcs.keys());
  for (const l of langs) {
    const proc = _lspProcs.get(l);
    if (!proc) continue;
    try {
      proc.child.kill();
    } catch {
      // ignore
    }
    _lspProcs.delete(l);
  }
  return { ok: true };
}

ipcMain.handle("scelo:lsp:start", (event, lang: LspLang) => {
  const res = _startLsp(lang);
  if (res.ok) {
    const proc = _lspProcs.get(lang);
    if (proc) proc.webContents.add(event.sender);
  }
  return res;
});

ipcMain.handle("scelo:lsp:stop", (_event, lang?: LspLang) => _stopLsp(lang));

ipcMain.handle("scelo:lsp:send", (_event, lang: LspLang, message: unknown) => {
  const proc = _lspProcs.get(lang);
  if (!proc || !proc.child.stdin) return { ok: false, error: `LSP[${lang}] not running` };
  try {
    const body = Buffer.from(JSON.stringify(message), "utf-8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf-8");
    proc.child.stdin.write(Buffer.concat([header, body]));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Graceful shutdown on app quit so we don't leave orphan LSP processes.
app.on("before-quit", () => _stopLsp());

// ─── Bundled developer tools ───────────────────────────────────────────
//
// @vscode/ripgrep ships per-platform prebuilt binaries inside its own
// package; this IPC returns the absolute path on disk so the renderer's
// SearchPanel can run our ripgrep instead of relying on a system one.
//
// We probe via the canonical `rgPath` export at first use, cache the
// result, and return null when the package isn't loadable (the renderer
// then falls back to spawning rg from PATH and surfaces an install hint
// if even that fails).
let _ripgrepPath: string | null | undefined;

ipcMain.handle("scelo:tools:ripgrepPath", () => {
  if (_ripgrepPath !== undefined) return { path: _ripgrepPath };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@vscode/ripgrep") as { rgPath?: string };
    _ripgrepPath = mod.rgPath && existsSync(mod.rgPath) ? mod.rgPath : null;
  } catch (e) {
    log.warn("ripgrep: @vscode/ripgrep load failed", e);
    _ripgrepPath = null;
  }
  return { path: _ripgrepPath };
});

// ─── Pyright diagnostics on save (LSP-lite) ────────────────────────────
//
// Full LSP (persistent server + monaco-languageclient) is its own
// workstream. The "lite" version: when the editor saves a .py file we
// shell to bundled `pyright --outputjson <file>` and return the
// diagnostics list. The renderer converts them to Monaco markers.
//
// pyright-langserver / pyright are looked up in PATH (augmented with the
// bundled python/R bins by _augmentedEnv()) and fall back to npx if
// available. If neither works, we return ok=true with [] so the editor
// shows "no diagnostics" rather than failing the save.

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

function _findPyrightBin(): string | null {
  // 1. bundled python's bin (pip install pyright into the IDE python).
  const py = pythonBinary();
  if (py) {
    const pyDir = isWin ? join(py, "..", "Scripts") : join(py, "..");
    const candidate = isWin ? join(pyDir, "pyright.exe") : join(pyDir, "pyright");
    if (existsSync(candidate)) return candidate;
  }
  // 2. system pyright on PATH.
  const which = isWin ? "where" : "which";
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync(which, ["pyright"], { encoding: "utf-8" }).toString().trim();
    if (out) return out.split(/\r?\n/)[0];
  } catch {
    // not on path
  }
  return null;
}

ipcMain.handle("scelo:fs:lintPython", async (event, rel: string) => {
  try {
    const abs = _resolveInWorkspace(rel, event);
    const bin = _findPyrightBin();
    if (!bin) {
      return { ok: true, diagnostics: [], note: "pyright not installed; skipping lint" };
    }
    const res = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>(
      (resolve) => {
        const child = spawn(bin, ["--outputjson", abs], { env: _augmentedEnv() });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => {
          stdout += c.toString();
        });
        child.stderr?.on("data", (c: Buffer) => {
          stderr += c.toString();
        });
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
        child.on("error", (e) => resolve({ stdout, stderr: String(e), exitCode: null }));
      },
    );
    // pyright exits 0 = no errors, 1 = errors present, 2 = config issue.
    // Either way the JSON report is on stdout.
    try {
      const j = JSON.parse(res.stdout) as {
        generalDiagnostics?: PyrightDiagnostic[];
        summary?: { errorCount?: number; warningCount?: number };
      };
      return {
        ok: true,
        diagnostics: j.generalDiagnostics ?? [],
        summary: j.summary ?? {},
      };
    } catch {
      return {
        ok: false,
        diagnostics: [],
        error: res.stderr || res.stdout.slice(0, 300) || "pyright produced no JSON output",
      };
    }
  } catch (e) {
    return { ok: false, diagnostics: [], error: String(e) };
  }
});

// R diagnostics on save via lintr — mirrors the Pyright pattern. Returns
// the lint findings as a generic diagnostic shape so EditorPanel can
// reuse the same Monaco-marker plumbing.
interface RLintDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "unusedcode";
  message: string;
  rule?: string;
}

const R_LINT_SCRIPT = `
suppressWarnings({
  ok <- requireNamespace("lintr", quietly = TRUE) &&
        requireNamespace("jsonlite", quietly = TRUE)
})
if (!ok) {
  cat(jsonlite::toJSON(list(error = "lintr or jsonlite missing"), auto_unbox = TRUE))
  quit(save = "no", status = 1)
}
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) {
  cat(jsonlite::toJSON(list(error = "no file argument"), auto_unbox = TRUE))
  quit(save = "no", status = 2)
}
lints <- lintr::lint(args[1])
out <- lapply(lints, function(l) list(
  file = l$filename,
  line = l$line_number,
  column = l$column_number,
  severity = if (identical(l$type, "warning")) "warning" else if (identical(l$type, "error")) "error" else "information",
  message = l$message,
  rule = l$linter
))
cat(jsonlite::toJSON(out, auto_unbox = TRUE))
`;

ipcMain.handle("scelo:fs:lintR", async (event, rel: string) => {
  try {
    const abs = _resolveInWorkspace(rel, event);
    const r = rBinary();
    if (!r) {
      return {
        ok: true,
        diagnostics: [] as RLintDiagnostic[],
        note: "bundled R not installed; skipping lint",
      };
    }
    // `R.exe -e <R_LINT_SCRIPT>` is mangled on Windows (see execRScript); run
    // the lint script from a temp file via Rscript there, `R -e` elsewhere.
    const res = await execRScript(R_LINT_SCRIPT, {
      vanilla: true,
      args: [abs],
      env: _augmentedEnv(),
    });
    try {
      const parsed = JSON.parse(res.stdout.trim() || "[]") as RLintDiagnostic[] | { error: string };
      if (!Array.isArray(parsed)) {
        return { ok: true, diagnostics: [] as RLintDiagnostic[], note: parsed.error };
      }
      return { ok: true, diagnostics: parsed };
    } catch {
      return {
        ok: false,
        diagnostics: [] as RLintDiagnostic[],
        error: res.stderr || res.stdout.slice(0, 300) || "lintr produced no JSON output",
      };
    }
  } catch (e) {
    return { ok: false, diagnostics: [] as RLintDiagnostic[], error: String(e) };
  }
});

// Unsaved-buffer persistence: when the editor has dirty content we
// stash it under `userData/unsaved/<workspaceId>/<sha1(rel)>.json` so
// a reload / crash / window close doesn't lose the in-memory buffer.
// On file open, the renderer asks for any saved-unsaved for the path;
// if one exists AND its `baseSha1` matches the current on-disk SHA1,
// the buffer is restored as dirty. A mismatch (the file changed on
// disk since we last saved the dirty state) drops the dirty buffer so
// the user doesn't accidentally clobber an external edit.

function _unsavedDir(event: IpcMainInvokeEvent): string | null {
  const rec = _activeWorkspaceRecordFor(event);
  if (!rec) return null;
  return join(app.getPath("userData"), "unsaved", rec.id);
}

function _unsavedKey(rel: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha1").update(rel).digest("hex").slice(0, 24);
}

function _sha1OfFile(abs: string): string | null {
  try {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const buf = readFileSync(abs);
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

interface UnsavedRecord {
  rel: string;
  content: string;
  baseSha1: string; // sha1 of the on-disk file when we saved this draft
  savedAt: string; // ISO
}

ipcMain.handle("scelo:fs:saveUnsaved", (event, rel: string, content: string) => {
  try {
    const dir = _unsavedDir(event);
    if (!dir) return { ok: false, error: "no active workspace" };
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(dir, { recursive: true });
    const abs = _resolveInWorkspace(rel, event);
    const rec: UnsavedRecord = {
      rel,
      content,
      baseSha1: _sha1OfFile(abs) ?? "",
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(join(dir, `${_unsavedKey(rel)}.json`), JSON.stringify(rec), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("scelo:fs:loadUnsaved", (event, rel: string) => {
  try {
    const dir = _unsavedDir(event);
    if (!dir) return { ok: true, present: false };
    const file = join(dir, `${_unsavedKey(rel)}.json`);
    if (!existsSync(file)) return { ok: true, present: false };
    const raw = readFileSync(file, "utf-8");
    const rec = JSON.parse(raw) as UnsavedRecord;
    // Stale-vs-disk check: if the file's current hash doesn't match
    // what the unsaved draft was based on, drop the draft so we never
    // silently revive a buffer that would clobber an external edit.
    const abs = _resolveInWorkspace(rel, event);
    const onDisk = _sha1OfFile(abs);
    if (rec.baseSha1 && onDisk && rec.baseSha1 !== onDisk) {
      const fs = require("node:fs") as typeof import("node:fs");
      try {
        fs.unlinkSync(file);
      } catch {
        // ignore
      }
      return { ok: true, present: false, dropped: "disk content changed since draft was saved" };
    }
    return {
      ok: true,
      present: true,
      content: rec.content,
      savedAt: rec.savedAt,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("scelo:fs:clearUnsaved", (event, rel: string) => {
  try {
    const dir = _unsavedDir(event);
    if (!dir) return { ok: true };
    const file = join(dir, `${_unsavedKey(rel)}.json`);
    if (existsSync(file)) {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.unlinkSync(file);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle("scelo:fs:write", async (event, rel: string, content: string) => {
  try {
    const abs = _resolveInWorkspace(rel, event);
    await writeFile(abs, content, { encoding: "utf-8" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ─── Auto-update channel selector ──────────────────────────────────────
//
// stable / beta. Persisted under userData; autoUpdater.channel is set
// when the app boots. Beta tags follow `scelo-ide-vX.Y.Z-beta.N`.
function _channelFile(): string {
  return join(app.getPath("userData"), "channel.json");
}

function _activeChannel(): "latest" | "beta" {
  try {
    const raw = readFileSync(_channelFile(), "utf-8");
    const c = (JSON.parse(raw) as { channel?: string }).channel;
    return c === "beta" ? "beta" : "latest";
  } catch {
    return "latest";
  }
}

ipcMain.handle("scelo:updater:channel:get", () => ({ channel: _activeChannel() }));

ipcMain.handle("scelo:updater:channel:set", (_event, channel: "latest" | "beta") => {
  const safe = channel === "beta" ? "beta" : "latest";
  writeFileSync(_channelFile(), JSON.stringify({ channel: safe }), {
    encoding: "utf-8",
    mode: 0o600,
  });
  autoUpdater.channel = safe;
  return { channel: safe };
});

ipcMain.handle("scelo:runtimeStatus", () => ({
  python: pythonBinary() !== null,
  r: rBinary() !== null,
  resourceDir: resourceDir(),
}));

// First-run stack validation. Tries to import the IA Python stack and load
// the core R libraries; reports per-package OK/missing/version. The renderer
// shows a single-screen "stack OK" splash on first launch and a Maintenance
// view any time after.
const PY_STACK_PROBE = `
import json, importlib.metadata as m
PKGS = [
    "numpy", "pandas", "scipy", "scikit-learn", "statsmodels", "lightgbm",
    "lifelib", "chainladder", "climada", "fairlearn", "rpy2",
]
out = []
for p in PKGS:
    try:
        v = m.version(p)
        out.append({"pkg": p, "ok": True, "version": v})
    except Exception as e:
        out.append({"pkg": p, "ok": False, "error": str(e)})
print(json.dumps(out))
`;

const R_STACK_PROBE = `
pkgs <- c("ChainLadder", "lifecontingencies", "forecast", "mgcv", "data.table", "jsonlite")
out <- lapply(pkgs, function(p) {
  ok <- requireNamespace(p, quietly = TRUE)
  ver <- if (ok) as.character(packageVersion(p)) else NA_character_
  list(pkg = p, ok = ok, version = ver)
})
cat(jsonlite::toJSON(out, auto_unbox = TRUE))
`;

// ─── Secrets: API keys for AI providers ─────────────────────────────────
//
// Encrypted at rest with Electron `safeStorage`, which delegates to the
// OS-level keychain:
//   macOS  → Keychain Services
//   win    → DPAPI (per-user, machine-bound)
//   Linux  → libsecret (gnome-keyring / kwallet); falls back to plain text
//            if neither is available. We surface `safeStorage.available()`
//            via the secretsStatus() IPC so the UI can warn.
//
// The encrypted blob is written to userData/secrets.bin. We keep the
// schema as JSON-of-records so we can round-trip new fields (provider,
// model, baseUrl) without a schema migration.

interface SecretRecord {
  provider: string; // anthropic | openai | gemini | openai_compat
  apiKey: string;
  model?: string;
  baseUrl?: string;
  updatedAt: string;
}

function secretsFile(): string {
  return join(app.getPath("userData"), "secrets.bin");
}

function readEncryptedSecrets(): Record<string, SecretRecord> {
  const file = secretsFile();
  if (!existsSync(file)) return {};
  try {
    const blob = readFileSync(file);
    if (!safeStorage.isEncryptionAvailable()) {
      // Fall back to plaintext JSON for Linux hosts without libsecret —
      // the UI surfaces this risk via secretsStatus().
      return JSON.parse(blob.toString("utf-8")) as Record<string, SecretRecord>;
    }
    const plain = safeStorage.decryptString(blob);
    return JSON.parse(plain) as Record<string, SecretRecord>;
  } catch (e) {
    log.warn("secrets: failed to read", e);
    return {};
  }
}

function writeEncryptedSecrets(recs: Record<string, SecretRecord>): void {
  const file = secretsFile();
  try {
    mkdirSync(join(file, ".."), { recursive: true });
  } catch {
    // dir already exists
  }
  const plain = JSON.stringify(recs);
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(file, safeStorage.encryptString(plain), { mode: 0o600 });
  } else {
    writeFileSync(file, plain, { mode: 0o600, encoding: "utf-8" });
  }
}

ipcMain.handle("scelo:secrets:list", () => {
  // Renderer-facing read returns the records WITHOUT the key material —
  // the UI only needs to know which providers are configured, not the
  // secrets themselves. The orchestrator endpoint reads the actual key
  // via scelo:secrets:get when sending the request.
  const recs = readEncryptedSecrets();
  return Object.fromEntries(
    Object.entries(recs).map(([k, v]) => [
      k,
      {
        provider: v.provider,
        model: v.model ?? null,
        baseUrl: v.baseUrl ?? null,
        keyPreview: v.apiKey ? `${v.apiKey.slice(0, 4)}…${v.apiKey.slice(-4)}` : "",
        updatedAt: v.updatedAt,
      },
    ]),
  );
});

ipcMain.handle("scelo:secrets:get", (_event, provider: string) => {
  const recs = readEncryptedSecrets();
  const rec = recs[provider];
  if (!rec) return null;
  return {
    provider: rec.provider,
    apiKey: rec.apiKey,
    model: rec.model ?? null,
    baseUrl: rec.baseUrl ?? null,
  };
});

ipcMain.handle(
  "scelo:secrets:set",
  (_event, provider: string, payload: { apiKey: string; model?: string; baseUrl?: string }) => {
    const recs = readEncryptedSecrets();
    recs[provider] = {
      provider,
      apiKey: payload.apiKey,
      model: payload.model,
      baseUrl: payload.baseUrl,
      updatedAt: new Date().toISOString(),
    };
    writeEncryptedSecrets(recs);
    return { ok: true };
  },
);

ipcMain.handle("scelo:secrets:clear", (_event, provider?: string) => {
  const recs = readEncryptedSecrets();
  if (provider) {
    delete recs[provider];
  } else {
    for (const k of Object.keys(recs)) delete recs[k];
  }
  writeEncryptedSecrets(recs);
  return { ok: true };
});

ipcMain.handle("scelo:secrets:status", () => ({
  available: safeStorage.isEncryptionAvailable(),
  // On Linux this is "kwallet5" / "gnome-libsecret" / "basic_text" — useful
  // to surface so the user knows whether their keychain is actually wiring.
  backend:
    process.platform === "linux"
      ? (safeStorage.getSelectedStorageBackend?.() ?? "unknown")
      : process.platform,
}));

ipcMain.handle("scelo:stackProbe", async () => {
  const py = await execRuntime(pythonBinary(), "-c", { script: PY_STACK_PROBE });
  const r = await execRScript(R_STACK_PROBE);
  function parse(stdout: string): unknown {
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return null;
    }
  }
  return {
    python: { available: py.ok, packages: parse(py.stdout), stderr: py.stderr },
    r: { available: r.ok, packages: parse(r.stdout), stderr: r.stderr },
  };
});

// ─── Auto-update ────────────────────────────────────────────────────────
//
// Only runs when (a) the app is packaged and (b) signed. Unsigned builds
// (dev, CI artefacts without code-signing certs) skip the check so we never
// nag developers and never claim there's an update we can't actually deliver.
//
// macOS requires the bundle to be code-signed for autoUpdater to apply;
// unsigned macOS builds also short-circuit. Linux AppImage updates work
// without signing, and Windows nsis builds work without an EV cert but
// SmartScreen will complain.
/** Best-effort: is this packaged build code-signed? An unsigned build's
 *  autoUpdater just errors against the (private, auth-gated) GitHub release
 *  feed on every launch, so we skip update polling when unsigned — honouring
 *  the "signed only" contract above. Linux AppImages self-update without
 *  signing, so they're always treated as eligible. The check is a one-shot
 *  at startup; any failure is treated as "unsigned" (fail safe → skip). */
function isCodeSigned(): boolean {
  try {
    if (isWin) {
      const p = process.execPath.replace(/'/g, "''");
      const status = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-AuthenticodeSignature -LiteralPath '${p}').Status`,
        ],
        { encoding: "utf8", timeout: 8000, windowsHide: true },
      );
      return status.trim() === "Valid";
    }
    if (isMac) {
      // codesign exits 0 only when the bundle has a valid signature.
      execFileSync("codesign", ["--verify", "--strict", process.execPath], { timeout: 8000 });
      return true;
    }
    return true; // Linux AppImage updates don't require signing
  } catch {
    return false;
  }
}

function maybeScheduleUpdateCheck(): void {
  if (!app.isPackaged) {
    log.info("autoUpdater: skipped (not packaged)");
    return;
  }
  // Unsigned builds have no usable release feed (the private GitHub releases
  // 404 for unauthenticated clients), so the updater only throws on launch —
  // skip it entirely unless this build is actually code-signed.
  if (!isCodeSigned()) {
    log.info("autoUpdater: skipped (unsigned build)");
    return;
  }
  // Apply the user's selected channel before the first check.
  autoUpdater.channel = _activeChannel();
  // Honour an override for ops who want to disable update polling.
  if (process.env.SCELO_DISABLE_UPDATER === "1") {
    log.info("autoUpdater: skipped (SCELO_DISABLE_UPDATER=1)");
    return;
  }
  // Check immediately, then every 6h while the app is open.
  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((err) => log.warn("autoUpdater: initial check failed", err));
  setInterval(
    () => {
      autoUpdater
        .checkForUpdatesAndNotify()
        .catch((err) => log.warn("autoUpdater: periodic check failed", err));
    },
    6 * 60 * 60 * 1000,
  );
}

// ─── App lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerSceloProtocol();
  runStartupMigrations(
    { userDataDir: app.getPath("userData"), log },
    {
      datasetsForExtractedDirMigration: DATASETS.map((spec) => ({
        id: spec.id,
        archivePath: _datasetPath(spec),
        destDir: _datasetExtractedDir(spec),
      })),
    },
  );
  buildMenu();
  createMainWindow();
  maybeScheduleUpdateCheck();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
