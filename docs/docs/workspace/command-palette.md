# Command palette & navigation

Three keyboard-driven pickers, all sharing the same modal (**↑/↓** to move,
**↵** to select, **Esc** to close).

## Quick Open — ⌘/Ctrl+P

A fuzzy **file finder**. Type any part of a path or filename; matches rank by
basename and word boundaries. **↵** opens the file. (Enumerates files with
`rg --files`, so it's fast even in large repos.)

## Symbol search — ⌘/Ctrl+T

A workspace-wide **symbol** finder (functions, classes, methods) via the language
servers — queries **both** the Python and R servers in parallel. Shows the kind
icon, name, container, and `path:line`; **↵** jumps there.

## Command palette — ⌘/Ctrl+⇧+P

Every IDE command in one searchable list. The set includes:

| Command | Shortcut |
| --- | --- |
| File: Open Workspace… | ⌘/Ctrl+O |
| Workspace: Switch Workspace… | ⌘/Ctrl+⇧+O |
| View: Show File Tree / Search / Outline / Source Control / Problems / Tests | — |
| View: Toggle Terminal | Ctrl+` |
| View: Toggle Preview/Source | ⌘/Ctrl+⇧+V |
| Run: Current File | F5 |
| AI: Toggle Workspace AI Panel | ⌘/Ctrl+⇧+A |
| AI: Send Selection to AI | ⌘/Ctrl+L |
| Editor: Format Document | — |
| AI: Open Providers Settings | — |
| Data: Open Downloads Settings | — |
| Reset: All IDE Drafts | — |
| Navigate: Open Swarm / Open Scelo Brain / Runtime Check | — |
| Help: Open Welcome Page | — |

The palette also lists **jump-to-symbol** entries for the *active file* (with line
previews) — handy for navigating one big module without leaving the keyboard.

!!! tip
    See the full [keyboard shortcuts](../reference/shortcuts.md) reference.
