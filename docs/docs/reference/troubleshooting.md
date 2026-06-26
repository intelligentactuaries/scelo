# Troubleshooting

## The swarm panel says "offline" / "unreachable at :3010"

The swarm server isn't running, or it's on the wrong port. It must run on **3010**
(its own default is 3000):

```bash
cd swarms
PORT=3010 bun run dev
```

`PORT=3010 bun run dev` starts **both** the API (3010) and the UI (5190). See
[Running the swarm](../swarm/running.md).

## "Test connection" returns "(connected — model returned no text)"

The connection is fine — a *reasoning* model (e.g. `gpt-oss`, DeepSeek R1) spent
its budget thinking before emitting visible text. Give it more tokens or pick a
non-reasoning model. See [AI providers](../ai-providers.md).

## Chat / suggestions do nothing

Check **Settings → AI providers**:

- Using the default **Ollama**? Make sure Ollama is running locally and the model
  (`qwen2.5:7b-instruct`) is pulled.
- Using a hosted provider? Re-run **test connection** to confirm the key/model.

## A date column won't reformat from the chat

Use the deterministic phrasing — `make the dates american` (or *european* / *iso*)
in the Soft Data chat, or click the **📅 ▾** badge on the column. In a column
chat: `make this american`, `remove all non-dates`, `clean this column`. Other
phrasings fall through to the AI and may only *advise*. See [Chat](../chat.md).

## I can't create or rename files in the explorer

That's expected — the file tree is browse-and-open only. Use the
[terminal](../workspace/terminal.md) (`touch`, `mkdir`, `mv`, `rm`).

## "git is not a repository" in the Git panel

Run `git init` in the terminal — the panel doesn't initialize repos. Push, pull,
and branch switching are also terminal-only;
[the panel](../workspace/panels.md#git-source-control) does stage / unstage /
commit.

## `pip install` / `import` fails in the terminal

The bundled Python is first on `PATH`, so `pip install` targets it. If a package
still won't import, confirm you're using the bundled interpreter
(`which python`) and check **Navigate: Runtime Check** in the command palette.

## Notebook cells won't run

The `.ipynb` viewer is read-only — there's no in-app kernel. Execute notebooks
from the terminal (e.g. `jupyter nbconvert --execute`). See
[Terminal & runtimes](../workspace/terminal.md#notebooks).

## A council run takes minutes

A full 192-agent council is heavy on a local LLM. Run a **12–48 agent** subset for
quick iterations, or point the swarm at a faster provider in its own settings. See
[Running the swarm](../swarm/running.md#performance-note).

## The Linux `.deb` won't verify / update

Install it from the signed apt repository so it's verified and auto-updating —
see [Linux installation](../installation/linux.md).

## Windows / macOS: "unknown publisher" or a partial download

The cross-platform packages may need a finishing step on your own OS. Follow
[Windows & macOS](../installation/windows-macos.md).
