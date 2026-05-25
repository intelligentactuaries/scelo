# Onboarding

This document orients a new contributor (human or agent) to the Intelligent
Actuaries codebase. CONTRIBUTING.md covers the *legal* + *process* contract;
this file covers the *technical* one. Read both.

## What you're looking at

Two apps, one repo:

```
apps/web/         the React + Vite SPA. Renders the IDE workspace, chat,
                  Scelo brain dashboards, and the marketing-adjacent
                  surfaces. Runs in a regular browser AND inside the
                  desktop IDE; checks `isDesktopIDE()` to feature-flag
                  IDE-only flows.

apps/scelo-ide/   the Electron wrapper. Bundles Python + R runtimes, the
                  Pyright + R languageserver LSPs, ripgrep, and the
                  renderer dist. Owns the OS-touching surface: file I/O,
                  process exec, terminal, git, dataset downloads, OS
                  keychain, auto-update.
```

The desktop IDE = `apps/web` running inside `apps/scelo-ide`. There is no
separate "IDE renderer." Every IDE feature ships to the browser preview too;
features that need OS access render a "requires Scelo IDE" placeholder there.

## The contract between the two apps

`apps/scelo-ide/src/preload.ts` exposes a single `window.scelo` object to the
renderer. Its full TypeScript shape lives in
`apps/web/src/lib/sceloIDE.ts` — that file is the **type contract**. When you
add an IPC channel, edit both ends + the contract; tsc enforces the alignment.

Conventions:

- IPC channels are namespaced `scelo:<area>:<verb>` (eg `scelo:git:status`,
  `scelo:fs:write`). The renderer never calls `ipcRenderer.invoke` directly;
  always go through the preload-bridged method.
- Each IPC handler in `main.ts` resolves the active workspace via
  `_activeWorkspace(event)` (per-window override → global fallback) and
  rejects paths that escape it with `_resolveInWorkspace`.
- The renderer never has Node access. Anything that needs `node:*` modules
  belongs in `main.ts`.

## The workspace shell

`apps/web/src/routes/Workspace.tsx` is the IDE's main route. The state +
effects layer is `apps/web/src/lib/useWorkspaceShell.ts` — one hook with
nested namespaces:

```ts
const shell = useWorkspaceShell();
shell.tabs        // open[], active, openFile, closeTab
shell.workspace   // path, sidebarTab, sidebarWidth, aiPanelVisible, …
shell.editor      // caretLine, outline, activeBuffer, pendingJump
shell.palettes    // quickOpen, symbol, command, commands[]
```

UI state is persisted per-workspace via `scelo:workspace:state:get/set`.
The shape is versioned (`WorkspaceUIState` in
`apps/scelo-ide/src/migrations/workspaceState.ts`); pre-v1 files migrate
transparently on read. Add new fields as **optional**; only structural
reshapes warrant a version bump.

## The bus pattern

Cross-component messaging in the workspace uses tiny module-scope pub/sub
files in `apps/web/src/lib/*Bus.ts`. They share the same shape:

```ts
const listeners = new Set<Listener>();
export function emitX(...): void { for (const fn of listeners) fn(...); }
export function subscribeX(fn): () => void { … return () => listeners.delete(fn); }
```

The buses in play today:

| Bus | What it carries |
|---|---|
| `toastBus` | global toast notifications |
| `lspBus` | Pyright + R-LSP starting / live / error / off |
| `gitBus` | cached `GitStatus` + a 30 s refresh tick |
| `diagnosticsBus` | rolling `Map<path, Diagnostic[]>` from LSPs |
| `terminalBus` | "please run this in the shell" requests |
| `editorViewerBus` | toggle source ↔ rich viewer |
| `editorSelectionBus` | current Monaco selection cache |
| `aiPanelBus` | "open" / "stage this prompt" |
| `applyToEditorBus` | "replace selection with this text" |

Prefer a new bus over prop-drilling once a third component needs the data.

