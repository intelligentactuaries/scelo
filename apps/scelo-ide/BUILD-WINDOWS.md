# Building the Scelo IDE Windows installer (`.exe`)

This produces the Windows NSIS installer (`Scelo IDE-<version>-x64.exe`) for the
**exact same version** as the Linux `.deb` / `.AppImage`. It must be run **on a
real Windows machine** (Windows 10/11, x64).

## Why this can't be done on the Linux host

The app itself cross-compiles fine on Linux, but electron-builder finishes an
NSIS installer by *running the (32-bit) installer under Wine to generate the
uninstaller*, which needs **32-bit Wine (`wine32:i386`)**. That host only has
64-bit Wine, so the installer step fails. Building natively on Windows avoids
Wine entirely.

## What "exactly identical version" means

- **App code is identical**: build from the same git commit (the one that
  contains this file). The renderer + main-process bundle are byte-for-byte the
  same regardless of build OS.
- **The bundled Python/R runtime is OS-specific by design**: `resources/runtime`
  is git-ignored and staged per-platform by `scripts/bundle-runtimes.sh`. The
  Linux build bundles Linux CPython/R; the Windows build bundles **Windows**
  CPython/R. Versions are pinned (CPython 3.11.10, R 4.4.2), so this is
  reproducible — it is the correct Windows equivalent, not a difference in the
  app.

The version number comes from `apps/scelo-ide/package.json` → `version`
(currently **0.1.0**). Don't change it unless you intend a new release.

---

## Prerequisites (install once)

1. **Git for Windows** — https://git-scm.com/download/win
   (installs **Git Bash**, which is required for the runtime bundler script).
2. **Bun for Windows** ≥ 1.1 — https://bun.sh (PowerShell: `irm bun.sh/install.ps1 | iex`).
3. **Internet access** — the build downloads node deps, the Electron binary,
   portable CPython, and the R installer.
4. **~8 GB free disk** — the staged runtime is ~1.5 GB and the outputs are
   ~700 MB each.
5. **A compiler is usually NOT needed.** `@homebridge/node-pty-prebuilt-multiarch`
   and `@vscode/ripgrep` ship Windows prebuilt binaries. Only if the native
   rebuild step errors, install **Visual Studio 2022 Build Tools** with the
   "Desktop development with C++" workload, then retry.
6. **No Wine, no WSL** — this is a native Windows build.

---

## Steps

Run these in **PowerShell** (or CMD) except where it says **Git Bash**.

### 1. Get the exact code

```powershell
git clone git@github.com:intelligentactuaries/scelo.git
cd scelo
git checkout feat/claude-code-provider-and-soa-benchmark
# For a guaranteed-identical build, pin the exact commit instead of the branch tip:
#   git checkout <COMMIT_SHA>
# (the SHA of the commit that added this BUILD-WINDOWS.md — see the chat/release notes)
git rev-parse HEAD    # record this; it should match the Linux build's commit
```

### 2. Install JS dependencies (repo root)

```powershell
bun install
```

### 3. Stage the Windows Python + R runtime  — **run in Git Bash**

The runtime is git-ignored and must be staged for Windows. `TARGET_OS=win` is
auto-detected under Git Bash (MINGW), but set it explicitly to be safe:

```bash
cd apps/scelo-ide
TARGET_OS=win bun run bundle:runtime
```

This downloads portable **CPython 3.11.10** (windows-msvc) + **R 4.4.2** (win)
and installs the IA actuarial stack into `resources/runtime/`. It is idempotent
(re-running skips already-staged, checksum-matched components).

Verify it staged:

```bash
ls resources/runtime/python/python.exe
ls resources/runtime/r/bin/x64/R.exe   # path may be r/bin/R.exe depending on the R layout
cat resources/runtime/manifest.json
```

### 4. Build the installer

```powershell
cd apps\scelo-ide
bun run dist:win
```

`dist:win` runs `bun run build` (rebuilds the renderer + main) then
`electron-builder --win nsis`. Output lands in `apps/scelo-ide/build/`:

- **`Scelo IDE-0.1.0-x64.exe`** — the NSIS installer (this is the deliverable)
- `win-unpacked/` — the unpacked app
- `*.blockmap` / `latest.yml` — auto-update metadata

*(Optional)* a portable zip too: `bunx electron-builder --win zip`.

---

## Verify the result

1. `apps/scelo-ide/build/Scelo IDE-0.1.0-x64.exe` exists (~700 MB).
2. Run it → the installer opens (you can choose the install directory) → it
   installs and launches the **Welcome** screen.
3. Confirm this version's changes are present:
   - **Soft Data** → `load sample` → **Workspace demo** → the `◈ workspace`
     toolbar button opens the decision-relevance preview.
   - The **Sample workspaces** list on Welcome has **no "SOA exams" card**
     (removed in this version).
   - Open `/workspace` → the sidebar has a **`facts`** tab (the global-workspace
     panel).
   - **Tools** → add **Workspace bottleneck** (family `workspace`); **Hard Data**
     → a result → **`◈ extract + validate`** renders the workspace card
     (participation ratio, workspace-vs-PCA, swap consistency, selectivity).

---

## Notes & troubleshooting

- **Unsigned installer**: code-signing isn't configured, so Windows SmartScreen
  will warn on first run — click **More info → Run anyway**. To sign, add a code
  cert and `win.signtoolOptions` in `electron-builder.yml`.
- **Native rebuild fails** (`@electron/rebuild` / node-gyp errors): install the
  VS 2022 C++ Build Tools (step 5) and re-run `bun run dist:win`.
- **`bash: command not found`** on step 3: run it from **Git Bash**, not
  PowerShell (the bundler is a bash script).
- **R or Python download fails**: re-run `TARGET_OS=win bun run bundle:runtime`
  (idempotent); check the URLs in `scripts/bundle-runtimes.sh` are reachable.
- **Empty/broken runtime in the app**: you skipped step 3 — `resources/runtime`
  must be staged for `win` *before* `dist:win`.

---

## One-shot prompt for an AI coding agent on Windows

> You are on a Windows 10/11 x64 machine. Build the Scelo IDE Windows installer.
> Prereqs: Git for Windows (Git Bash), Bun ≥ 1.1, internet, ~8 GB free disk.
> Steps:
> 1. `git clone git@github.com:intelligentactuaries/scelo.git`, `cd scelo`,
>    `git checkout feat/claude-code-provider-and-soa-benchmark` (or the exact
>    commit SHA given to you), then `bun install`.
> 2. In **Git Bash**: `cd apps/scelo-ide && TARGET_OS=win bun run bundle:runtime`.
>    Verify `resources/runtime/python/python.exe` and an `R.exe` exist.
> 3. In PowerShell: `cd apps\scelo-ide && bun run dist:win`.
> 4. Confirm `apps/scelo-ide/build/Scelo IDE-0.1.0-x64.exe` was produced, then
>    run it and check the Welcome screen loads and there is no "SOA exams" sample
>    card. Report the artifact path, its size, and the commit SHA you built from.
> Do not change `package.json` `version`. Do not install Wine. If the native
> rebuild step errors, install VS 2022 C++ Build Tools and retry.
