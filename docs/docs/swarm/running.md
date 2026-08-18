# Running the swarm

The swarm is part of Scelo — it lives in the repo at
[`apps/swarm/`](https://github.com/intelligentactuaries/scelo/tree/main/apps/swarm)
under the same licence — and **Scelo IDE bundles it and starts it with the
app**. There is nothing to start by hand: the IDE's main process launches the
swarm server on a loopback port when Scelo opens, the swarm panel, "Convene
council" and "simulate from scenario" attach to it, and it stops when Scelo
quits.

## Inside Scelo IDE (bundled)

| What | Where |
| --- | --- |
| Server | `<resources>/swarm/swarm-server` — a single executable (`bun build --compile` of the swarm's Bun server) shipped in the installer |
| UI | `<resources>/swarm/ui` — the built swarm client, served by that server on the **same origin** |
| Address | `http://127.0.0.1:3010` by default (loopback only); the next free port if 3010 is taken |
| Data | `<userData>/swarm/` — the SQLite database and canon live with the user, not in the app bundle |
| Log | `<userData>/logs/swarm.log` |

The header "swarm" LED and the Welcome card go **● live** as soon as the server
answers. The swarm panel shows the supervisor's status while it starts, and — if
it ever crashes — the reason from the log tail plus a **restart swarm server**
button. It restarts itself up to three times with backoff before giving up.

If a swarm server is *already* answering on 3010 when Scelo starts (a
developer's `bun run dev:swarm`), Scelo **adopts** it instead of starting its
own — the two never fight over the port.

## From a checkout (dev)

For hacking on the swarm itself, the dev pair still works:

```bash
bun run dev:swarm
```

That is the whole command — the same on Linux, macOS, Windows cmd and
PowerShell. The API defaults to **3010** and the Vite UI to **5190**. Start it
before (or while) the IDE is running and the IDE adopts it; the browser build of
Scelo (which cannot bundle a server) uses this pair only.

!!! tip "Prerequisites (checkout only)"
    [Bun](https://bun.sh) ≥ 1.1 and [Node.js](https://nodejs.org) LTS on your
    PATH (the dev spawner runs Vite under `node`). For council and simulation
    you also want an LLM provider: a local [Ollama](https://ollama.com) is
    picked up automatically, as is a signed-in Claude Code CLI; or paste an
    API key in the swarm's own settings. The bundled server looks in the usual
    places (`~/.local/bin`, `/opt/homebrew/bin`, …) for `claude` and `ollama`,
    even when the IDE was launched from a desktop icon with a short PATH.

## Performance note

Council and simulation run the local LLM (Ollama, `qwen2.5:7b` by default). A
192-agent council can take many minutes; a **12–48 agent** subset completes in
a fraction of the time. Pick a faster provider (Claude Code, or an API key) in
the swarm's settings for full councils.
