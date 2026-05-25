# Scelo IDE

A downloadable desktop workbench for actuaries. Scelo IDE wraps the IA web
workbench in an Electron shell and ships a bundled Python + R runtime so an
actuary can run the soft → tools → hard pipeline (lifelib, chainladder,
climada, statsmodels, …) without setting anything up.

```
┌──────────────────────────────────────────────────────────────┐
│ Electron shell  (main + preload)                             │
│   ▸ scelo:// custom protocol (SPA fallback)                  │
│   ▸ IPC: window.scelo.runPython / runR / runtimeStatus       │
├──────────────────────────────────────────────────────────────┤
│ Renderer = apps/web Vite build                               │
│   ▸ Scelo macro at /dashboards/scelo                         │
│   ▸ React Router, ECharts, React Flow, …                     │
├──────────────────────────────────────────────────────────────┤
│ Bundled runtimes (resources/runtime/)                        │
│   ▸ python/  ← portable CPython 3.11 (python-build-standalone)│
│   ▸ r/       ← portable R (per OS strategy)                  │
│   ▸ manifest.json                                            │
└──────────────────────────────────────────────────────────────┘
```

## Build

```bash
# From the monorepo root:
bun install

# One-time per target OS: stage the bundled runtimes.
# Downloads python-build-standalone + (Phase 2) portable R, then pip-installs
# the IA Python stack into resources/runtime/python/.
TARGET_OS=linux bun run --cwd apps/scelo-ide bundle:runtime
TARGET_OS=mac   bun run --cwd apps/scelo-ide bundle:runtime
TARGET_OS=win   bun run --cwd apps/scelo-ide bundle:runtime

# Per-platform installers (run on the target OS):
bun run --cwd apps/scelo-ide dist:linux   # → build/*.AppImage  + *.deb
bun run --cwd apps/scelo-ide dist:mac     # → build/*.dmg
bun run --cwd apps/scelo-ide dist:win     # → build/*.exe (nsis)
```

## Dev loop

```bash
# Build the renderer + Electron main, then launch.
bun run --cwd apps/scelo-ide build
bun run --cwd apps/scelo-ide dev
```

Renderer hot-reload is wired the same way the rest of apps/web works — for
fast iteration on UI changes, prefer `bun run dev` in apps/web and develop
in a browser, then rebuild the renderer (`build:renderer`) when you want
to validate it inside the IDE shell.

## Architecture notes

### scelo:// protocol

apps/web uses `BrowserRouter`, which reads `window.location.pathname`. Under
`file://` the pathname is the full disk path to `index.html`, so the router
matches no routes. The main process registers a `scelo://` custom protocol
with a SPA-style handler:

- asset paths (anything with a file extension) → served from
  `resources/renderer/`
- any other path → falls back to `index.html` so React Router can take over

This keeps `apps/web` unchanged: the same build works in a browser at
`/dashboards/scelo` and in Electron at `scelo://app/dashboards/scelo`.

### Renderer ↔ bundled runtime

The preload exposes a tiny RPC surface on `window.scelo`:

```ts
window.scelo.runPython({ script }) → { ok, stdout, stderr, exitCode }
window.scelo.runR({ script })      → { ok, stdout, stderr, exitCode }
window.scelo.runtimeStatus()       → { python, r, resourceDir }
```

