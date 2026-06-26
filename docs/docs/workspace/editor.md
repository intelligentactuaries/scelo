# Editor & files

## The file explorer (FILES)

The **FILES** tab is a lazy file tree of your workspace:

- Folders expand on click (`▸ / ▾`); files open in the editor.
- Changed files show a Git status badge in the gutter (`M`, `?`, …).
- The currently open file's row is highlighted.

!!! note "Browse + open only"
    The explorer is intentionally read-and-open. There's **no create / rename /
    delete / move / right-click menu** here — do file management in the
    [terminal](terminal.md) (`touch`, `mkdir`, `mv`, `rm`). Git decorations and
    opening are fully wired; structural file ops are not, by design.

## The editor

Files open in **Monaco** — the same editor core as VS Code.

- **Syntax & language** is inferred from the extension (`.py`, `.r`/`.R`,
  `.ipynb`, `.md`, `.json`, `.yaml`, `.toml`, `.sql`, `.ts`, `.csv`, …).
- **Save** with **⌘/Ctrl+S** (or the **save** button). A `●` marks unsaved
  changes; the header shows *loading… / saving… / saved ✓ / unsaved*.
- **Unsaved drafts** are auto-stashed ~½ second after you type, so reopening a
  file restores your in-progress edits — unless the file changed on disk
  meanwhile, in which case the draft is dropped (with a toast).
- A **breadcrumb** above the editor shows the symbol path (class → method) around
  your caret.

### Language intelligence

Open a `.py` or `.r`/`.R` file and the language servers (**Pyright** for Python,
**R languageserver** for R) light up — hosted by the bundled runtimes, nothing to
install:

| Feature | How |
| --- | --- |
| Diagnostics (squiggles) | Live; also listed in [Problems](panels.md#problems) |
| Autocomplete | Triggers on `. ( [ $ @` |
| Hover docs | Hover any symbol |
| Signature help | On `(` and `,` |
| Go to definition | **⌘/Ctrl+click** |
| Rename symbol | **F2** |
| Find references | **Shift+F12** |
| Quick fix / code actions | Lightbulb (organize imports, add import, …) |
| Format document | **Shift+Alt+F**, or *Editor: Format Document* |
| Inlay hints | Inferred types & parameter names |

On save, an extra lint pass (Pyright / `lintr`) adds markers; an "ⓘ pyright" note
appears when there's a lint hint. *Call hierarchy* is the one feature not wired
(a Monaco limitation).

!!! tip "Scelo snippets"
    Type a `scelo-…` prefix and Monaco offers curated actuarial snippets for
    Python and R.

### Rich viewers

A **preview/source** toggle (**⌘/Ctrl+⇧+V**) switches the right kind of viewer:

- **CSV / TSV** → a sortable **table** (the default view).
- **Markdown** → side-by-side **preview**.
- **`.ipynb`** → a rendered **notebook** view (cells + outputs).

!!! note "Notebooks are view/edit-only"
    The notebook viewer renders cells and saved outputs and lets you edit the
    underlying JSON — there is **no live kernel** in the workspace. To execute
    notebook code, run it in the [terminal](terminal.md).

### Git diff in the editor

When the open file has uncommitted changes, a **Diff / Source** button appears.
Diff mode shows a side-by-side **HEAD vs your buffer** comparison. (Staging and
committing live in the [Git panel](panels.md#git-source-control).)

### Working with the AI panel

- **⌘/Ctrl+L** sends your current selection to the [AI panel](index.md#the-workspace-ai-panel).
- An **apply block** button under an AI reply drops a matching code block back
  into the editor at your selection/caret.
