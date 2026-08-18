// Swarm supervisor — the swarm (apps/swarm: council + society simulator)
// starts with Scelo and stops with it. No more `bun run dev:swarm` in a
// second terminal, no more red "server not detected on :3010" dot.
//
// What runs: a single executable produced by scripts/bundle-swarm.sh
// (`bun build --compile` of the swarm's Bun server) at
// <resources>/swarm/swarm-server[.exe], serving its API AND its built client
// (<resources>/swarm/ui) on one loopback origin. In a dev checkout, where
// nothing is bundled, we fall back to `bun apps/swarm/src/server/index.ts`
// so `bun run dev` behaves the same.
//
// Contract with the renderer (window.scelo.swarm):
//   endpoints()  — SYNC: { ui, api } the panel/iframe/clients should use.
//                  Decided BEFORE the window is created so the renderer never
//                  has to guess a port; identical for ui and api when we serve
//                  the bundle, split (5190 / 3010) only when adopting an
//                  external dev pair.
//   status()     — { state, url, apiUrl, port, managed, pid, error, logTail }
//   restart()    — kill + start again (managed only).
//
// Behaviour:
//   • If something already answers /api/health on the default port (a
//     developer's `bun run dev:swarm`), ADOPT it — never fight over the port.
//   • Otherwise pick the default port if free, else the next free one, spawn
//     the server with HOST=127.0.0.1, SWARM_DATA_DIR=<userData>/swarm (the
//     database and canon live with the user, not in the app bundle),
//     SWARM_STATIC_DIR=<resources>/swarm/ui, and a PATH that reaches the
//     places `claude` / `ollama` are usually installed (GUI-launched apps get
//     a short PATH on macOS/Linux).
//   • Crash → restart with backoff, up to 3 times; then state 'error' with
//     the log tail so the panel can show WHY instead of a blank iframe.
//   • App quit → SIGTERM, then SIGKILL after 3 s.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type SwarmState = "starting" | "running" | "external" | "stopped" | "error";

export interface SwarmEndpoints {
  /** Where the swarm UI lives (iframe src). */
  ui: string;
  /** Where the swarm API lives (fetch / SSE base). */
  api: string;
}

export interface SwarmStatus {
  state: SwarmState;
  url: string;
  apiUrl: string;
  port: number;
  /** True when this process spawned (and will stop) the server. */
  managed: boolean;
  pid: number | null;
  error: string | null;
  logTail: string;
  /** Where the executable came from — for the maintenance view. */
  source: "bundled" | "dev-source" | "external" | "none";
  logFile: string | null;
  dataDir: string | null;
}

export interface SwarmSupervisorOpts {
  /** <resources> dir — bundled server + ui live under <resources>/swarm. */
  resourceDir: string;
  /** Repo checkout root when running unpackaged (dev fallback), else null. */
  repoRoot: string | null;
  /** Writable per-user dir (app.getPath("userData")). */
  userDataDir: string;
  isPackaged: boolean;
  isWin: boolean;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  defaultPort?: number;
  /** Dev UI port of an external `bun run dev:swarm` pair, if adopted. */
  devUiPort?: number;
}

const DEFAULT_PORT = 3010;
const DEV_UI_PORT = 5190;
const HOST = "127.0.0.1";
const MAX_RESTARTS = 3;
const LOG_TAIL_BYTES = 6_000;

export class SwarmSupervisor {
  private child: ChildProcess | null = null;
  private state: SwarmState = "stopped";
  private port = DEFAULT_PORT;
  private uiUrl = `http://${HOST}:${DEFAULT_PORT}`;
  private apiUrl = `http://${HOST}:${DEFAULT_PORT}`;
  private managed = false;
  private source: SwarmStatus["source"] = "none";
  private error: string | null = null;
  private restarts = 0;
  private stopping = false;
  private readonly logFile: string;
  private readonly dataDir: string;
  private readonly logDir: string;

  constructor(private readonly opts: SwarmSupervisorOpts) {
    this.dataDir = join(opts.userDataDir, "swarm");
    this.logDir = join(opts.userDataDir, "logs");
    this.logFile = join(this.logDir, "swarm.log");
  }

  endpoints(): SwarmEndpoints {
    return { ui: this.uiUrl, api: this.apiUrl };
  }

