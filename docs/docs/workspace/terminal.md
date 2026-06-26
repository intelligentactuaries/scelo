# Terminal & runtimes

## The integrated terminal

Toggle the terminal with **Ctrl+`** (backtick) or the **▴/▾ terminal** button in
the status bar. The header shows the working directory and a running/exited
indicator plus *"bundled python/R on PATH"*.

- It's a **real PTY** (via node-pty) — interactive REPLs and full-screen TUIs
  work: `ipython`, the `R` REPL, `vim`, `htop`, etc. On Windows it uses ConPTY
  (pwsh → powershell → cmd); on macOS/Linux your `$SHELL`.
- There is **one long-lived terminal** per workspace window. When you hide it,
  it stays mounted — **long-running jobs keep running** (dev servers, training
  loops) and reappear when you toggle it back.
- 4000 lines of scrollback.

## Bundled Python & R

Scelo ships its own Python (PBS CPython) and R, and puts them **first on PATH**
inside the terminal. So out of the box:

```bash
python --version       # the bundled CPython
python -c "import lifelib"
pip install some-package
R --version
Rscript my_model.R
```

No system Python or R required, and nothing you install here touches your OS
environment.

!!! tip "Check the stack"
    The command palette's **Navigate: Runtime Check** reports what the bundled
    runtimes are and which key packages are present.

## Running a file

Press **F5** (or *Run: Current File*) to run the active file in the terminal:

- `.py` → `python <file>`
- `.R` / `.r` → `Rscript <file>`
- anything else → a toast saying only Python/R are runnable this way.

The command is injected into the visible terminal, so you see the full output and
can keep interacting.

## Running tests

The [Tests panel](panels.md#tests) discovers **pytest** and **testthat** tests
and its **run** actions push the right command into this same terminal
(`pytest`, `pytest <file>`, `pytest <id>`, or `Rscript -e testthat::test_dir(...)`).
The terminal output is the source of truth for pass/fail.

## Notebooks

`.ipynb` files open in a **read-only notebook viewer** in the editor — there's no
in-app kernel. To execute notebook code, run it from the terminal (e.g.
`jupyter nbconvert --execute`, or paste cells into `ipython`).
