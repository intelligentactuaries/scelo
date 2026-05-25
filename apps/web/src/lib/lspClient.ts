// Minimal LSP client over Scelo IDE's IPC bridge.
//
// We deliberately don't pull `monaco-languageclient` (3+ MB of deps + a
// strict monaco-editor version coupling). The LSP wire protocol is just
// JSON-RPC 2.0; the bits Scelo needs (initialize, textDocument/didOpen,
// didChange, publishDiagnostics, completion, hover, definition,
// signatureHelp) are ~200 LOC.
//
// One singleton client per language id (python, r). `getLspClient(lang)`
// returns the shared instance. It starts the server on first use and
// notifies all subscribers when the server pushes a notification.

import { emitLspStatus } from "./lspBus";
import { isDesktopIDE, type LspLang } from "./sceloIDE";

interface RequestRecord {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type NotificationHandler = (params: unknown) => void;

class LspClient {
  private started = false;
  private starting: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, RequestRecord>();
  private notifications = new Map<string, Set<NotificationHandler>>();
  private requestHandlers = new Map<
    string,
    Set<(params: unknown) => Promise<unknown> | unknown>
  >();
  private opened = new Set<string>();
  private versions = new Map<string, number>();
  /** Active workspace root, set before ensureStarted() so initialize can
   *  pass the correct rootUri / workspaceFolders. Pyright reads pyproject.toml
   *  + pyrightconfig.json relative to this root when analysing files. */
  private rootPath: string | null = null;
  private unsubscribeMessages: (() => void) | null = null;

  constructor(private readonly lang: LspLang) {}

  /** Set the workspace path the LSP should analyse against. Caller MUST
   *  call this before any file open / request. Idempotent — only restarts
   *  the server when the path actually changed. */
  async setRoot(workspacePath: string | null): Promise<void> {
    if (this.rootPath === workspacePath) return;
    if (this.started) {
      // Tell the server to shut down cleanly; then we'll start fresh on
      // the next request with the new root.
      try {
        await this.request("shutdown", null).catch(() => undefined);
        await this.notify("exit", null);
      } catch {
        // best-effort
      }
      // Also tell the main process to kill the underlying child so the
      // next start gets a fresh process (not just a new connection).
      try {
        await window.scelo!.lsp.stop(this.lang);
      } catch {
        // best-effort
      }
      this.unsubscribeMessages?.();
      this.unsubscribeMessages = null;
      this.started = false;
      this.starting = null;
      this.pending.clear();
      this.opened.clear();
      this.versions.clear();
      emitLspStatus(this.lang, "off");
    }
    this.rootPath = workspacePath;
  }

