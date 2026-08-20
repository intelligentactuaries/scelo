# Building the Scelo IDE Windows installer (`.exe`)

Produces the Windows NSIS installer (`Scelo IDE-<version>-x64.exe`) for the
**same version as the current Linux release**, and publishes it onto that same
release. Must be run **on a real Windows machine** (Windows 10/11, x64).

Nothing in this document names a version. Step 0 resolves it from the releases
API, because Windows and Linux have drifted apart before (Windows sat on 0.1.2
while Linux shipped 0.1.6) and a hard-coded version here is how that goes
unnoticed.

## Why this can't be done on the Linux host

The app cross-compiles fine, but electron-builder finishes an NSIS installer by
*running the (32-bit) installer under Wine to generate the uninstaller*, which
needs **32-bit Wine (`wine32:i386`)**. The Linux host has only 64-bit Wine, so
the step fails. Building natively on Windows avoids Wine entirely.

## What "the same version" means

- **App code is identical**: build from the same git tag. The renderer and
  main-process bundles do not depend on the build OS.
- **The bundled Python/R runtime is OS-specific by design**: `resources/runtime`
  is git-ignored and staged per-platform by `scripts/bundle-runtimes.sh`. The
  Linux build bundles Linux CPython/R, the Windows build bundles **Windows**
  CPython/R. Versions are pinned (CPython 3.11.10, R 4.4.2), so this is the
  correct Windows equivalent, not a difference in the app.
- **The swarm is also staged per-platform** (see step 4). `bundle-swarm.sh`
  cross-compiles the swarm server to `swarm-server.exe` for a Windows target.

The version comes from `apps/scelo-ide/package.json` -> `version`, which the tag
already carries. **Do not change it here**; bumping the version is part of
cutting a release, not part of building for a second platform.

---

## Prerequisites (install once)

1. **Git for Windows** — <https://git-scm.com/download/win> (installs **Git
   Bash**, which steps 3 and 4 both require).
2. **Bun for Windows** >= 1.1 — <https://bun.sh> (PowerShell: `irm bun.sh/install.ps1 | iex`).
3. **GitHub CLI** — <https://cli.github.com>, authenticated (`gh auth login`),
   for step 7. A browser upload works as a fallback.
4. **Internet access** — the build downloads node deps, Electron, portable
   CPython and the R installer.
5. **~8 GB free disk** — the staged runtime is ~1.5 GB and the output is ~1 GB.
6. **A compiler is usually NOT needed.** `@homebridge/node-pty-prebuilt-multiarch`
   and `@vscode/ripgrep` ship Windows prebuilts. Only if the native rebuild step
   errors, install **Visual Studio 2022 Build Tools** with the "Desktop
   development with C++" workload, then retry.
7. **No Wine, no WSL.** This is a native Windows build.

---

## Steps

### 0. Resolve which version to build

Read <https://api.github.com/repos/intelligentactuaries/scelo/releases> and take
the newest **published** (not draft, not pre-release) release carrying a `.deb`
or `.AppImage` asset. Its `tag_name` (e.g. `scelo-ide-v0.1.6`) is what you
build. **Do not download the Linux artifacts**: a Windows installer is built
from the same source, not from the Linux binary.

### 1. Get that exact code

```powershell
git clone https://github.com/intelligentactuaries/scelo
cd scelo
git checkout <TAG>          # from step 0
git rev-parse HEAD          # record; should match the Linux build's commit
```

Confirm `apps/scelo-ide/package.json` `version` matches the tag.

### 2. Install JS dependencies (repo root)

```powershell
bun install
```

### 3. Stage the Windows Python + R runtime  — **run in Git Bash**

```bash
cd apps/scelo-ide
TARGET_OS=win bun run bundle:runtime
```

Downloads portable **CPython 3.11.10** (windows-msvc) and **R 4.4.2** (win) and
installs the IA actuarial stack into `resources/runtime/`. Idempotent
(re-running skips already-staged, checksum-matched components). Verify:

```bash
ls resources/runtime/python/python.exe
ls resources/runtime/r/bin/x64/R.exe   # may be r/bin/R.exe depending on layout
cat resources/runtime/manifest.json
```

Skipping this step produces an installer with a broken runtime, and nothing
fails loudly until the app is running.

### 4. Build the installer — **also in Git Bash, not PowerShell**

```bash
cd apps/scelo-ide
bun run dist:win
```

`dist:win` runs `bun run build` then `electron-builder --win nsis`.

> **Why Git Bash.** Since 0.1.6, `build` ends with `bundle:swarm`, which is
> `bash scripts/bundle-swarm.sh`. From PowerShell that fails with
> `bash: command not found` unless `C:\Program Files\Git\bin` happens to be on
> PATH. Git Bash also gives `bundle-swarm.sh` the `MINGW*` uname it needs to
> select the `bun-windows-x64` target and name the binary `swarm-server.exe`.
>
> If electron-builder itself misbehaves under Git Bash, split the two halves:
>
> ```
> Git Bash:    bun run build
> PowerShell:  cd apps\scelo-ide ; bunx electron-builder --win nsis
> ```

Output lands in `apps/scelo-ide/build/`:

- **`Scelo IDE-<version>-x64.exe`** — the NSIS installer (the deliverable)
- `win-unpacked/` — the unpacked app
- `*.blockmap` / `latest.yml` — auto-update metadata (see step 7 before
  publishing `latest.yml`)

*(Optional)* a portable zip: `bunx electron-builder --win zip`.

