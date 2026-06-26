# Run the latest Scelo IDE on Windows / macOS

Linux users get a one-click installer (`.AppImage` / `.deb`) from the
[downloads page](https://intelligentactuaries.com/scelo). For the **very
latest** build on **Windows or macOS**, you finish the install on your own
machine in two steps: a small source download, then a one-command "finisher"
that fetches the OS-specific pieces (Electron + a bundled Python + R runtime)
and builds you a native installer.

> Why two steps: the app code is identical on every OS, but the Electron
> runtime and the bundled Python/R differ per platform and install *natively*
> on your machine. This gets you the newest build without waiting on a
> per-platform release.

---

## 1. Get the source (the "partial download")

Either clone it:

```bash
git clone https://github.com/intelligentactuaries/scelo
cd scelo
```

…or download the ZIP from the repo (green **Code → Download ZIP**) and unzip it.

## 2. Finish the install (downloads the rest, builds a native installer)

### macOS

```bash
bash scripts/finish-install.sh
```

When it finishes, your installer is in `apps/scelo-ide/build/`
(`Scelo IDE-0.1.0-arm64.dmg`). Open it and drag Scelo to Applications.

### Windows

Install **[Git for Windows](https://git-scm.com/download/win)** (it includes
Git Bash), then open **Git Bash** in the `scelo` folder and run:

```bash
bash scripts/finish-install.sh
```

Your installer lands in `apps/scelo-ide/build/` (`Scelo IDE-0.1.0-x64.exe`).

### Just run it without building an installer

```bash
bash scripts/finish-install.sh --run
```

---

## What the finisher does

1. Installs **bun** (the package runner) if it's missing.
2. `bun install` — pulls **Electron for your OS** and the native modules.
3. Stages the **Python + R runtime for your OS** (portable CPython + R + the IA
   actuarial package set). The first run is slow — R installs a large package
   set.
4. Builds a **native installer** for your OS (or launches the IDE with `--run`).

First run needs an internet connection. After that the IDE runs fully offline.

## Notes

- **Disk + time:** the bundled runtime is ~1 GB and the first build can take
  10–30 minutes (mostly R packages).
- **Council / simulation features** use the separate swarm server — start it
  with `PORT=3010 bun run dev` in the `swarms` checkout if you want them.
- Everything else (soft data, cleaning, models, hard data, board pack) runs
  offline with no extra setup.
