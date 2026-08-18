// Where the swarm keeps its state on disk.
//
// Two ways to run this server:
//   • from a checkout (`bun run dev:swarm`) — state lives in apps/swarm/data,
//     next to the source, as it always has;
//   • bundled inside the Scelo IDE — the server is a `bun build --compile`
//     executable under the app's resources (read-only, and `import.meta.url`
//     then points INSIDE the binary), so the IDE hands it a writable
//     per-user directory through SWARM_DATA_DIR (its userData/swarm) and the
//     built client through SWARM_STATIC_DIR.
//
// Resolution: SWARM_DATA_DIR wins; otherwise the checkout's data dir when
// that path is a real directory we can write; otherwise ./data under the
// current working directory (never inside a compiled binary).

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedDataDir: string | null = null;

/** True when running as a `bun build --compile` executable. */
export function isCompiled(): boolean {
  return import.meta.url.includes('$bunfs') || import.meta.url.includes('/~BUN/');
}

export function dataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  const fromEnv = process.env.SWARM_DATA_DIR?.trim();
  if (fromEnv) {
    cachedDataDir = resolve(fromEnv);
  } else if (!isCompiled()) {
    cachedDataDir = fileURLToPath(new URL('../../data', import.meta.url));
  } else {
    cachedDataDir = resolve(process.cwd(), 'data');
  }
  try {
    mkdirSync(cachedDataDir, { recursive: true });
  } catch {
    // Read-only location (e.g. an app bundle): fall back to cwd so the
    // server can still start and say where it put things.
    cachedDataDir = resolve(process.cwd(), 'data');
    mkdirSync(cachedDataDir, { recursive: true });
  }
  return cachedDataDir;
}

/** Directory holding the built client (index.html + assets) to serve on
 *  the same origin as the API, or null to serve the API only (dev: Vite
 *  serves the client on :5190 and proxies /api here). */
export function staticDir(): string | null {
  const fromEnv = process.env.SWARM_STATIC_DIR?.trim();
  if (fromEnv) return existsSync(fromEnv) ? resolve(fromEnv) : null;
  return null;
}

/** Interface to bind. The IDE binds loopback only; a checkout keeps Bun's
 *  default so LAN demos still work. */
export function bindHost(): string | undefined {
  return process.env.HOST?.trim() || undefined;
}
