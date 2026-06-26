# File locations

Where Scelo keeps its settings, runtimes, and per-workspace state. The app's
`userData` directory is:

| Platform | `userData` path |
| --- | --- |
| Linux | `~/.config/Scelo IDE/` |
| macOS | `~/Library/Application Support/Scelo IDE/` |
| Windows | `%APPDATA%\Scelo IDE\` |

## Inside `userData`

| File / folder | What it holds |
| --- | --- |
| `.first-run-complete` | First-run marker (presence skips the setup screen) |
| `workspaces.json` | List of recently opened workspaces |
| `workspace.json` | The last/active workspace |
| `workspace-state-<id>.json` | Per-workspace UI state (open tabs, active tab, sidebar tab, panel widths, terminal visibility) |
| `unsaved/<workspaceId>/…` | Auto-stashed editor drafts |
| `channel.json` | Update channel (stable / beta) |
| `extracted/<id>/` | Extracted bundled resources |

## AI provider secrets

API keys are stored with the OS secure store (`safeStorage` / system keychain)
where available, so they're encrypted at rest and the decrypted key never reaches
the renderer. **reset to defaults** in Settings → AI clears them.

## Bundled runtimes

Python and R ship inside the app package (`resources/runtime/python` and
`resources/runtime/r`) and are placed first on the terminal's `PATH`. They're
part of the install, not under `userData` — uninstalling the app removes them.

## The pipeline workspace

The Scelo pipeline's datasets, cleaning history, and model runs live in the
**workspace folder you opened**, not in `userData` — so they travel with your
project and are easy to back up or put under Git.