  /** Send a request and await a response; rejects if the server errors. */
  async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      window.scelo!.lsp.send(this.lang, { jsonrpc: "2.0", id, method, params });
    });
  }

  /** Fire-and-forget notification (no response expected). */
  async notify(method: string, params: unknown): Promise<void> {
    await this.ensureStarted();
    window.scelo!.lsp.send(this.lang, { jsonrpc: "2.0", method, params });
  }

  /** Subscribe to a notification kind (e.g. "textDocument/publishDiagnostics").
   *  Returns an unsubscribe fn. */
  on(method: string, cb: NotificationHandler): () => void {
    let set = this.notifications.get(method);
    if (!set) {
      set = new Set();
      this.notifications.set(method, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Register a handler for server-originated REQUESTS (the LSP server
   *  sends a method WITH an id and expects a JSON-RPC response). The
   *  most common case for us is workspace/applyEdit. Handler returns
   *  the result object that goes into the `result` field of the reply. */
  onRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ): () => void {
    let set = this.requestHandlers.get(method);
    if (!set) {
      set = new Set();
      this.requestHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Open (or re-open after revert) a text document. Tracks versions so
   *  didChange notifications are correctly ordered. */
  async openDocument(uri: string, languageId: string, text: string): Promise<void> {
    if (this.opened.has(uri)) {
      // Treat as a content reset.
      await this.changeDocument(uri, text);
      return;
    }
    this.versions.set(uri, 1);
    this.opened.add(uri);
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async changeDocument(uri: string, text: string): Promise<void> {
    if (!this.opened.has(uri)) {
      // Auto-open if the caller didn't.
      await this.openDocument(uri, this.lang, text);
      return;
    }
    const next = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, next);
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version: next },
      // Whole-file content change. We could send range-based incremental
      // edits to be faster on big files, but Monaco's onDidChangeContent
      // already gives us the new full value and Pyright accepts both.
      contentChanges: [{ text }],
    });
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.opened.has(uri)) return;
    this.opened.delete(uri);
    this.versions.delete(uri);
    await this.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.started) return true;
    if (this.starting) return this.starting;
    if (!isDesktopIDE()) return false;
    emitLspStatus(this.lang, "starting");
    this.starting = (async () => {
      const res = await window.scelo!.lsp.start(this.lang);
      if (!res.ok) {
        // Reset so the next try is fresh. Likely cause: language server
        // not installed; caller falls back to lint-on-save.
        this.starting = null;
        emitLspStatus(this.lang, "error");
        return false;
      }
      // Subscribe to all incoming messages for this language. The bridge
      // multiplexes by language, so we filter here. Store the unsubscribe
      // so a workspace switch can cleanly tear down the old subscription
      // before starting a new server.
      this.unsubscribeMessages = window.scelo!.lsp.onMessage((lang, m) => {
        if (lang !== this.lang) return;
        this._handleMessage(m as LspMessage);
      });
      // Send `initialize` synchronously so subsequent requests have a
      // negotiated server. We hand-roll the request here to avoid
      // recursion through this.request (which would await ensureStarted
      // and deadlock).
      await new Promise<void>((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, {
          resolve: () => resolve(),
          reject: reject as (e: Error) => void,
        });
        window.scelo!.lsp.send(this.lang, {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            processId: null,
            clientInfo: { name: "scelo-ide", version: "0.1.0" },
            rootUri: this.rootPath ? `file://${this.rootPath}` : null,
            rootPath: this.rootPath ?? undefined,
            workspaceFolders: this.rootPath
              ? [
                  {
                    uri: `file://${this.rootPath}`,
                    name: this.rootPath.split(/[\\/]/).pop() ?? "workspace",
                  },
                ]
              : null,
            capabilities: {
              textDocument: {
                synchronization: { dynamicRegistration: false },
                completion: {
                  completionItem: {
                    snippetSupport: false,
                    documentationFormat: ["markdown", "plaintext"],
                  },
                },
                hover: { contentFormat: ["markdown", "plaintext"] },
                definition: { linkSupport: false },
                references: { dynamicRegistration: false },
                callHierarchy: { dynamicRegistration: false },
                inlayHint: { dynamicRegistration: false },
                documentSymbol: {
                  dynamicRegistration: false,
                  hierarchicalDocumentSymbolSupport: true,
                  symbolKind: {
                    valueSet: Array.from({ length: 26 }, (_, i) => i + 1),
                  },
                },
                signatureHelp: {
                  signatureInformation: {
                    documentationFormat: ["markdown", "plaintext"],
                    parameterInformation: { labelOffsetSupport: true },
                  },
                },
                rename: { prepareSupport: false },
                formatting: { dynamicRegistration: false },
                codeAction: {
                  codeActionLiteralSupport: {
                    codeActionKind: {
                      valueSet: [
                        "",
                        "quickfix",
                        "refactor",
                        "source",
                        "source.organizeImports",
                      ],
                    },
                  },
                },
                publishDiagnostics: { versionSupport: true },
              },
              workspace: {
                symbol: { dynamicRegistration: false },
                executeCommand: { dynamicRegistration: false },
                applyEdit: true,
              },
            },
          },
        });
      });
      await this.notify("initialized", {});
      this.started = true;
      emitLspStatus(this.lang, "live");
      return true;
    })();
    return this.starting;
  }

  private _handleMessage(m: LspMessage): void {
    // Three message shapes from the server:
    //   1. Response to our request   id present, NO method      → resolve pending
    //   2. Server-originated request id present, method present → run handler, reply
    //   3. Notification              no id, method present      → dispatch listeners
    if (typeof m.id !== "undefined" && !m.method) {
      const rec = this.pending.get(m.id as number);
      if (!rec) return;
      this.pending.delete(m.id as number);
      if (m.error) rec.reject(new Error(m.error.message));
      else rec.resolve(m.result);
      return;
    }
    if (typeof m.id !== "undefined" && m.method) {
      // Server request — reply on the same id with whatever the first
      // registered handler returns. Multiple handlers per method are
      // allowed but only the first contributes to the reply (rare; the
      // others are subscribers-for-side-effect).
      const set = this.requestHandlers.get(m.method);
      const reply = (result: unknown, error?: { code: number; message: string }) => {
        const msg: LspMessage = error
          ? { jsonrpc: "2.0", id: m.id, error }
          : { jsonrpc: "2.0", id: m.id, result };
        window.scelo!.lsp.send(this.lang, msg);
      };
      if (!set || set.size === 0) {
        // Method not handled — LSP servers expect a method-not-found error.
        reply(undefined, { code: -32601, message: `Method not found: ${m.method}` });
        return;
      }
      const [handler] = set;
      Promise.resolve(handler(m.params))
        .then((result) => reply(result))
        .catch((err) => reply(undefined, { code: -32603, message: String(err) }));
      return;
    }
    if (m.method) {
      const set = this.notifications.get(m.method);
      if (set) for (const cb of set) cb(m.params);
    }
  }
}

const _singletons = new Map<LspLang, LspClient>();
export function getLspClient(lang: LspLang = "python"): LspClient {
  let c = _singletons.get(lang);
  if (!c) {
    c = new LspClient(lang);
    _singletons.set(lang, c);
  }
  return c;
}
