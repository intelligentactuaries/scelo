# Scelo IDE

**Scelo is a desktop workbench for actuaries.** It takes you from raw data to
board-pack-ready results in one place, with a bundled Python and R runtime, the
actuarial stack (lifelib, chainladder, climada, and more), and AI co-pilots
scoped to each stage of the work. It runs **fully offline** once installed.

<div class="scelo-demo" data-scelo-demo="macro"><p class="sd-fallback">The Scelo macro canvas: Soft Data, Tools and Hard Data as three wired stage cards. The animated illustration needs JavaScript.</p></div>

<div class="grid cards" markdown>

-   :material-table: **Soft Data**

    Load a CSV / Parquet, inspect every column, clean and reshape it by click
    or by chat.

-   :material-tune-vertical: **Tools**

    Pick the right actuarial models, or let Scelo suggest them for your
    dataset's shape and domain.

-   :material-chart-box: **Hard Data**

    Run the models, read the results on a canvas, and export a printable
    board-pack PDF.

-   :material-account-group: **The swarm**

    Convene a multi-agent council to pressure-test a forecast, and simulate a
    population's response to a scenario.

</div>

---

## What makes Scelo different

- **Offline + private.** The bundled Python/R runtime and a local LLM (Ollama)
  mean your client data never has to leave the machine. Hosted AI providers are
  opt-in.
- **A pipeline, not a pile of scripts.** Soft data → tools → hard data is a
  guided flow where each stage carries its own scoped AI assistant.
- **Two surfaces in one app.** A guided **pipeline** for the analysis, and a
  full **VS Code-style workspace** (editor, terminal, Git, search) for when you
  want to drop into code.
- **Reproducible.** Every action you take can be exported as a runnable Python,
  R, or C++ script.

## How this manual is organised

| Section | What's in it |
| --- | --- |
| [Installation](installation/index.md) | Get Scelo onto Linux, Windows, or macOS |
| [Getting started](getting-started.md) | Your first run, end to end |
| [The workspace](workspace/index.md) | Editor, terminal, Git, search, command palette |
| [The pipeline](pipeline/index.md) | Soft Data, Tools, Hard Data in depth |
| [The swarm](swarm/index.md) | Council, society pulse, and simulation |
| [AI providers](ai-providers.md) | Ollama and hosted providers |
| [Chat](chat.md) | The scoped assistants throughout the app |
| [Exporting](exporting.md) | Code export and the board-pack PDF |
| [Reference](reference/shortcuts.md) | Shortcuts, file locations, troubleshooting |

!!! tip "New here?"
    Install Scelo ([Linux](installation/linux.md) ·
    [Windows/macOS](installation/windows-macos.md)), then follow
    [Getting started](getting-started.md) for a full walk-through.