  status(): SwarmStatus {
    return {
      state: this.state,
      url: this.uiUrl,
      apiUrl: this.apiUrl,
      port: this.port,
      managed: this.managed,
      pid: this.child?.pid ?? null,
      error: this.error,
      logTail: this.readLogTail(),
      source: this.source,
      logFile: this.managed ? this.logFile : null,
      dataDir: this.managed ? this.dataDir : null,
    };
  }

  /** Where the executable is, or null. Bundled first, then the dev source
   *  (needs `bun` on PATH). */
  private locate(): { kind: "bundled" | "dev-source"; bin: string; args: string[]; staticDir: string | null } | null {
    const bundledDir = join(this.opts.resourceDir, "swarm");
    const bundledBin = join(bundledDir, this.opts.isWin ? "swarm-server.exe" : "swarm-server");
    if (existsSync(bundledBin)) {
      const ui = join(bundledDir, "ui");
      return { kind: "bundled", bin: bundledBin, args: [], staticDir: existsSync(join(ui, "index.html")) ? ui : null };
    }
    if (this.opts.repoRoot) {
      const entry = join(this.opts.repoRoot, "apps", "swarm", "src", "server", "index.ts");
      if (existsSync(entry)) {
        const dist = join(this.opts.repoRoot, "apps", "swarm", "dist");
        return {
          kind: "dev-source",
          bin: this.opts.isWin ? "bun.exe" : "bun",
          args: [entry],
          staticDir: existsSync(join(dist, "index.html")) ? dist : null,
        };
      }
    }
    return null;
  }

  /** Decide the endpoints and start (or adopt) the server. Resolves once the
   *  decision is made — NOT once the server is healthy; the renderer polls
   *  status() for that. Safe to call once. */
  async start(): Promise<SwarmStatus> {
    const wanted = this.opts.defaultPort ?? DEFAULT_PORT;
    // 1. Someone already there? (dev pair, or a previous instance)
    if (await this.healthy(wanted)) {
      await this.adoptExternal(wanted);
      return this.status();
    }
    // 2. Pick a port and spawn.
    const port = (await this.portFree(wanted)) ? wanted : await this.findFreePort(wanted + 1);
    this.port = port;
    this.uiUrl = `http://${HOST}:${port}`;
    this.apiUrl = this.uiUrl;
    this.spawnServer();
    return this.status();
  }

  private async adoptExternal(port: number): Promise<void> {
    this.state = "external";
    this.managed = false;
    this.source = "external";
    this.port = port;
    this.apiUrl = `http://${HOST}:${port}`;
    // A dev pair serves the UI from Vite on 5190; a second IDE instance's
    // server serves its own UI on the API origin. Awaited (≤ 0.8 s) so the
    // renderer's synchronous endpoints() query — made as soon as the window
    // exists — already has the right answer.
    const sameOrigin = await this.servesUi(this.apiUrl);
    this.uiUrl = sameOrigin ? this.apiUrl : `http://${HOST}:${this.opts.devUiPort ?? DEV_UI_PORT}`;
    this.opts.log.info(`swarm: adopted external server on :${port} (ui ${this.uiUrl})`);
  }

  private spawnServer(): void {
    const loc = this.locate();
    if (!loc) {
      this.state = "error";
      this.error =
        "swarm server not found — the bundled executable is missing from resources/swarm (run `bun run bundle:swarm` in apps/scelo-ide) and no checkout source is available.";
      this.source = "none";
      this.opts.log.warn(`swarm: ${this.error}`);
      return;
    }
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: augmentedPath(process.env.PATH, this.opts.isWin),
      PORT: String(this.port),
      HOST,
      SWARM_DATA_DIR: this.dataDir,
      NODE_ENV: "production",
    };
    if (loc.staticDir) env.SWARM_STATIC_DIR = loc.staticDir;
    else delete env.SWARM_STATIC_DIR;

