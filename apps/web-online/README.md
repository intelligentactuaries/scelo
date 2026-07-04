# Scelo Web (`apps/web-online`)

The **hosted, in-browser edition** of the Scelo workbench: a small Bun server
that serves `apps/web`'s Vite build as a single-page app. The whole
soft → tools → hard pipeline, the dashboards, charts and chat panels run
client-side, so this deploys as static files plus a ~100-line server.

The **desktop IDE remains the full offline experience** — terminals, bundled
Python + R runtimes, workspaces. Scelo Web is the zero-install way in; the app
itself tells browser users what needs the download.

## Run locally

```bash
bun run --cwd apps/web build     # build the web app (once, or after changes)
bun run --cwd apps/web-online start
# → http://localhost:8080
```

## Configuration

| Env var | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. |
| `HOSTNAME` | `0.0.0.0` | Bind address. |
| `ORCHESTRATOR_URL` | *(unset)* | When set, `/agents/*` is reverse-proxied there. When unset the route answers 502 and the client's local fallbacks take over (heuristic model picks, local narratives) — the same graceful degradation the desktop IDE uses without a backend. |

## Deploy (Docker)

```bash
docker build -f apps/web-online/Dockerfile -t scelo-web .   # from the repo root
docker run -p 8080:8080 scelo-web
```

Any Linux container host works (Fly, Railway, Hetzner, a VPS behind Caddy /
nginx). Put TLS + compression at the reverse proxy / CDN layer — the server
deliberately stays minimal. `GET /healthz` is the liveness probe.

## What browser users get vs the IDE

| | Scelo Web | Scelo IDE |
| --- | --- | --- |
| Soft → tools → hard pipeline, dashboards, charts | ✅ | ✅ |
| CSV / Parquet import (client-side, files never leave the browser) | ✅ | ✅ |
| AI chat via your own provider key | ✅ | ✅ (+ OS-keychain key storage) |
| Terminals, workspaces, bundled Python + R | — | ✅ |
| Swarm council integration | via `?swarmUrl=` | localhost swarm |
| Works fully offline | — | ✅ |