## Migrations

`apps/scelo-ide/src/migrations/` has both flavours:

- **Startup (one-shot, destructive).** Use `runOnce(ctx, "<id>", () => …)`
  from `markers.ts`. The runner writes `.migration-<id>-done` under
  userData; bumping the id is the way to re-run after a schema reshape.
  Existing: `extracted-dir-v1`.
- **Data (on-read, idempotent).** Pure functions, eg
  `migrateWorkspaceStateToV1`. Called inline from IPC handlers.

`runStartupMigrations(ctx, opts)` is fired from `app.whenReady()`. New
schema reshapes drop a single file under the directory rather than landing
inline in `main.ts`.

## Sample workspaces

`apps/scelo-ide/templates/<id>/` ships three plain-text starter trees that
the `scelo:workspace:create-from-template` IPC copies into a user-chosen
parent dir. All files are runnable as-is (no TODO bodies). Add a new
template by:

1. Drop a new directory under `templates/`.
2. Append its id to `SAMPLE_TEMPLATES` in `main.ts` (allow-listed for
   security : the IPC rejects ids not in the list).
3. Add a `SampleWorkspaceSpec` entry to `apps/web/src/lib/sampleWorkspaces.ts`.

`electron-builder.yml` already bundles `templates/**/*` into the asar.

## Running it

```bash
# Renderer dev server (browser preview at localhost:5173)
cd apps/web && bun run dev

# Desktop IDE dev (Electron wrapping the dev server)
cd apps/scelo-ide && bun run dev

# Tests
cd apps/web && bun test                # ~86 tests, ~1 s
cd apps/web && bunx tsc --noEmit       # type-check both apps
cd apps/scelo-ide && bunx tsc --noEmit

# Production build (renderer dist + AppImage / dmg / nsis)
cd apps/scelo-ide && bun run dist:linux # / dist:mac / dist:win
```

The CI gate is `make check` from the repo root (per CONTRIBUTING.md).

## AI providers

`apps/web/src/lib/aiProviders.ts` is the renderer surface. Ollama is the
default; users can BYO Claude / OpenAI / Gemini / OpenAI-compatible keys.
Inside Scelo IDE the secrets live in the OS keychain
(`scelo:secrets:get/set`, which delegates to Electron's `safeStorage` →
macOS Keychain / Windows DPAPI / libsecret). In the browser preview they
fall back to `localStorage` with a UI warning.

A first-run modal (`components/FirstRunAIPrompt.tsx`) gates the choice
when (a) no provider has been picked AND (b) Ollama isn't responding on
`localhost:11434`. Once dismissed it never reappears
(`ia.firstRun.aiPrompt.shown.v1` in localStorage).

## House rules (the ones that aren't in the linter)

- **No em-dashes in user-facing prose.** Use `:` (lists / definitions) or
  `,` (clauses / parentheticals). Code comments + null placeholders are
  exempt.
- **Per-workspace state is opaque to other workspaces.** Conversations,
  search history, UI state are keyed by workspace id; never read or
  write across that boundary.
- **Atomic writes.** Downloads use `<file>.partial → <file>` rename.
  Templates use the OS `cp -r` semantics via `node:fs/promises#cp`.
- **One-way pipeline in the Scelo brain.** `apps/web/src/components/Scelo/`
  enforces soft → tools → hard data flow; never write to hard from soft
  directly. The `scelo-brain` template scaffolds this pattern from scratch.

## When you're stuck

- Phase-by-phase context lives in `apps/scelo-ide/README.md`. Search for
  the feature name (eg "diff", "Welcome", "snippets") to find the phase
  that introduced it.
- Architectural ADRs live in `docs/adr/`. `ADR-0018` covers the chat
  routing model; later ADRs cover specific subsystems.
- The Scelo brain has a living spec at
  `apps/web/src/components/Scelo/SKILL.md` — behavioural changes there
  must update the spec in the same commit.
