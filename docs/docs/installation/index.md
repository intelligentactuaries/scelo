# Installation

Scelo is a desktop app. Pick your platform:

<div class="grid cards" markdown>

-   :material-linux: **[Linux](linux.md)**

    `apt` (verified, auto-updating), AppImage, or `.deb`.

-   :material-microsoft-windows: :material-apple: **[Windows & macOS](windows-macos.md)**

    One-click installer, or build the latest on your own machine.

-   :material-rocket-launch: **[First launch](first-launch.md)**

    The runtime check and choosing a workspace.

</div>

## System requirements

| | Minimum |
| --- | --- |
| **OS** | Linux (x64), Windows 10/11 (x64), macOS 12+ (Apple Silicon) |
| **Disk** | ~2 GB (the installer bundles a full Python + R runtime) |
| **RAM** | 8 GB recommended |
| **Network** | Only for first download and optional hosted AI / the swarm. The core app runs **offline**. |

!!! note "What's bundled"
    The installer ships a portable **CPython** and **R** with the IA actuarial
    package set (lifelib, chainladder, climada, forecast, ChainLadder, and
    more). You do **not** need Python or R installed on your machine.

## A note on "unknown publisher" warnings

Downloaded installers are not yet code-signed, so:

- **Windows** SmartScreen and **macOS** Gatekeeper warn on first launch (choose
  *Run anyway* / right-click → *Open*).
- A side-loaded Linux `.deb` shows "third party" in App Center.

The **verified, signed** way to install on Linux is the **apt repository** —
see [Linux](linux.md). Signed Windows/macOS installers will follow once the
code-signing certificates are in place.
