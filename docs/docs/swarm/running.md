# Running the swarm

The swarm is part of Scelo — it lives in the repo at
[`apps/swarm/`](https://github.com/intelligentactuaries/scelo/tree/main/apps/swarm)
under the same licence — but it is **not bundled into the installer** (yet). It
is a Bun + Vite pair that you start from a Scelo checkout, and the IDE embeds
it. Scelo itself works fully without it; only "Convene council", "simulate from
scenario" and the swarm panel need it.

## The two ports

| Port | What it is | Used by |
| --- | --- | --- |
| **3010** | The swarm **API** | "Convene council" and "simulate from scenario" |
| **5190** | The swarm **Vite UI** | The embedded swarm panel inside Scelo |

`bun run dev:swarm` starts **both**.

## Start it

From a Scelo checkout, once: `bun install` (the repo root installs every app,
the swarm included). Then:

```bash
bun run dev:swarm
```

That is the whole command — the same on Linux, macOS, Windows cmd and
PowerShell. The swarm's API defaults to **3010** and its UI to **5190**, which is
exactly what Scelo probes, so no `PORT=…` prefix is needed. (`PORT` still
overrides the API port if you ever need to move it, but then Scelo won't find
it.)

You'll know it's up when:

```
  ➜  Local:   http://localhost:5190/
[swarm-council] api on http://localhost:3010
```

!!! tip "Prerequisites"
    [Bun](https://bun.sh) ≥ 1.1 and [Node.js](https://nodejs.org) LTS on your
    PATH (the dev spawner runs Vite under `node`; install with bun only). For
    council and simulation you also want an LLM provider:
    a local [Ollama](https://ollama.com) is picked up automatically, as is a
    signed-in Claude Code CLI; or paste an API key in the swarm's own
    settings.

## In the IDE

Open the **swarm** panel in the workspace. It probes the server every few
seconds:

- **● live** — the embedded swarm UI loads.
- **● offline** — it shows the copy-pasteable start command (`bun run dev:swarm`).

## Performance note

Council and simulation run the local LLM (Ollama, `qwen2.5:7b` by default). A
192-agent council can take many minutes; a **12–48 agent** subset completes in
well under a minute. For fast full-size runs, point the swarm at a faster
provider in its own settings.