`runtimeStatus()` returns `false` for any runtime that hasn't been bundled,
so the Scelo TS code can degrade gracefully (e.g. show "Python not
available" on the Tools page rather than spinning forever).

## Phase 2 follow-ups

Everything below is documented but not yet shipped. Each is its own
multi-day workstream.

### 1. Bundle R per platform

The Phase 1 bundler stubs the R runtime so the AppImage builds. To finish:

- **macOS** — extract `R.framework` from
  `https://cran.r-project.org/bin/macosx/big-sur-arm64/base/R-X.X.X-arm64.pkg`
  via `xar -xf`, repackage the framework into `resources/runtime/r/`.
- **Windows** — use the R-portable distribution from SourceForge, extract
  to `resources/runtime/r/`.
- **Linux** — either statically link R (`./configure --enable-R-static-lib`)
  or vendor a `r-portable-static` distribution. Alternatively: ship
  [WebR](https://docs.r-wasm.org/webr/) (R compiled to WebAssembly) and
  call it from the renderer — no native R needed, but native CRAN
  packages with C/Fortran code (`ChainLadder`, `mgcv`) need WASM rebuilds.

CRAN package set: `renv::snapshot()` against a curated `renv.lock` so the
bundle is deterministic, then `cp -r renv/library resources/runtime/r/library`.

### 2. macOS code signing + notarisation

```bash
# Set in CI secrets:
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
export CSC_LINK=...           # base64 .p12
export CSC_KEY_PASSWORD=...

# Then flip notarize to true in electron-builder.yml.
```

Apple Developer Program: $99/yr. Without notarisation the macOS app shows
the "unidentified developer" Gatekeeper warning.

### 3. Windows code signing

EV cert (~$300/yr) — gets immediate SmartScreen reputation. Standard cert
(~$200/yr) — accrues reputation over downloads. Set `CSC_LINK` /
`CSC_KEY_PASSWORD` in CI; electron-builder picks them up automatically.

### 4. CI: build + release workflow

GitHub Actions matrix on `ubuntu-latest`, `macos-latest`, `windows-latest`
that runs `bundle:runtime` then `dist:<os>`, uploads to a GitHub Release.
~30 min per platform. The runtime tarball cache helps a lot — Python and R
binaries don't change between repo commits.

### 5. Auto-update via electron-updater

Add `publish` block to `electron-builder.yml` pointing at the GitHub
Releases endpoint, wire `autoUpdater.checkForUpdatesAndNotify()` in
`main.ts`. Works on macOS (signed) and Windows (nsis); Linux usually
relies on the user re-downloading the AppImage.

### 6. First-run actuarial-stack initialisation

Even with bundled wheels, the first run should validate the stack:

```
import numpy, pandas, scipy, statsmodels, lifelib, chainladder, climada
```

— and surface a single-screen "stack OK / re-install missing" report. Same
for R: `library(ChainLadder); library(forecast); library(lifecontingencies)`.

### 7. Wire the renderer to actually call Python / R

Most Scelo computations today run in TypeScript (basicterm-projection,
WMTR, etc.). The bundled runtime is only useful if specific Tools delegate
to it — e.g. `lifelib` for the IFRS-17 CSM rollup, `chainladder` (Python)
or `ChainLadder` (R) for reserving, `climada` for climate scenarios. Per
Tool, add an `if (window.scelo?.runtimeStatus().python) …` branch that
shells out instead of running the TS port.

### 8. Bundle webfonts

The renderer currently pulls Fraunces / Inter / JetBrains Mono from Google
Fonts at runtime — breaks offline use. Add `@fontsource/fraunces`,
`@fontsource/inter`, `@fontsource/jetbrains-mono` to `apps/web` and remove
the Google Fonts `<link>` in `index.html`.

## Status

### Phase 1 (initial scaffold)
- [x] Electron shell loads the apps/web renderer via `scelo://` protocol
- [x] IPC bridge for `runPython` / `runR` / `runtimeStatus`
- [x] electron-builder configs for `.dmg`, `.nsis`, `.deb`, `.AppImage`
- [x] Runtime-bundling script for Python (stub for R)
- [x] Linux `.AppImage` builds and launches end-to-end (108 MB, stub runtime)

### Phase 2 (offline-ready, signed, self-updating)
- [x] Bundled webfonts (Fraunces, Inter, JetBrains Mono, SN Pro via @fontsource)
- [x] Real R bundling logic per OS (Linux: repack from system/CRAN deb; macOS: xar-extract R.framework from CRAN .pkg; Windows: silent install of R-installer)
- [x] R packages auto-resolved on bundle (ChainLadder, lifecontingencies, forecast, mgcv, data.table, jsonlite)
- [x] electron-updater wired (GitHub Releases publish target, 6h polling, env-disable, dev no-ops)
- [x] GitHub Actions release matrix (ubuntu / macos / windows on `scelo-ide-v*` tags)
- [x] macOS signing + notarisation config (env-driven CSC_LINK / APPLE_ID / hardenedRuntime + entitlements.mac.plist)
- [x] Windows signing config (env-driven CSC_LINK)
- [x] First-run `/runtime-check` screen — probes the bundled Python + R for per-package import / library status
- [x] Renderer → bundled Python proof: `runModelAsync("basicterm-projection")` delegates to real lifelib via `bridges/lifelibBasicTermPython.ts`, falls back to the TS port

### Phase 2.5 (bring-your-own AI)
- [x] Real Anthropic / OpenAI / Gemini / OpenAI-compatible providers in `packages/ia-agents/ia_agents/providers/`
- [x] Per-request provider override via `X-IA-Provider` / `X-IA-API-Key` / `X-IA-Provider-Model` / `X-IA-Base-URL` headers on `/api/agents/orchestrator/{stream,test}`
- [x] Electron `safeStorage` IPC (`window.scelo.secrets.{list,get,set,clear,status}`) — OS keychain on macOS / DPAPI on Windows / libsecret on Linux, with plain-text fallback when libsecret is missing (surfaced to the UI)
- [x] `/settings/ai` route in apps/web — provider catalog (Ollama default, Anthropic, OpenAI, Gemini, OpenAI-compat for LM Studio/vLLM/Together/Groq/Fireworks/Perplexity/…), key field, model field, base-URL field, "Test connection" button, browser-fallback warning when not inside the IDE

### Phase 3 (IDE-literal)
- [x] Streaming runtime IPC (`scelo:exec:start` / `chunk` / `end` / `cancel` / `write`)
- [x] xterm terminal panel — wired to OS shell with bundled python/R prepended to PATH
- [x] File browser sidebar with workspace selection (Electron dialog → tree)
- [x] Monaco editor with `fs.read` / `fs.write` IPC, ⌘/Ctrl-S to save, language inferred from extension
- [x] Auto-update channel selector (stable / beta)
- [x] `/workspace` route — three-pane layout (file tree · editor · terminal)
- [x] File → Open Workspace… menu entry

### Phase 4 (delegation, persistence, telemetry)
- [x] chainladder Python bridge — chain-ladder / mack / bornhuetter-ferguson / bootstrap delegate to canonical `chainladder` package
- [x] climada Python bridge — `climada` for AAL + RP10/100/250
- [x] lifecontingencies R bridge — canonical a(x,n) / A(x,n) / nEx via CRAN package
- [x] Multi-tab editor + open-file persistence (`scelo:workspace:state:*` IPC; prunes deleted-on-disk entries on rehydrate)
- [x] Per-provider usage tally + `/settings/ai` panel (today calls/tools/seconds + 7-day rollup, reset button)

### Phase 5 (real PTY, real costs, more bridges)
- [x] node-pty terminal with graceful spawn() fallback — full readline/curses (ipython, R REPL, vim) when the native module loads; bundled binaries via @homebridge/node-pty-prebuilt-multiarch + @electron/rebuild
- [x] Token-level cost tracking — providers emit `usage` AgentEvents (Anthropic `message_delta.usage`, OpenAI `[DONE].usage` via `stream_options.include_usage`, Gemini `usageMetadata`); orchestrator router records tokens + USD via a per-model price table; /settings/ai shows tokens-in/out + today/7-day USD
- [x] Lee-Carter Python bridge — numpy SVD + statsmodels SARIMAX(0,1,0) on κ(t) with 95 % CI, replaces the in-browser linear-decay stub
- [x] IFRS 17 CSM Python bridge — lifelib `ifrs17sim` (with an inlined BBA fallback when the optional sub-library is missing)

### Phase 6 (LSP-lite, GLM, live cost meter)
- [x] Pyright diagnostics on save — `scelo:fs:lintPython` shells to bundled `pyright --outputjson`; EditorPanel converts to Monaco markers (red squiggles + hover messages). Bundled via `pip install pyright` in `bundle:runtime`. Full persistent LSP deferred (its own multi-session item).
- [x] statsmodels GLM frequency/severity bridge — Poisson (with optional exposure offset) + Gamma log-link; returns coefficient table, AIC, deviance, Pearson χ². Wired for `glm-frequency` / `glm-severity`.
- [x] Inline cost meter in chat — providers' `usage` SSE events flow through orchestrator → chatStream → AssistantMessage footer pill (`provider · X.Xk in / Y.Yk out`).
- [x] node-pty Windows shell selection — probes pwsh → powershell → cmd; ConPTY auto-selected by node-pty on Win10+.

### Phase 7 (LSP for real, R lint, per-message USD)
- [x] Per-message USD on the chat cost pill — mirrors the backend price table client-side, looks up the active provider's selected model, displays alongside tokens
- [x] R lint-on-save via lintr — `scelo:fs:lintR` shells to bundled R; EditorPanel reuses Monaco-marker plumbing. Bundle now `install.packages("lintr")`
- [x] Persistent Pyright LSP (diagnostics + completion + hover) — `pyright-langserver --stdio` spawned on first .py open; minimal in-house LSP client (≈150 LOC) over scelo:lsp:{start,send,message,stop} IPC. No monaco-languageclient dependency. Lifecycle hooked to app `before-quit` so no orphan processes

### Phase 8 (R LSP, definitions, IBTrACS opt-in)
- [x] R LSP via `languageserver` package — LSP IPC parameterised by language id (`python` | `r`); EditorPanel registers Monaco providers for both. Bundle installs `languageserver`.
- [x] LSP go-to-definition + signature help — added to `lspClient` + Monaco `registerDefinitionProvider` / `registerSignatureHelpProvider` for both languages.
- [x] IBTrACS downloader scaffolding — `scelo:climada:ibtracs:{status,download,cancel,progress}` IPC + `/settings/data` UI panel (progress bar + cancel). climada bridge auto-uses the file when present, falls back to synthetic when absent.

### Phase 9 (multi-workspace, LSP rename/format, dataset registry, PTY smoke)
- [x] Multi-workspace registry — `workspaces.json` keeps every dir the user has opened (id + path + last-active); File menu adds **Switch workspace…** (⌘/Ctrl-Shift-O) → `/settings/workspaces` for the picker. Per-workspace `workspace-state-<id>.json` so each one preserves its open tabs.
- [x] LSP rename (F2) + whole-document formatting registered for both Python and R via the existing in-house lsp client; servers receive the corresponding capabilities on initialize.
- [x] Cross-OS PTY smoke (`apps/scelo-ide/scripts/smoke-pty.ts`) — node `--experimental-strip-types`, exercises spawn + echo + resize via the bundled `node-pty`. Wired into `release-scelo-ide.yml` so every matrix leg fails loudly if the rebuilt native module is broken on its platform.
- [x] Generalized dataset-download registry — `scelo:data:{list,status,download,cancel,progress}` IPC; main owns a `DATASETS` registry (IBTrACS, SADHS 2016, OpenFEMA NFIP). `/settings/data` renders cards from `data.list()`; climada bridge reads via `data.status("ibtracs")`.

### Phase 10 (code-actions, workspace-scoped LSP, ChEMBL with checksum)
- [x] LSP code-actions registered for Python + R — Monaco's lightbulb menu now surfaces Pyright quick-fixes (add import, fix typing, organise imports) and any languageserver R fixes. Marker context is forwarded so the action targets the actual diagnostic at the cursor.
- [x] Workspace-scoped LSP root — `LspClient.setRoot(path)` initialise-time `rootUri` + `workspaceFolders`; `Workspace.tsx` calls it for both `python` and `r` clients when the active workspace changes; switching workspaces cleanly tears down + restarts the underlying server (LSP `shutdown` + `exit` then `scelo:lsp:stop`).
- [x] Streaming SHA-256 + ChEMBL registry entry — download handler updates a `crypto.createHash("sha256")` per chunk; before atomic rename we compare against `expectedSha256` on the DatasetSpec and refuse to publish a mismatched file. ChEMBL 34 SQLite (~7 GB compressed) added to DATASETS with a placeholder digest.

### Phase 11 (resumable downloads, executeCommand, NFIP bridge, sha pin)
- [x] Resumable downloads — handler probes for an existing `.partial`, sends `Range: bytes=N-`, falls back to a clean restart when the server doesn't honour the range. The streaming sha256 rehashes the existing on-disk bytes first so the end-of-stream verify covers the whole file.
- [x] LSP `workspace/executeCommand` — code-action `command` fields now round-trip through a Monaco editor.registerCommand wrapper that sends `workspace/executeCommand` back to the server (Pyright's `pyright.organizeimports`, etc.).
- [x] NFIP-claims bridge — `bridges/nfipPython.ts` streams the FimaNfipClaims CSV through pandas (chunked, 200k rows at a time), returns per-state/per-decade loss summaries. New `nfip-flood-losses` model in the climate family; falls back to "download via /settings/data" hint when the file isn't on disk.
- [x] ChEMBL sha-pin helper — `scripts/pin-chembl-sha.sh` fetches the upstream `checksums.txt`, validates 64-char sha256 for `chembl_34_sqlite.tar.gz`, surgically patches `main.ts` DATASETS entry. Build pipeline can run this as a ship gate.

### Phase 12 (WHO life tables, ChEMBL bridge, applyEdit, resume UI)
- [x] Replaced registration-only SADHS PDF with WHO Global Health Observatory life-table CSV (~3 MB, freely available, no registration). New `who-life-table` mortality model returns country-specific e0 + e65 + qx-by-age.
- [x] ChEMBL drug-lookup bridge — opens the on-demand-extracted SQLite read-only, queries molecule_dictionary + drug_indication for a named drug, returns canonical name + ChEMBL id + max-phase + indications + approval year. First swarm-simulator consumer of the ChEMBL bulk download.
- [x] LSP `workspace/applyEdit` handling — minimal client now distinguishes responses / server-requests / notifications; `onRequest(method, handler)` lets EditorPanel apply the WorkspaceEdit to Monaco models and reply `{applied: true}`. Completes the code-action server-side commands.
- [x] Resume UI affordance — `scelo:data:status` now returns `partialBytes`; SettingsData card shows "resumable · N MB on disk" and the button reads "resume (N MB done)" instead of "download".

### Phase 13 (WHO qx, ChEMBL purge, LSP references, find-in-files)
- [x] WHO bridge fixed — now targets the qx indicator (LIFE_0000000031), filters by `IndicatorCode` + `SpatialDim` + `Dim1` (sex) explicitly, parses age-band codes (`AGELT1`, `AGE1-4`, `AGE85PLUS`) into integer lower-bound + band-width, derives e0 / e65 via a proper lx-from-qx survival walk.
- [x] Dataset extraction moved to `userData/extracted/<id>/`; new `scelo:data:purge` IPC deletes the registered archive + `.partial` + extracted artefacts and reports `removedBytes`. Settings cards gain Purge / Discard partial buttons.
- [x] LSP go-to-references — Shift-F12 lists every occurrence. Registered Monaco `ReferenceProvider` for python + r; LSP capability `references` declared on initialize.
- [x] Find-in-files via ripgrep — new sidebar tab in `/workspace` shells out to `rg --json`, streams matches into a clickable list. Clicking opens the file + jumps to the line via a new `jumpToLine` prop on `EditorPanel`. Surfaces a clean "ripgrep not on PATH" notice when missing.

### Phase 14 (bundled rg, find-in-files polish, migration)
- [x] Bundled ripgrep via `@vscode/ripgrep` (per-platform prebuilt rg, ~2 MB net). `scelo:tools:ripgrepPath` IPC returns the bundled path; SearchPanel uses it when present, falls back to system `rg` otherwise. AppImage grew to 117 MB.
- [x] Find-in-files match-range highlights (ripgrep `submatches[]` rendered as bold spans) + include/exclude glob text inputs that map to `--glob` flags.
- [x] One-shot extracted-dir migration — on first launch after upgrade, any legacy `<archive>.tar.gz.extracted` sibling is renamed into `userData/extracted/<id>/`. Marker file `userData/.extracted-migration-v1` ensures the migration runs at most once.
- [~] LSP call-hierarchy — the client capability is declared so Pyright + R languageserver respond, but Monaco 0.55's public typings don't expose `registerCallHierarchyProvider` (only the internal API does). Deferred to Phase 15 (upgrade Monaco or type-shim the internal API).

### Phase 15 (inlay hints, quick-open, search history, multi-window)
- [x] LSP inlay hints — Pyright surfaces inferred types + parameter names inline in the editor. Monaco DOES expose `registerInlayHintsProvider` publicly, so we wired it through. Call-hierarchy remains parked: confirmed even latest Monaco doesn't expose `registerCallHierarchyProvider` in its public API (it's contribution-internal). Documented as deferred-indefinitely; users can use Shift-F12 references + `workspace/symbol` search instead.
- [x] Find-in-files search history — last 20 distinct queries kept per workspace in localStorage, surfaced as a clickable chip row under the search input.
- [x] Quick-open file picker (Cmd/Ctrl-P) — modal palette enumerates workspace files via `rg --files` (bundled), narrows by a 1-KB fuzzy matcher (basename + word-boundary + contiguous-match bonuses), opens the chosen file in a new tab. Mirrors VS Code's quick-open without bundling `fd`/`fzf`.
- [x] Multi-window safety — File menu handlers now use `focusedWindow` from the click context instead of `getAllWindows()[0]` (which always targeted the first window). Added a "New Window" entry (Cmd/Ctrl-N) that calls `createMainWindow`. LSP / exec / data IPC singletons multiplex across `webContents` already, so a second window just joins the broadcast.

### Phase 16 (per-window workspaces, symbol palette, first-run splash)
- [x] Per-window active workspace — main now keeps a `webContents.id → workspaceId` `Map`; `_activeWorkspace(event)` / `_resolveInWorkspace(rel, event)` read the per-window override before falling back to the global most-recently-active. Workspace.tsx pins the window on mount via the new `scelo:workspace:setForWindow` IPC. Closing the window drops the entry. Two windows can now view two different repos with independent fs / lsp / tab-state.
- [x] `workspace/symbol` palette (Cmd/Ctrl-T) — new SymbolPalette component queries Pyright + R languageserver in parallel via `workspace/symbol`, debounced 150 ms, renders with kind-icons + container hint. Enter opens the file at the symbol's range using the existing `pendingJump` flow.
- [x] First-run workspace splash — when the user lands on `/workspace` with no active workspace, a centred `fixed inset-0` modal greets them with a "choose folder" CTA instead of the silent empty-pane state. Auto-dismisses once `workspace.pick` returns a path.
- [skip] Bundled `fd` — deferred indefinitely. The IDE itself has Cmd+P now (rg-based fuzzy file enumeration) and the terminal already gets bundled `rg` on PATH via the runtime augmentation. Adding `fd` would mean per-platform binary downloading without a clear additional value.

### Phase 17 (outline, smarter routing, Window menu)
- [x] Outline sidebar tab — third sidebar slot calls `textDocument/documentSymbol` for the active file and renders a clickable hierarchical tree (classes → methods, modules → functions). Click jumps via the existing pendingJump flow. Handles both DocumentSymbol[] (hierarchical, what Pyright + languageserver actually send) and the SymbolInformation[] fallback.
- [x] Smarter open-on-first-launch — truly-first launch still lands on `/runtime-check`; subsequent launches go straight to `/workspace` whether or not a workspace is registered (the first-run splash handles the empty case). Skips the redundant `/dashboards/scelo` waystation.
- [x] Menu accelerator polish — added macOS `windowMenu` role (minimise / zoom / front / tickable window list) and a Linux/Windows custom Window menu with minimise / zoom / Close Window. New Cmd/Ctrl-W closes the focused window. File menu handlers already use `focusedWindow`; verified there's no cross-window leak.

### Phase 18 (caret tracking, command palette, durable dirty state)
- [x] Outline caret tracking + breadcrumb — EditorPanel emits cursor-position changes; Workspace.tsx pipes them through OutlinePanel (highlights deepest containing symbol) and back into EditorPanel as a breadcrumb (`Class › method`) alongside the file path in the editor's header strip.
- [x] Quick-Action palette (Cmd/Ctrl-Shift-P) — new `CommandPalette` component with the same fuzzy matcher as QuickOpen; Workspace.tsx assembles the IDE command list (Open Workspace, Switch Workspace, AI Settings, Data Settings, sidebar toggles, navigate Scelo, runtime check, format-document). Each command is a stable id + label + thunk so new entries slot in trivially.
- [x] Per-tab dirty state survives reload — new `scelo:fs:{saveUnsaved,loadUnsaved,clearUnsaved}` IPC writes drafts under `userData/unsaved/<workspaceId>/<sha1(rel)>.json` with a `baseSha1` of the on-disk file at draft-save time. Reload restores the dirty buffer; a disk change between draft + reload drops the draft so we never silently clobber an external edit. EditorPanel debounce-persists (500 ms) while dirty + clears on save.

### Phase 19 (per-language palette, toast, outline auto-scroll)
- [x] Per-language palette filter — Workspace.tsx now eagerly fetches `textDocument/documentSymbol` for the active file (Python + R) and stores the outline at the route level. Cmd+Shift+P prepends `Symbol: <name> · file:line` entries for every node so jumping to a symbol works even when the Outline sidebar tab isn't selected. OutlinePanel accepts an `externalOutline` prop and skips its own LSP request when the parent owns the tree.
- [x] Draft-discarded toast — EditorPanel surfaces a 6 s toast in the top-right of the editor when `fs.loadUnsaved` returned `{ dropped: "disk content changed…" }`, so the user knows their unsaved buffer was deliberately discarded instead of silently losing work.
- [x] Outline auto-scroll — OutlinePanel attaches a ref to the active button and `scrollIntoView({ block: "nearest" })`s on caret change. `nearest` avoids jitter when the symbol is already visible; smooth scrolling otherwise.

### Phase 20 (palette previews, periodic outline, toast queue)
- [x] Palette symbol previews — EditorPanel emits `onBufferChange`; Workspace.tsx caches the active buffer and slices the line at each symbol's start position for the Cmd+Shift+P palette `detail` field (trimmed to 80 chars + `· file:line` suffix). Clamps gracefully when the buffer is shorter than the LSP thinks.
- [x] Periodic LSP `documentSymbol` refresh — Workspace.tsx debounces a re-fetch 750 ms after the last edit so the breadcrumb + outline + palette track the in-progress buffer, not just the on-disk version.
- [x] Toast queue — EditorPanel's single `toast` state became a small `ToastEntry[]` stack (max 3, each auto-dismisses at 6 s independently). Renders top-right with per-toast dismiss buttons.

### Phase 21 (useWorkspaceShell, memoised documentSymbol, toast variants)
- [x] Extracted `apps/web/src/lib/useWorkspaceShell.ts` — owns every piece of /workspace state (tabs, sidebar, caret, outline, buffer, palettes, pendingJump) + every effect (state hydration, periodic refresh, LSP root, keyboard shortcuts) + the palette command registry. `Workspace.tsx` dropped from 593 → 251 lines and is now JSX + layout only.
- [x] Memoised `textDocument/documentSymbol` by buffer hash — the periodic refresh effect now skips the LSP round-trip when `(path, lang, buffer)` hashes to the same value as the previous fetch. djb2 32-bit hash; resets on file switch. Cursor-only events no longer trigger LSP calls.
- [x] Toast variants — `info` / `success` / `error` colour-coded borders + tinted bgs (info = dissent gold, success = consensus green, error = adversarial red). `role="alert"` on error so screen readers escalate appropriately. Draft-discarded notice is now explicitly `"info"`.

### Phase 22 (sidebar persistence, toast bus, hook namespaces, tests)
- [x] Persist sidebar tab + width — `WorkspaceUIState` gains optional `sidebarTab` + `sidebarWidth`; hook hydrates + persists them alongside tabs. Width clamped to `[180, 600]`. New SidebarResizer drag handle wires `setSidebarWidth`. Hydration vs persistence race fixed via a `hydratedRef` guard so the persist effect doesn't overwrite the disk state on mount with the initial defaults.
- [x] Global toast event bus — `apps/web/src/lib/toastBus.ts` (`subscribeToasts` + `emitToast`); workspace-level `ToastTray` is the single render site. EditorPanel's local toast state removed in favour of `emitToast(...)`. Non-editor surfaces can now emit notices too (e.g. a future fetch utility) without prop-drilling a setter.
- [x] Sub-grouped `useWorkspaceShell` return — `shell.tabs.*`, `shell.workspace.*`, `shell.editor.*`, `shell.palettes.*`. Workspace.tsx call sites are now `const { tabs, workspace, editor, palettes } = shell` + read namespaced fields, e.g. `tabs.openFile`, `palettes.commands`.
- [x] Test harness — `apps/web/src/lib/useWorkspaceShell.test.ts` runs under bun:test with happy-dom + @testing-library/react. Covers tab hydration / open / close, sidebar persistence, width clamping, palette command registry (static + dynamic symbol entries). 6/6 pass. Caught + fixed the hydration race in the process.

### Phase 23 (shared Palette, Settings toasts, state versioning)
- [x] Shared `<Palette>` component — single modal shell (backdrop, focused input, arrow nav, Esc/Enter, render cap) used by QuickOpen / SymbolPalette / CommandPalette. Each caller owns its data source + ranking; the shell handles keyboard + selection + close. 7 regression tests via @testing-library/react + happy-dom under bun:test.
- [x] Settings toasts — SettingsAI / SettingsData / SettingsWorkspaces now `emitToast(...)` on save success, save failure, test-connection failure, download complete, download error, dataset purge, workspace switch failure, workspace remove. Errors that were previously silent now surface in the global toast tray.
- [x] WorkspaceUIState versioning — schema now carries `version: 1`. `_migrateWorkspaceStateToV1` transparently upgrades legacy (v0, no `version` field) state files on read; writes always normalise to v1. Documented as the pattern for future breaking shape changes.

### Phase 24 (user-event, richer toasts, migrations registry)
- [x] P24-1 Adopted `@testing-library/user-event` for input tests — replaces the flaky `fireEvent.change` workaround on controlled inputs. Palette / Settings tests now type with `user.type(input, "...")` so each keystroke fires through the real event path, removing the need for `initialQuery` test hooks.
- [x] P24-2 Richer download toasts — SettingsData now records a per-id `startTimesRef` on download start; on `p.done` the toast reads "X downloaded : Y bytes in Z." (with `formatElapsed` rendering ms / s / m s).
- [x] P24-3 Unified migrations under `apps/scelo-ide/src/migrations/`: `markers.ts` owns the shared one-shot marker convention (`runOnce(ctx, id, fn)` writes `userData/.migration-<id>-done`); `extractedDir.ts` houses the Phase-12→13 ChEMBL extraction-dir move; `workspaceState.ts` houses the v0→v1 WorkspaceUIState data migration. `index.ts` exposes `runStartupMigrations(ctx, opts)` which `app.whenReady()` calls; new schema reshapes drop a single file under the directory rather than landing inline in main.ts.

### Phase 25 (status bar, welcome view, sample workspaces)
- [x] P25-1 Status bar pinned to the bottom of `/workspace`. Cells: workspace path (click to copy), `Ln {caret}/{total}`, language mode, Pyright + R-LSP health dots (driven by the new `lspBus`), and the active AI provider summary. The status bar is a pure subscriber: it consumes existing hook state plus the bus, and the LspClient now emits `starting` / `live` / `error` / `off` pings so the dot stays honest without polling.
- [x] P25-2 New `/welcome` route. Replaces the legacy `FirstRunSplash` modal; mounted automatically when the IDE launches with no workspace, and reachable any time via the command palette (`Help: Open Welcome Page`). Surfaces: brand mark, primary actions (Open Folder / Switch / Configure AI / Download dataset), recent workspaces (sorted by lastActive), and the three sample scaffold tiles.
- [x] P25-3 Sample workspace scaffolds under `apps/scelo-ide/templates/`. Three runnable templates: `life-pricing` (WHO life tables → qx → level premium across Python + R), `climate-risk` (IBTrACS → Climada → ggplot choropleth), `scelo-brain` (soft → tools → hard pipeline with the contract spelled out). New `scelo:workspace:create-from-template` IPC + `WorkspaceBridge.createFromTemplate` opens a folder picker, copies the tree, runs `git init --quiet` (best-effort), pins the window, and lands the user inside the new workspace. Allow-listed in main; `electron-builder.yml` bundles `templates/**/*` into the asar (plain text only, no binaries).

### Phase 26 (source control, problems panel, run current file)
- [x] P26-1 Source Control sidebar tab + branch cell + tree decorations. New `scelo:git:*` IPC (status v2, stage, unstage, commit) spawns the system `git` from the workspace cwd, parses porcelain v2 + branch info, and falls back gracefully when git isn't installed or the workspace isn't a repo. `gitBus` owns the cached snapshot with a 30 s tick + refresh-on-save; StatusBar shows branch + ahead/behind + dirty count; FileBrowser overlays a single-char gutter on changed files; SourceControlPanel groups staged vs unstaged with a commit-message box (Cmd-Enter commits).
- [x] P26-2 Problems sidebar tab. New `diagnosticsBus` mirrors every `textDocument/publishDiagnostics` notification the LSPs publish so the panel sees every file the editor has touched, not just the active tab. Grouped by file, severity dot per row, click jumps to the line. Cleared on workspace switch so old workspaces don't bleed into new ones.
- [x] P26-3 Run Current File. New `terminalBus` pub/sub lets the palette / shortcuts queue commands into the long-lived terminal shell. F5 (and the "Run: Current File" palette command) composes `python file.py` or `Rscript file.R` against the active tab and pushes it through; unsupported extensions toast rather than fail silently. Bundled python / R are already on PATH so the shell sees them without further wiring.

### Phase 27 (data-aware viewers)
- [x] P27-1 CSV / TSV table preview. New in-house RFC-4180 parser (`lib/csvParse.ts`, 7 unit tests) and `viewers/CsvTable.tsx` render the first 500 rows as a virtualised table with row numbers, sticky header, and per-cell truncation. Default view for `.csv` / `.tsv`; the breadcrumb toggle drops back to Monaco for editing.
- [x] P27-2 Markdown preview pane. New `viewers/MarkdownPreview.tsx` reuses the existing `MarkdownBlock` (react-markdown + remark-gfm + remark-math + rehype-katex + highlight.js) so code fences, math, GFM tables, task lists, and Scelo's own fenced-math blocks all render identically to the chat surface. Cmd-Shift-V toggles a side-by-side preview alongside Monaco; palette has "View: Toggle Preview / Source".
- [x] P27-3 Jupyter notebook viewer. New `viewers/IpynbView.tsx` parses the `.ipynb` JSON and renders markdown cells via MarkdownBlock, code cells as highlighted source with stream / error outputs printed below. Image + rich HTML outputs are intentionally shown as `[image output omitted]` placeholders for this phase (rich rendering deferred). The "Source" toggle drops back to the raw JSON buffer for hand-edits.
- Architectural note: all three viewers register through `components/workspace/viewers/registry.tsx`. Two kinds: `alt` (CSV / .ipynb) replaces Monaco when on; `preview` (Markdown) renders side-by-side. EditorPanel owns the buffer + save state for both modes, so toggling between source and rich view never loses unsaved edits. New `lib/editorViewerBus.ts` lets the keyboard shortcut + palette flip the active editor's viewer without prop-drilling.

### Phase 28 (AI in the workspace)
- [x] P28-1 Workspace AI side panel. New right-side resizable pane (`components/workspace/AIPanel.tsx`) reuses `useChatStream` + `AssistantMessage` + `UserMessage` for full parity with `/chat`. Each workspace gets its own persisted conversation keyed by `ws:<hash>` so chat history is scoped to the project, not bleeding across workspaces. Cmd-Shift-A toggles, palette command mirrors. Width + visibility persisted in WorkspaceUIState (non-breaking optional fields; no schema bump). `conversationStore.upsert()` lets the renderer materialise a conversation with a deterministic id.
- [x] P28-2 Send selection to AI. New `editorSelectionBus` lets EditorPanel publish the current Monaco selection on every `onDidChangeCursorSelection`; Cmd-L (and the "AI: Send Selection to AI" palette command) read it, compose `From <path>:\n\`\`\`<lang>\n<text>\n\`\`\`\n\n`, and stage it in the AI panel input via `aiPanelBus.emitAiPrompt({ autoSend: false })` (also opens the panel when hidden). No selection → friendly toast instead of mysterious no-op.
- [x] P28-3 Apply AI suggestion to file. AssistantMessage gains an `ApplyAffordance` sibling that scans the rendered message's `parts` for the LAST fenced code block whose language matches the active editor (with Python / R / shell aliases). One-click "▶ apply latest \<lang\> block" routes through `applyToEditorBus`; EditorPanel performs a single Monaco `executeEdits` over the current selection (or inserts at the caret when nothing is selected). Save remains explicit; the apply only mutates the buffer.
- Architectural note: this phase deliberately reuses the existing chat infrastructure (`chatStream.ts`, `streamOrchestrator`, `AssistantMessage`, `MarkdownBlock`) so the AI panel inherits every improvement to the main `/chat` surface for free — code fences, math rendering, tool-call envelopes, regulatory citations, regenerate / edit / branch — without a parallel implementation. Five small buses (`aiPanelBus`, `applyToEditorBus`, `editorSelectionBus`, plus the previously landed `editorViewerBus`, `gitBus`, `lspBus`, `terminalBus`, `toastBus`, `diagnosticsBus`) keep the workspace shell composed instead of prop-drilled.

### Phase 29 (diff viewer, find + replace, snippets)
- [x] P29-1 Inline git diff for the active file. New `scelo:git:show` IPC fetches `git show HEAD:<path>`; EditorPanel adds a third toggle ("Diff") that surfaces only when the active file has worktree changes (read from the gitBus snapshot, so it appears / disappears live with save + git activity). Toggle ON mounts Monaco's `DiffEditor` side-by-side, HEAD on the left and the live buffer on the right. HEAD content cached per (path, branch sha) so flipping doesn't re-spawn git.
- [x] P29-2 Workspace find + replace. SearchPanel grows a third input row (replacement + "replace…" button) under the existing search + glob inputs. Confirm modal summarises N matches across M files, then a new `scelo:fs:replace` IPC walks each file's edits in (line desc, offset desc) order so out-of-order offsets never shift earlier replacements out from under later ones. Success toast reports counts; matches are cleared post-write (offsets are stale) and the gitBus refreshes so the FileBrowser gutter + StatusBar dirty count update immediately.
- [x] P29-3 Built-in actuarial snippets. New `lib/snippets.ts` defines a curated set per language: Python — `scelo-mortality-lifelib`, `scelo-chainladder-triangle`, `scelo-climada-pipeline`. R — `scelo-actuar-mixture`, `scelo-ggplot-survival`. Registered through Monaco's `CompletionItemKind.Snippet` provider so they merge with live Pyright / R-LSP completions and only appear when the user actively types one of the `scelo-…` prefixes. Tab cycles through `${N:default}` placeholders.

### Phase 30 (first-run AI prompt, ONBOARDING, repo README sync)
- [x] P30-1 First-run AI provider prompt. New `lib/firstRunAi.ts` gates a one-time modal (`components/FirstRunAIPrompt.tsx`) that only fires when (a) no provider has been picked AND (b) a short-timeout probe of `http://localhost:11434/api/tags` confirms Ollama isn't already running. Choice: download Ollama (opens in the system browser via the existing setWindowOpenHandler), configure a cloud provider (navigates to /settings/ai), or skip. Marker `ia.firstRun.aiPrompt.shown.v1` in localStorage so it never reappears. Mounted from App.tsx so the gate runs once regardless of which route the user lands on.
- [x] P30-2 ONBOARDING.md at repo root. Orients new contributors (human or agent) to the apps/scelo-ide architecture: the apps/web ↔ apps/scelo-ide contract (sceloIDE.ts as the typed boundary), useWorkspaceShell namespaces, the nine-bus pattern (`toastBus`, `lspBus`, `gitBus`, `diagnosticsBus`, `terminalBus`, `editorViewerBus`, `editorSelectionBus`, `aiPanelBus`, `applyToEditorBus`), the migrations registry, the templates tree, dev / build / test commands, and the un-linted house rules (no em-dashes, atomic writes, soft → tools → hard one-way pipeline).
- [x] P30-3 Repo-level README sync. Added apps/scelo-ide to the Project Layout block and a new "Scelo IDE" section between Project Layout and What's Next, sized to match the existing section voice. Reframed the IDE under the org's "public methodology, private mandate" stance: source here under IA License, binaries part of the engagement. Deliberately did NOT push to website_v2 / GitHub org profile / HuggingFace org card — those surfaces position around private engagement ("no public binaries") and a download CTA would contradict the lab's stated framing. The org-profile description's existing "code that travels with our research" line already implicitly covers the IDE source.
### Phase 31 (actuarial breadth)
- [x] P31-1 Reserving sample workspace. New `templates/reserving/` scaffolds the org's headline use case: R `ChainLadder::MackChainLadder` on the RAA triangle + a `chainladder.py` cross-engine verifier that checks the pinned IBNR regression (≈ 52,135) and reports the divergence. Includes a Makefile that wires both engines + produces a paste-into-PR markdown report. Registered in `SAMPLE_TEMPLATES` allow-list + `sampleWorkspaces.ts`.
- [x] P31-2 Broader snippet pack. `lib/snippets.ts` grew from 5 to 11 prefixes spanning the org's live specialists. New Python: `scelo-statsmodels-glm` (Poisson freq), `scelo-fairlearn-audit` (TCF Principle 4), `scelo-shap-attribution`. New R: `scelo-chainladder-mack` (Mack + bootstrap), `scelo-stmomo-leecarter` (mortality projection), `scelo-lifecont-puc` (Projected Unit Credit). Each stays small + idiomatic; goal is "starts a sane file" not "writes the analysis."
- [x] P31-3 AI panel auto-context. AIPanel now prepends a fenced "Workspace context" block to every send — the active selection when one exists, otherwise the first 40 lines of the buffer. Block lists the file path + which slice it included so the user can see what the LLM is reading. Header checkbox flips it off per-session for noisy queries.

### Phase 32 (notebook outputs, per-block AI apply, tests panel)
- [x] P32-1 .ipynb image + HTML output rendering. Replaces the previous `[image output omitted]` / `[HTML output omitted]` placeholders with real renders: PNG / JPEG base64 → `<img>`, SVG inline, text/html via a sandboxed `<iframe srcdoc sandbox="">` so embedded scripts can't reach the IDE renderer. Image precedence wins over text/plain when both are present (matches what the user usually wants from a matplotlib cell).
- [x] P32-2 Per-block AI Apply. ApplyAffordance now renders one button per matching fenced block instead of just the last, with a per-block preview (first non-blank line + line count) so the user can disambiguate "apply this attempt" vs "apply the corrected one." Re-uses the existing applyToEditorBus.
- [x] P32-3 Tests sidebar tab. New `scelo:tests:discover` IPC runs `pytest --collect-only -q` for Python and an Rscript probe for testthat (`tests/testthat/test-*.R`), returns a flat list grouped client-side by file. `TestsPanel` shows the tree with "run all" / per-file / per-test buttons; clicking pipes the right `pytest <node>` or `Rscript -e "testthat::test_file(...)"` invocation into the terminal via terminalBus, so output streams to the existing shell rather than a parallel surface.
- [ ] Real signing certs (Apple Developer + Windows EV : paid prereqs) — only thing left between this branch and a signed cross-platform release.
