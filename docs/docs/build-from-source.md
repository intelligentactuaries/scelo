# Build from source

You can run Scelo from the repository and produce your own installers.

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.1 and **Node.js** LTS
- Python 3 and a C++ toolchain (`build-essential` on Linux, the Xcode Command
  Line Tools on macOS) — `node-pty` is compiled against Electron's headers
  when packaging
- Git
- For packaging: the usual electron-builder system deps for your target (e.g.
  `dpkg`/`fakeroot` for `.deb` on Linux)

## Layout

| Path | What it is |
| --- | --- |
| `apps/scelo-ide` | The Electron **main process** + packaging |
| `apps/web` | The React **renderer** (the whole UI) |
| `apps/swarm` | The swarm (council + simulation): Bun server + Vite client |

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

This downloads a portable CPython (PBS) and R into
`apps/scelo-ide/resources/runtime/` (shipped as `extraResources`) and installs
the pinned package set from `apps/scelo-ide/runtime/python-requirements-<os>.txt`.
Run it on the OS you are packaging for (`TARGET_OS=linux|mac|win` overrides the
detection); pip installs with the target interpreter, so it cannot cross-stage.

Two things it does beyond `pip install`, both explained in
`scripts/bundle-runtimes.sh`:

- **GDAL's Python bindings are skipped.** They exist only as source that must
  match a system libgdal, and the one climada function that uses them (the
  legacy Black Marble nightlight reader) is made to import them lazily; LitPop
  and the rest of climada read rasters through rasterio instead.
- **It proves the stack imports.** If NumPy, SciPy, scikit-learn, statsmodels,
  LightGBM, chainladder, climada, lifelib or modelx cannot be imported from the
  bundled interpreter, the stage fails rather than shipping a bare runtime.

## Package installers

```bash
bun run ide:dist:linux    # AppImage + .deb
bun run ide:dist:win      # NSIS .exe   (see note)
bun run ide:dist:mac      # .dmg        (see note)
```

`dist:linux` and `dist:mac` first run `build:pty`, which compiles `node-pty`
against the Electron version the app ships and checks that a shell echoes back
through it: upstream publishes no binary for Electron 33, and without one the
terminal falls back to a plain pipe.

Artifacts land in `apps/scelo-ide/build`. Packaging config is
`apps/scelo-ide/electron-builder.yml` (appId `io.intelligentactuaries.scelo`,
product name **Scelo IDE**).

!!! note "Cross-compiling is limited"
    A `.dmg` can only be built **on macOS**. Windows `.exe` builds need a Windows
    host (or CI) for a clean result — cross-building from Linux via Wine is
    unreliable because of the bundled native runtimes. For releasing all three
    platforms, build each on its own OS (or in CI). Releases build the Apple
    Silicon `.dmg` on GitHub's macOS runner
    (`.github/workflows/release-macos.yml`), ad-hoc signed and not notarised,
    and attach it to the release. End users on Windows/macOS can
    also use the [finish-on-your-OS](installation/windows-macos.md) path.

## The swarm

The swarm lives in this repo (`apps/swarm`) and is installed by the root
`bun install`. `bun run --cwd apps/scelo-ide build` also runs
`bundle:swarm`, which compiles the swarm server to a single executable and
builds its client into `apps/scelo-ide/resources/swarm/` — the IDE starts that
with the app. To hack on the swarm itself run the dev pair instead:

```bash
bun run dev:swarm
```

(the IDE adopts a running dev pair rather than starting its own). See
[Running the swarm](swarm/running.md).
