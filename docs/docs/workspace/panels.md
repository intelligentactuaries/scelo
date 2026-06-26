# Search, Git, Problems, Tests

The four remaining sidebar tabs. (FILES and OUTLINE are covered under
[Editor & files](editor.md).)

## Search

Find-in-files powered by **ripgrep** (the bundled binary, or system `rg`).

- The query is a **ripgrep regex**. Press **Enter** to run, **Escape** to stop.
- **Include** / **exclude** glob fields scope the search (e.g. include `*.py`,
  exclude `tests/*`). `node_modules`, `__pycache__`, and `.git` are always
  excluded; results cap at 200 per file.
- Results group by `path:line` with the match highlighted — click to open at that
  line.
- **Replace**: type a replacement and **replace…**; a confirmation dialog shows
  the file/match counts, then the matched ranges are rewritten on disk. The
  replacement is a **literal string** (blank = delete the matches), not a regex
  backreference.
- Recent queries are kept as clickable chips.

## Git / source control

A focused Git surface (it auto-refreshes every ~30s):

- **Branch line** — current branch, upstream, and ahead/behind (`↑n ↓n`).
- **Staged** and **Changes** groups — click a file to open it; per-file
  **+ (stage)** / **− (unstage)**, plus **stage all**.
- **Commit** — a message box (drafted per branch) + **commit**, or
  **⌘/Ctrl+Enter**. A toast shows the new short SHA.

!!! note "Stage / unstage / commit only"
    Push, pull, branch create/switch, `git init`, and stash are **not** in this
    panel — do those in the [terminal](terminal.md). To view a diff, use the
    editor's **Diff** toggle (see [Editor](editor.md#git-diff-in-the-editor)).
    Empty states guide you (e.g. "not a git repository — run `git init` in the
    terminal").

## Problems

A workspace-wide list of diagnostics from the language servers (open a `.py` or
`.r` file to populate it):

- Grouped by file; each row shows severity, `line:col`, the message, and the
  source/code (e.g. `pyright(reportX)`).
- The header aggregates error / warning / info counts.
- Click a row to jump to the offending line.

## Tests

Discovery and one-click running for **pytest** (Python) and **testthat** (R):

- **rescan** discovers tests (pytest needs a `tests/` + `pyproject.toml`/
  `conftest.py`; testthat needs `tests/testthat/test-*.R`).
- Tree of *framework → file → test*.
- **run all**, **run file**, **run one test** — each sends the right command to
  the [terminal](terminal.md#running-tests).

!!! note
    This panel **discovers and launches**; it doesn't track pass/fail itself —
    read the result in the terminal output.
