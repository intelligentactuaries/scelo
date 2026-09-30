# Troubleshooting

## The swarm panel says "offline" / "unreachable at :3010"

Scelo IDE starts its bundled swarm server when the app opens (on
`127.0.0.1:3010`, or the next free port). If the panel stays offline, use its
**restart swarm server** button, or quit and reopen Scelo; the panel shows the
reason from `<userData>/logs/swarm.log` if the server keeps failing. In the
browser build, or when hacking on the swarm, start the dev pair from a checkout
with `bun run dev:swarm` (API 3010, UI 5190) and Scelo adopts it. See
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

## Windows / macOS: "unknown publisher", or macOS blocks the app

The installers are not code-signed yet. On Windows, choose **More info → Run
anyway**. On macOS, allow the app once under **System Settings → Privacy &
Security → Open Anyway** (or Control-click → **Open** on macOS 14). If macOS
calls it **"damaged and can't be opened"**, the download's quarantine flag is
the cause, not the file; clear it with
`xattr -dr com.apple.quarantine "/Applications/Scelo IDE.app"`. Step by step:
[Windows & macOS](../installation/windows-macos.md#one-click-installer).

## R bridges fail on Linux ("libR.so: cannot open shared object file")

The bundled R on Linux is Ubuntu 24.04's R, repacked, and it loads the system's
R libraries. On Ubuntu 24.04, install them with `sudo apt install r-base-core`
(a default `apt install scelo-ide` already does, as a recommended package). On
22.04 and older distributions the bundled R can't run yet (it needs glibc 2.38);
the Python side of Scelo is unaffected. See
[Linux](../installation/linux.md).

## The terminal has no colours, prompt or line editing

Earlier installers could not load the terminal's pseudo-terminal module and fell
back to a plain pipe: commands ran, but without a prompt, colours, line editing
or full-screen programs. From 0.2.0 the terminal is a real pseudo-terminal on
Linux and macOS. If you still see the plain pipe, check the log for
`node-pty: load failed` (where the log lives:
[File locations](file-locations.md#logs)).
