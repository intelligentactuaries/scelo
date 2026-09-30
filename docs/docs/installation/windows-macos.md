# Windows & macOS

Two routes: the one-click installer, or — for the very latest build — finish
the install on your own machine.

## One-click installer

Download the installer for your platform from the
[downloads page](https://intelligentactuaries.com/scelo). Filenames are
version-stamped (`Scelo-IDE-<version>-x64.exe`, `Scelo-IDE-<version>-arm64.dmg`);
the download tile always points at the newest build for your platform.

=== "Windows"

    1. Download the `.exe` from the Windows tile.
    2. Run it. SmartScreen may warn ("unknown publisher") — click
       **More info → Run anyway** (the installer isn't code-signed yet).
    3. Follow the installer (you can change the install directory).

=== "macOS"

    For **Apple Silicon** Macs (M1 or later) on **macOS 14 Sonoma or later**.
    There is no Intel build: the bundled Python is an Apple Silicon build.

    1. Download the `.dmg` from the macOS tile and open it.
    2. Drag **Scelo IDE** onto **Applications**.
    3. Clear the download flag once, in **Terminal**. The app is not signed or
       notarised by Apple yet, so macOS quarantines it; this lifts that for
       the app and for the Python, R and swarm programs bundled inside it:

        ```bash
        xattr -dr com.apple.quarantine "/Applications/Scelo IDE.app"
        ```

    4. Open Scelo IDE from Applications.

    **Without Terminal:** open Scelo IDE, close the warning, then go to
    **System Settings → Privacy & Security**, scroll to *"Scelo IDE" was
    blocked…* and click **Open Anyway** (on macOS 14 you can instead
    Control-click the app and choose **Open**). If Scelo then reports that its
    Python, R or swarm cannot start, run the command in step 3.

    If macOS says Scelo IDE **"is damaged and can't be opened"**, that is the
    same quarantine flag, not a broken file: step 3 fixes it.

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
