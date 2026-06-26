# Build from source

You can run Scelo from the repository and produce your own installers.

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.1
- A C toolchain (for native modules like `node-pty`)
- Git
- For packaging: the usual electron-builder system deps for your target (e.g.
  `dpkg`/`fakeroot` for `.deb` on Linux)

## Layout

| Path | What it is |
| --- | --- |
| `apps/scelo-ide` | The Electron **main process** + packaging |
| `apps/web` | The React **renderer** (the whole UI) |
| `swarms` | The separate swarm server (council + simulation) |

## Run in development

```bash
bun install
bun run dev          # builds main + launches Electron
```

!!! warning "Renderer changes need a rebuild"
    `bun run dev` rebuilds **only the main process**. After editing anything in
    `apps/web`, rebuild the renderer:

    ```bash
    bun run --cwd apps/scelo-ide build:renderer
    ```

    (`build:renderer` builds `apps/web` and copies its `dist` into
    `resources/renderer`.)

To run the renderer alone in a browser (limited — no `window.scelo` bridge):

```bash
bun run dev:web
```

## Type-check

```bash
bun run check        # web typecheck + main build
```

## Bundle the runtimes

The packaged app ships its own Python and R. Build them once before packaging:

```bash
bun run --cwd apps/scelo-ide bundle:runtime
```

This downloads a portable CPython (PBS) and R into `extraResources`.

## Package installers

```bash
bun run ide:dist:linux    # AppImage + .deb
bun run ide:dist:win      # NSIS .exe   (see note)
bun run ide:dist:mac      # .dmg        (see note)
```

Artifacts land in `apps/scelo-ide/dist`. Packaging config is
`apps/scelo-ide/electron-builder.yml` (appId `io.intelligentactuaries.scelo`,
product name **Scelo IDE**).

!!! note "Cross-compiling is limited"
    A `.dmg` can only be built **on macOS**. Windows `.exe` builds need a Windows
    host (or CI) for a clean result — cross-building from Linux via Wine is
    unreliable because of the bundled native runtimes. For releasing all three
    platforms, build each on its own OS (or in CI). End users on Windows/macOS can
    also use the [finish-on-your-OS](installation/windows-macos.md) path.

## Run the swarm

The swarm is its own server, not bundled:

```bash
cd swarms
PORT=3010 bun run dev
```

See [Running the swarm](swarm/running.md).
