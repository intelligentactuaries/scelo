# Running the swarm

The swarm is a separate application that Scelo embeds. It is **not** bundled into
the installer, so you start it yourself.

!!! info "Access"
    The swarm lives in a **private companion repository** — it is not publicly
    available. If you don't have a checkout, contact the Intelligent Actuaries
    team (hello@intelligentactuaries.com) for access. Scelo itself works fully
    without it; only the "Convene council" / swarm features need it.

## The two ports

| Port | What it is | Used by |
| --- | --- | --- |
| **3010** | The swarm **API** | "Convene council" and "simulate from scenario" |
| **5190** | The swarm **Vite UI** | The embedded swarm panel inside Scelo |

`PORT=3010 bun run dev` starts **both**.

## Start it

From the swarm checkout:

```bash
cd swarms
PORT=3010 bun run dev
```

!!! danger "The `PORT=3010` is required"
    The swarm server's default port is **3000**, but Scelo expects it on
    **3010**. Running it without `PORT=3010` (e.g. plain `bun src/server/index.ts`)
    starts it on 3000 and Scelo can't reach it. Always include `PORT=3010`.

You'll know it's up when:

```
[swarm-council] api on http://localhost:3010
  ➜  Local:   http://localhost:5190/
```

## In the IDE

Open the **swarm** panel in the workspace. It probes the server every few
seconds:

- **● live** — the embedded swarm UI loads.
- **● offline** — it shows a copy-pasteable start command (`PORT=3010 bun run dev`).

## Performance note

Council and simulation run the local LLM (Ollama, `qwen2.5:7b` by default). A
192-agent council can take many minutes; a **12–48 agent** subset completes in
well under a minute. For fast full-size runs, point the swarm at a faster
provider in its own settings.
