# Splitting the bundled runtime out of `scelo-ide`

**Status:** proposed, not implemented. This is the largest remaining win for
Linux install and update experience, and it needs a machine that can build and
install-test the full package, so it is written down rather than half-done.

## The problem

Current 0.1.2 Linux artefacts:

| | |
|---|---|
| `.deb` download | 565 MB |
| `Installed-Size` | 1.82 GB |
| `.AppImage` | 763 MB |

Almost all of that is `resources/runtime` — CPython 3.11.10, R 4.4.2 and the
actuarial stack (lifelib, chainladder, climada). The app itself, the asar
bundle plus the unpacked native helpers, is a small fraction of it.

The runtime is pinned and changes rarely. The app changes every release. But
they ship as one package, so **every patch release makes every user re-download
the entire Python and R stack to receive a changed JS bundle**. On the apt path
— the one we recommend — that is 565 MB through `apt upgrade` for what is often
a few hundred KB of actual change. It is the main reason updating Scelo feels
heavy, and it gets worse with release frequency, not better.

## The shape of the fix

Two packages instead of one:

| package | contents | changes |
|---|---|---|
| `scelo-ide` | Electron app, asar, native helpers, `.desktop`, icons | every release |
| `scelo-ide-runtime` | `resources/runtime` — CPython, R, actuarial stack | rarely, on a runtime bump |

with `scelo-ide` declaring:

```
Depends: scelo-ide-runtime (>= 0.1.2), libgtk-3-0, libnotify4, …
```

A normal app update then moves tens of MB. A runtime bump still costs the full
download, but that happens on its own cadence rather than on every release.

Version the runtime package on the **runtime** contents, not the app version —
otherwise every app release bumps it and nothing is saved. Something like
`scelo-ide-runtime 3.11.10+4.4.2-1`, with `scelo-ide` depending on a floor
rather than an exact equality so app patches don't force a runtime reinstall.

## Why it is not a config change

electron-builder's `deb` target emits exactly one package and has no notion of
a split. Two routes:

1. **Post-build split.** Let electron-builder produce the single `.deb`, then
   `dpkg-deb -R` it, move `resources/runtime` into a second tree, write the two
   control files, and `dpkg-deb -b` both. Self-contained, no build-system
   change, but the maintainer scripts and the `Installed-Size` / path handling
   have to be got exactly right by hand.
2. **Own the packaging.** Drop to `fpm` (which electron-builder already uses
   underneath) or a small `debhelper` setup and emit both packages directly.
   More work up front, less fragile afterwards, and it is the route that also
   makes an Ubuntu PPA or a Debian submission plausible later.

Route 1 is the cheaper experiment; route 2 is where this ends up if the split
proves worth keeping.

## Test before shipping

A broken split breaks the **recommended** install path, which is worse than a
large package. At minimum, on a clean 22.04 and a clean 24.04:

- `apt install scelo-ide` pulls the runtime automatically
- the app launches and `stackProbe` reports Python **and** R available
- `apt upgrade` from an app-only bump downloads only the app package
- `apt remove scelo-ide` leaves no broken dependency; `apt autoremove` reclaims
  the runtime
- upgrading *from* a current single-package 0.1.2 install cleanly replaces it
  (needs `Replaces:`/`Breaks:` on the old package name)

## Considered and rejected: zstd compression

The `.deb` uses `data.tar.xz`. Ubuntu's own archive moved to zstd because xz
decompression is slow, which on a 1.8 GB payload is real time during install.

Not doing it, for two reasons. electron-builder 25.1.8 cannot emit it —
`DebOptions.compression` accepts only `gz | bzip2 | xz | lzo` — so it would
need a post-build `dpkg-deb -Zzstd` repack, i.e. the same machinery as the
split above but for a much smaller payoff. And it trades **download** size for
**install** speed: zstd would push the 565 MB package to roughly 680 MB to save
perhaps half a minute of CPU. Our users are frequently on managed corporate
connections where the download is the expensive part. The split below reduces
both, and should land first.

Revisit if electron-builder gains zstd support *and* the split has already
brought the app package down to a size where the extra ratio is cheap.
