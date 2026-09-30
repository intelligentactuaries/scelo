# Installation

Scelo is a desktop app. Pick your platform:

<div class="grid cards" markdown>

-   :material-linux: **[Linux](linux.md)**

    `apt` (verified, auto-updating), AppImage, or `.deb`.

-   :material-microsoft-windows: :material-apple: **[Windows & macOS](windows-macos.md)**

    One-click installer, or build the latest on your own machine.

-   :material-rocket-launch: **[First launch](first-launch.md)**

    The pipeline you land on, the runtime check, and choosing a workspace.

</div>

## System requirements

| | Minimum |
| --- | --- |
| **OS** | Ubuntu 22.04+ / Debian 12+ (x64) · Windows 10/11 (x64) · macOS 14+ on Apple Silicon (M1 or later) |
| **Disk** | ~2.5 GB installed (the installer bundles a full Python + R runtime) |
| **RAM** | 8 GB recommended |
| **Network** | Only for first download and optional hosted AI / the swarm. The core app runs **offline**. |

!!! note "What's bundled"
    The installer ships a portable **CPython** and **R** with the IA actuarial
    package set (lifelib, chainladder, climada, forecast, ChainLadder, and
    more). You do **not** need Python or R installed on your machine.

    One exception on Linux: the bundled **R** is Ubuntu 24.04's R, repacked,
    and it loads that release's system libraries. It runs on Ubuntu 24.04,
    where a default `apt install` pulls those libraries in; on older
    distributions the R bridges don't run yet, while the rest of Scelo
    (Python included) does. Details on the [Linux](linux.md) page.

    On macOS the prebuilt `.dmg` is for Apple Silicon only (the bundled
    Python is an arm64 build) and needs macOS 14 Sonoma or later, because
    several of the bundled numerical libraries (NumPy, SciPy) are built for
    it.

## A note on "unknown publisher" warnings

Downloaded installers are not yet code-signed, so:

- **Windows** SmartScreen warns on first launch (choose *More info → Run
  anyway*).
- **macOS** quarantines the unsigned app: clear the flag once (one Terminal
  command) or allow it in Privacy & Security — see the
  [macOS steps](windows-macos.md#one-click-installer).
- A side-loaded Linux `.deb` shows "third party" in App Center.

The **verified, signed** way to install on Linux is the **apt repository** —
see [Linux](linux.md). Signed Windows/macOS installers will follow once the
code-signing certificates are in place.