    let out: number | undefined;
    try {
      out = openSync(this.logFile, "a");
    } catch {
      out = undefined;
    }
    this.managed = true;
    this.source = loc.kind;
    this.state = "starting";
    this.error = null;
    this.stopping = false;
    this.opts.log.info(`swarm: starting ${loc.kind} server on :${this.port} (${loc.bin} ${loc.args.join(" ")})`);
    let child: ChildProcess;
    try {
      child = spawn(loc.bin, loc.args, {
        env,
        cwd: this.dataDir,
        stdio: ["ignore", out ?? "ignore", out ?? "ignore"],
        windowsHide: true,
      });
    } catch (e) {
      this.state = "error";
      this.error = `failed to spawn swarm server: ${e instanceof Error ? e.message : String(e)}`;
      this.opts.log.error(`swarm: ${this.error}`);
      return;
    }
    this.child = child;
    child.on("error", (err) => {
      this.state = "error";
      this.error = `swarm server failed to start: ${err.message}${loc.kind === "dev-source" ? " (is bun on PATH?)" : ""}`;
      this.opts.log.error(`swarm: ${this.error}`);
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.state = "stopped";
        return;
      }
      this.opts.log.warn(`swarm: server exited (code ${code}, signal ${signal})`);
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        const delay = 500 * 2 ** this.restarts;
        this.state = "starting";
        this.error = `swarm server exited (code ${code ?? "?"}); restarting in ${delay} ms (attempt ${this.restarts}/${MAX_RESTARTS})`;
        setTimeout(() => {
          if (!this.stopping) this.spawnServer();
        }, delay);
      } else {
        this.state = "error";
        this.error = `swarm server keeps exiting (code ${code ?? "?"}) — see ${this.logFile}`;
      }
    });
    // Flip to running once /api/health answers (poll a few seconds).
    void this.awaitHealthy(this.port, 20_000).then((ok) => {
      if (this.child !== child) return;
      if (ok) {
        this.state = "running";
        this.restarts = 0;
        this.opts.log.info(`swarm: running on ${this.uiUrl}`);
      } else if (this.state === "starting") {
        this.error = `swarm server did not answer /api/health within 20 s — see ${this.logFile}`;
        this.state = "error";
        this.opts.log.warn(`swarm: ${this.error}`);
      }
    });
  }

  async restart(): Promise<SwarmStatus> {
    if (!this.managed) return this.status();
    await this.stop();
    this.restarts = 0;
    this.spawnServer();
    return this.status();
  }

  /** SIGTERM, then SIGKILL after 3 s. Resolves when the child is gone. */
  stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (!child) {
      this.state = this.managed ? "stopped" : this.state;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        this.child = null;
        this.state = "stopped";
        resolve();
      });
      try {
        child.kill(this.opts.isWin ? undefined : "SIGTERM");
      } catch {
        clearTimeout(timer);
        this.child = null;
        this.state = "stopped";
        resolve();
      }
    });
  }

  // ─── probes ─────────────────────────────────────────────────────────

  private async healthy(port: number): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`http://${HOST}:${port}/api/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return false;
      const j = (await r.json()) as { ok?: boolean };
      return j?.ok === true;
    } catch {
      return false;
    }
  }

  private async servesUi(base: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 800);
      const r = await fetch(`${base}/`, { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok && (r.headers.get("content-type") ?? "").includes("text/html");
    } catch {
      return false;
    }
  }

  private async awaitHealthy(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping) return false;
      if (await this.healthy(port)) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  private portFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, HOST, () => {
        srv.close(() => resolve(true));
      });
    });
  }

  private async findFreePort(from: number): Promise<number> {
    for (let p = from; p < from + 50; p++) {
      if (await this.portFree(p)) return p;
    }
    return 0; // let the OS pick — Bun reports the real one in its log
  }

  private readLogTail(): string {
    try {
      if (!existsSync(this.logFile)) return "";
      const size = statSync(this.logFile).size;
      const buf = readFileSync(this.logFile);
      return buf.subarray(Math.max(0, size - LOG_TAIL_BYTES)).toString("utf8");
    } catch {
      return "";
    }
  }
}

/** PATH for the spawned server: whatever we inherited plus the usual homes of
 *  `claude` and `ollama`, so a GUI-launched IDE (short PATH) still finds the
 *  signed-in Claude Code CLI the swarm prefers as a provider. */
export function augmentedPath(inherited: string | undefined, isWin: boolean): string {
  const sep = isWin ? ";" : ":";
  const home = homedir();
  const extras = isWin
    ? [join(home, ".local", "bin"), join(home, "AppData", "Local", "Programs", "Ollama"), join(home, ".bun", "bin")]
    : [
        join(home, ".local", "bin"),
        join(home, ".bun", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
      ];
  const parts = (inherited ?? "").split(sep).filter(Boolean);
  for (const e of extras) if (!parts.includes(e)) parts.push(e);
  return parts.join(sep);
}
