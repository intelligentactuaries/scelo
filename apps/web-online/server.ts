// Scelo Web — the hosted, in-browser edition of the Scelo workbench.
//
// A deliberately small Bun server that serves apps/web's Vite build as a
// single-page app. Everything that makes Scelo Scelo (the soft → tools →
// hard pipeline, dashboards, charts, chat panels) runs client-side, so
// hosting is: static files + SPA fallback + two conveniences:
//
//   /healthz     liveness probe for the host platform
//   /agents/*    optional reverse proxy to a Scelo orchestrator, enabled by
//                setting ORCHESTRATOR_URL. Without it the route answers 502
//                and the app's built-in local fallbacks take over (heuristic
//                model picks, local narratives) — same behaviour as the
//                desktop IDE without a backend.
//
// The desktop IDE remains the full offline experience (terminals, bundled
// Python + R); the web app tells users so and links the download.
//
// Run:            bun run apps/web-online/server.ts
// Configuration:  PORT (default 8080) · HOSTNAME (default 0.0.0.0)
//                 ORCHESTRATOR_URL (optional, e.g. http://127.0.0.1:8000)

import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const DIST = resolve(import.meta.dir, '../web/dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOSTNAME = process.env.HOSTNAME ?? '0.0.0.0';
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL?.replace(/\/+$/, '');

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(
    `[scelo-web] no build found at ${DIST}\n` +
      '[scelo-web] build the web app first:  bun run --cwd apps/web build',
  );
  process.exit(1);
}

const INDEX = join(DIST, 'index.html');

// Vite emits content-hashed filenames under /assets — safe to cache forever.
// index.html (and the handful of root-level static files) must revalidate so
// a redeploy is picked up on the next load.
function cacheHeaderFor(pathname: string): string {
  return pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

function resolveStatic(pathname: string): string | null {
  // decode + normalise, then confine to DIST — a traversal attempt
  // ("/../secrets") normalises outside and is rejected.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const full = normalize(join(DIST, decoded));
  if (!full.startsWith(DIST)) return null;
  return full;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'cache-control': 'no-store' } });
    }

    // Optional orchestrator pass-through. Absent → 502, and the client's
    // local fallbacks handle it exactly like the offline IDE does.
    if (url.pathname.startsWith('/agents/')) {
      if (!ORCHESTRATOR_URL) {
        return new Response('orchestrator not configured', { status: 502 });
      }
      const target = `${ORCHESTRATOR_URL}${url.pathname}${url.search}`;
      try {
        return await fetch(new Request(target, req));
      } catch {
        return new Response('orchestrator unreachable', { status: 502 });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    const staticPath = resolveStatic(url.pathname);
    if (staticPath) {
      const file = Bun.file(staticPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'cache-control': cacheHeaderFor(url.pathname) },
        });
      }
    }

    // SPA fallback — /dashboards/scelo/soft, /welcome, /swarm etc. all load
    // index.html and the client router takes it from there.
    return new Response(Bun.file(INDEX), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  },
});

console.log(`[scelo-web] serving ${DIST}`);
console.log(`[scelo-web] listening on http://${HOSTNAME}:${server.port}`);
console.log(
  ORCHESTRATOR_URL
    ? `[scelo-web] /agents/* proxied to ${ORCHESTRATOR_URL}`
    : '[scelo-web] no ORCHESTRATOR_URL — /agents/* answers 502, client falls back locally',
);
