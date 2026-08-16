# Windows & macOS

Two routes: the one-click installer, or — for the very latest build — finish
the install on your own machine.

## One-click installer

Download the installer for your platform from the
[downloads page](https://intelligentactuaries.com/scelo). Filenames are
version-stamped (`Scelo.IDE-<version>-x64.exe`); the download tile always
points at the current one.

=== "Windows"

    1. Download the `.exe` from the Windows tile.
    2. Run it. SmartScreen may warn ("unknown publisher") — click
       **More info → Run anyway** (the installer isn't code-signed yet).
    3. Follow the installer (you can change the install directory).

=== "macOS"

    **No prebuilt `.dmg` yet.** macOS has not had a signed release, so the
    downloads page shows macOS as "build from source" rather than offering an
    installer. Use the local build below — it produces the same app, and the
    `.dmg` it writes can be installed normally.

## Build the latest on your own machine

When you want a build newer than the last signed release, you can finish the
install locally. The app code is identical on every OS; only the Electron
runtime and the bundled Python/R differ, and those install **natively** on your
machine.

**1. Get the source** (a small download):

```bash
git clone https://github.com/intelligentactuaries/scelo
cd scelo
```

**2. Run the finisher** — it fetches Electron + the Python/R runtime and builds
a native installer:

=== "macOS"

    ```bash
    bash scripts/finish-install.sh
    ```
    The installer lands in `apps/scelo-ide/build/` (`…arm64.dmg`).

=== "Windows"

    Install [Git for Windows](https://git-scm.com/download/win), open **Git
    Bash** in the `scelo` folder, then:
    ```bash
    bash scripts/finish-install.sh
    ```
    The installer lands in `apps/scelo-ide/build/` (`…x64.exe`).

Just want to run it without building an installer?

```bash
bash scripts/finish-install.sh --run
```

!!! note
    The first run downloads ~1 GB (Electron + the bundled runtime) and can take
    10–30 minutes (R compiles a large package set). After that, Scelo runs fully
    offline.
