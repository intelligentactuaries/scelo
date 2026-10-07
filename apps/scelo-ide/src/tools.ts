// Small pieces of the main process that differ by platform or by packaging,
// kept out of main.ts so they can be tested on every OS (pass "win32"
// explicitly; see CLAUDE.md, "Windows parity").
//
//   withPathPrepended — the bundled runtimes on a terminal's PATH.
//   ripgrepBinary     — the bundled `rg` that Quick Open and Search run.
//   copyTree          — copies a sample workspace out of the app.asar.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `path` with `dirs` in front, each once. */
export function prependPath(path: string | undefined, dirs: string[], isWin: boolean): string {
  const sep = isWin ? ";" : ":";
  const rest = (path ?? "").split(sep).filter((p) => p && !dirs.includes(p));
  return [...dirs, ...rest].join(sep);
}

/** `env` with `dirs` in front of its PATH, under the name it already has.
 *
 *  Windows spells the variable any way, usually `Path` (an app started from
 *  Explorer or the Start menu gets it so), and a copy of process.env is a
 *  plain object, not process.env's case-insensitive view: setting `PATH` on
 *  it adds a second variable. node-pty writes the environment block in key
 *  order and Windows reads the first `path` it finds, which was the new
 *  `PATH` holding only the bundled folders: the IDE's terminals lost the
 *  whole system Path (no git, node or where.exe by name). One spelling, the
 *  first, stays. */
export function withPathPrepended<T extends Record<string, string | undefined>>(
  env: T,
  dirs: string[],
  isWin: boolean,
): T {
  if (dirs.length === 0) return env;
  const out: Record<string, string | undefined> = { ...env };
  let key = "PATH";
  if (isWin) {
    const spellings = Object.keys(out).filter((k) => k.toUpperCase() === "PATH");
    key = spellings[0] ?? "Path";
    for (const k of spellings.slice(1)) delete out[k];
  }
  out[key] = prependPath(out[key], dirs, isWin);
  return out as T;
}

/** The bundled ripgrep, or null.
 *
 *  @vscode/ripgrep 1.18 is an ES module, so `require("@vscode/ripgrep")` from
 *  the CommonJS main process throws ERR_REQUIRE_ESM and Quick Open and Search
 *  found no `rg` (on Windows, where there is no system one, they found
 *  nothing at all). Its whole job is to name the per-platform package's
 *  binary, so do that here. In a packaged app the binary sits in
 *  app.asar.unpacked (electron-builder.yml unpacks it), and a path into
 *  app.asar cannot be executed. */
export function ripgrepBinary(opts: {
  platform: NodeJS.Platform;
  arch: string;
  resolve: (request: string) => string;
  exists: (p: string) => boolean;
}): string | null {
  const exe = opts.platform === "win32" ? "rg.exe" : "rg";
  let resolved: string;
  try {
    resolved = opts.resolve(`@vscode/ripgrep-${opts.platform}-${opts.arch}/bin/${exe}`);
  } catch {
    return null;
  }
  const p = opts.platform === "win32" ? path.win32 : path.posix;
  const asar = `${p.sep}app.asar${p.sep}`;
  const unpacked = resolved.includes(asar)
    ? resolved.replace(asar, `${p.sep}app.asar.unpacked${p.sep}`)
    : resolved;
  if (opts.exists(unpacked)) return unpacked;
  return opts.exists(resolved) ? resolved : null;
}

/** Copy the directory `src` to `dest`, which must not exist yet.
 *
 *  fs.cp cannot read a directory inside app.asar (Electron's asar support
 *  covers readdir, stat and readFile, not the opendir that cp uses), so every
 *  "Create..." on the welcome page failed with ENOENT and left an empty
 *  folder behind. This walks the tree with the calls asar does support. */
export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}