---

## 5. Verify the build

1. `apps/scelo-ide/build/Scelo IDE-<version>-x64.exe` exists, roughly 1 GB
   (0.1.2 was 937 MB before the swarm was bundled; the swarm adds ~100 MB).
2. **The swarm was bundled** (this is what makes it a >= 0.1.6 build):
   `build\win-unpacked\resources\swarm\swarm-server.exe` exists, and
   `resources\swarm\ui\` is populated.
3. Run the installer, let it install, and launch Scelo:
   - the **Welcome** screen loads;
   - the header **swarm** LED goes ● live on its own, with no second terminal
     and no `bun run dev:swarm`;
   - **Soft Data** loads a sample table and the grid scrolls.
4. Skim the release notes for the tag you built and spot-check anything called
   out there. (Deliberately not enumerated here: a per-version checklist in this
   file goes stale the moment the next version ships.)

## 6. Rename to the release convention

```powershell
cd apps\scelo-ide\build
copy "Scelo IDE-<version>-x64.exe" "Scelo-IDE-<version>-x64.exe"
```

electron-builder writes a **space**; GitHub converts it to a dot on upload,
which is exactly how the stale `Scelo.IDE-0.1.2-x64.exe` asset got its name.
Every Linux asset since 0.1.3 uses the hyphenated form, so match it. Leave the
space-named original in place.

## 7. Publish onto the existing release

```powershell
gh release upload <TAG> "Scelo-IDE-<version>-x64.exe" --repo intelligentactuaries/scelo
```

**Do not create a new tag or release.** Windows joins the release Linux already
shipped from; the website resolves each platform independently and expects to
find them together.

> **Upload only the `.exe`.** Do **not** upload `latest.yml`. `electron-updater`
> is wired into `src/main.ts` and `electron-builder.yml` publishes to this repo,
> so shipping that file switches on Windows auto-update for the first time.
> That is a deliberate product decision, not a side effect of a build. The
> `.blockmap` is harmless but pointless without it.

## 8. Prove it works for a signed-out visitor

```powershell
curl.exe -I -L "https://github.com/intelligentactuaries/scelo/releases/download/<TAG>/Scelo-IDE-<version>-x64.exe"
```

Expect `200` and `content-disposition: attachment`. **A 404 here means the
download is broken for everyone who is not you**: check that
`intelligentactuaries/scelo` is still public, because a signed-in browser will
happily download from a private repo and hide the problem. See the
`scelo-downloads` skill in the website repo.

Nothing needs deploying afterwards. The site re-resolves installers live from
the releases API in the visitor's browser, so the new Windows build appears
within minutes; the committed fallback table refreshes on the next daily
Action or deploy.

---

## Notes & troubleshooting

- **Unsigned installer**: code-signing isn't configured, so SmartScreen warns on
  first run (**More info -> Run anyway**). To sign, add a code cert and
  `win.signtoolOptions` in `electron-builder.yml`.
- **`bash: command not found`** in step 3 or 4: you are in PowerShell. Use Git
  Bash.
- **Native rebuild fails** (`@electron/rebuild` / node-gyp): install the VS 2022
  C++ Build Tools, re-run `bun run dist:win`.
- **R or Python download fails**: re-run step 3, it is idempotent; check the URLs
  in `scripts/bundle-runtimes.sh` are reachable.
- **Empty or broken runtime in the app**: step 3 was skipped, or was run for the
  wrong `TARGET_OS`.
- **Swarm LED never lights** in the installed app: check
  `resources\swarm\swarm-server.exe` shipped (step 5.2), then the log at
  `%APPDATA%\Scelo IDE\logs\swarm.log`.

---

## One-shot prompt for an AI coding agent on Windows

> You are on a Windows 10/11 x64 machine. Build and publish the Scelo IDE
> Windows installer, matching the current Linux release. Follow
> `apps/scelo-ide/BUILD-WINDOWS.md` in the repo; the summary is:
>
> 1. Resolve the newest published Linux release tag from
>    `https://api.github.com/repos/intelligentactuaries/scelo/releases`. Do not
>    download the Linux artifacts. Windows builds from source, not from them.
> 2. `git clone https://github.com/intelligentactuaries/scelo`, `cd scelo`,
>    `git checkout <TAG>`, `bun install`. Do not change `package.json` version.
> 3. **In Git Bash**: `cd apps/scelo-ide && TARGET_OS=win bun run bundle:runtime`.
>    Verify `resources/runtime/python/python.exe` and an `R.exe` exist.
> 4. **In Git Bash** (not PowerShell, the build runs a bash script):
>    `cd apps/scelo-ide && bun run dist:win`.
> 5. Verify `build/Scelo IDE-<version>-x64.exe` (~1 GB) and
>    `build/win-unpacked/resources/swarm/swarm-server.exe` both exist.
> 6. Copy the artifact to the hyphenated name `Scelo-IDE-<version>-x64.exe`.
> 7. `gh release upload <TAG> "Scelo-IDE-<version>-x64.exe" --repo intelligentactuaries/scelo`.
>    Upload only the `.exe`; do NOT upload `latest.yml` (it would switch on
>    Windows auto-update). Do NOT create a new tag or release.
> 8. Verify anonymously with `curl.exe -I -L` on the public download URL: expect
>    200 and `content-disposition: attachment`.
>
> Report the commit SHA, artifact path and size, whether `swarm-server.exe` was
> bundled, and the verified download URL. Do not install Wine or WSL, and do not
> touch the website repo.
