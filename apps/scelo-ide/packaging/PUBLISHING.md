# Becoming a known, trusted publisher

When users install a downloaded `.deb` / `.exe` / `.dmg`, the OS flags it as
**"Unknown publisher / potentially unsafe / third party."** That's not a bug in
the build: it's the OS telling the user the package didn't come from a trusted
*channel* and isn't *signed* by a verified identity. Removing it is a
**distribution + signing** task, not a code change. Here's the path per OS.

There are two distinct problems, and they need different fixes:

| Symptom | Cause | Fix |
|---|---|---|
| "Unknown publisher / license / date" | no AppStream metadata in the package | the `metainfo.xml` in this folder (written; ships from 0.1.3 — see below) |
| "Potentially unsafe / third party" | not from a verified store, not signed | publish to a store / buy a signing cert (below) |

---

## Linux — verified `.deb` via a signed apt repo (Cloudsmith)

A side-loaded `.deb` (a file you download and `dpkg -i`) will always read as
"third party". The `.deb`-native way to be *verified* is a **GPG-signed apt
repository**: users add the repo + key once, then `apt install scelo-ide` is
cryptographically verified and auto-updates. We host it on **Cloudsmith** (free
for open source, signs the repo for you).

One-time (yours):
1. Create a free Cloudsmith account, then a repo (e.g. `scelo`) under your org.
2. Account → API Settings → make an API key.

One-time, store the key where the CLI finds it by itself — this keeps it out of
your shell history, out of `ps`, and out of any terminal transcript:
```bash
mkdir -p ~/.cloudsmith && chmod 700 ~/.cloudsmith
printf '[default]\napi_key = YOUR_KEY\n' > ~/.cloudsmith/credentials.ini
chmod 600 ~/.cloudsmith/credentials.ini
```
(`CLOUDSMITH_API_KEY` still works and is the right choice in CI, where there is
no home directory to persist.)

Each release:
```bash
# 1 · bump apps/scelo-ide/package.json's version and add a <release> entry to
#     packaging/io.intelligentactuaries.scelo.metainfo.xml — the publish script
#     selects the .deb *by that version*, so this is not optional.
bun run ide:dist:linux                       # builds the .deb (+ AppImage)
bash apps/scelo-ide/scripts/publish-deb-cloudsmith.sh
```

The script picks `build/Scelo IDE-<package.json version>-amd64.deb`, never a
glob. It used to take `ls -1 build/*.deb | head -1`, and because `build/` keeps
every past release and `ls` sorts lexically, the first Cloudsmith publish pushed
**0.1.2 instead of 0.1.3** — a stale package, into the one channel that
auto-updates users. Check what the repo actually serves after any push:

```bash
curl -fsSL https://dl.cloudsmith.io/public/intelligentactuaries/scelo/deb/ubuntu/dists/any-version/main/binary-amd64/Packages \
  | grep -E '^(Package|Version):'
```

Before uploading, the script refuses the package unless the `.desktop` inside it
has `StartupWMClass=@ia/scelo-ide`, parses as group/comment/`key=value` on every
line, and the AppStream metainfo is present. All three shipped broken at some
point in 0.1.0–0.1.3, and a signed apt repo is the one channel you cannot
quietly correct afterwards.

### Never publish to `any-distro/any-version`

The script uploads once per real codename (`ubuntu/jammy ubuntu/noble`, override
with `CLOUDSMITH_DISTROS`). The tempting shortcut — one upload to
`any-distro/any-version`, since the `.deb` bundles its own Python/R and is not
distro-pinned — produces a repository that **passes every check and cannot be
installed from**:

| Root | Index | Package file |
|---|---|---|
| `/deb/ubuntu` (what apt is configured with) | ✅ present, signed | ❌ 404 |
| `/deb/any-distro` | ❌ 404, no suite exists | ✅ present |

An any-distro package is listed in every distro's `Packages`, but the file is
only served beneath `/deb/any-distro/pool/…`, and `Filename:` is resolved
relative to the root apt was given. So `apt update` succeeds, the signature
verifies, `apt-cache policy` shows the right candidate — and the download 404s.
That is how 0.1.0 through 0.1.2 sat in this repo looking fine and never being
installable by anyone.

Verify with real apt rather than by reading the index, in a throwaway root so
nothing on your machine changes:

```bash
d=$(mktemp -d); mkdir -p $d/{var/lib/apt/lists/partial,var/cache/apt/archives/partial,var/lib/dpkg}
: > $d/var/lib/dpkg/status
curl -1sLf https://dl.cloudsmith.io/public/intelligentactuaries/scelo/gpg.key | gpg --dearmor > $d/k.gpg
echo "deb [signed-by=$d/k.gpg] https://dl.cloudsmith.io/public/intelligentactuaries/scelo/deb/ubuntu noble main" > $d/sources
A="-o Dir::Etc::sourcelist=$d/sources -o Dir::Etc::sourceparts=$d/none -o Dir::State=$d/var/lib/apt -o Dir::State::status=$d/var/lib/dpkg/status -o Dir::Cache=$d/var/cache/apt -o APT::Architecture=amd64"
apt-get $A update && (cd $d && apt-get $A download scelo-ide)   # must actually fetch
```

Note that only the codenames you upload to carry the package. Every other suite
still returns a signed, valid, **empty** index, so a user on 24.10 or Debian
sees `apt update` succeed and then "Unable to locate package" — which is why
`docs/docs/installation/linux.md` pins the suite instead of using
`$VERSION_CODENAME` verbatim. Cloudsmith also refuses a real-distro upload while
an `any-distro` package of the same name+version+arch exists; delete that first.

Users then install the verified, auto-updating package:
```bash
curl -1sLf 'https://dl.cloudsmith.io/public/intelligentactuaries/scelo/setup.deb.sh' | sudo -E bash
sudo apt install scelo-ide
```

> Note: this gives cryptographic trust + clean `apt` install + updates (the
> `.deb` world's "verified"). The literal "verified publisher ⭐" badge in the
> Ubuntu App Center is Snap-Store-specific; a signed apt repo does not show that
> exact star, but it removes the untrusted-download problem.

## Linux — Snap Store or Flathub (for the App Center ⭐ badge)

If you specifically want the App Center *verified publisher* star, distribute
through a store.

### Option A — Snap Store (easiest for this app)

electron-builder builds the snap for us, and classic confinement fits an IDE
that spawns Python/R + a terminal (the `snap:` block is already in
`electron-builder.yml`).

```bash
# one-time
sudo snap install snapcraft --classic
snapcraft login                       # free Ubuntu One account
snapcraft register scelo-ide          # claim the name

# build + upload (run from apps/scelo-ide)
bun run bundle:runtime                # stage the linux runtime first
./node_modules/.bin/electron-builder --linux snap
snapcraft upload "build/scelo-ide_0.1.0_amd64.snap" --release=stable
```

Then in the Snap Store dashboard:
- Request **classic confinement** approval (one-time review; required because
  the app needs full system access). Until granted, upload as a *grade: devel*
  snap or test locally with `snap install --dangerous --classic`.
- Apply for the **verified publisher / "starred developer"** badge by linking
  the `intelligentactuaries.com` domain.

Result: `snap install scelo-ide` and the App Center listing show **Intelligent
Actuaries (verified)**, no "third party" banner.

### Option B — Flathub

Flathub gives a **verified** badge via domain ownership. It's more work for
this app because Flatpak sandboxes aggressively (the bundled Python/R + the
terminal need broad `--filesystem` / `--device` permissions). Steps:
1. Write a Flatpak manifest (`io.intelligentactuaries.scelo.yml`) on the
   `org.electronjs.Electron2.BaseApp` base, bundling the app + runtime, with the
   `metainfo.xml` and `.desktop` from this folder installed to
   `/app/share/metainfo` and `/app/share/applications`.
2. Submit it as a PR to <https://github.com/flathub/flathub> for review.
3. Verify the app at <https://flathub.org/setup> by proving domain ownership.

> For a subprocess-heavy, runtime-bundling IDE, **Snap classic** is the lower
> friction route; Flathub is the better-known badge if you can live with the
> sandbox permissions.

---

## Windows — code signing (removes SmartScreen "unknown publisher")

1. Buy an **OV or EV code-signing certificate** (DigiCert, Sectigo, SSL.com,
   ~$200–500/yr; EV gives instant SmartScreen reputation, OV builds it over
   time).
2. electron-builder already reads the Windows signing env vars — set them in CI:
   - `WIN_CSC_LINK` = base64 of the `.pfx` (or a path)
   - `WIN_CSC_KEY_PASSWORD` = its password
3. Rebuild `--win`; the `.exe` is now signed and SmartScreen stops warning.

## macOS — Apple notarization (removes Gatekeeper warning)

1. Enroll in the **Apple Developer Program** ($99/yr) → get a *Developer ID
   Application* certificate.
2. Set the env vars electron-builder reads (already wired in
   `electron-builder.yml`):
   - `CSC_LINK` / `CSC_KEY_PASSWORD` (the `.p12`)
   - `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
3. Rebuild `--mac`; electron-builder signs **and notarizes** the `.dmg`, and
   Gatekeeper accepts it.

---

## Summary

- **Code (written; first ships in 0.1.3):** AppStream `metainfo.xml` +
  `.desktop` + the snap target → fixes "Unknown publisher/license/date" and
  wires the Snap path. Through 0.1.2 the metainfo was authored but never
  installed by the build, and the `.desktop` was malformed, so shipped packages
  still showed "Unknown" everywhere. Both fixed in `electron-builder.yml`;
  **verify on the next Linux build** with:

  ```bash
  dpkg -c build/*.deb | grep -E "metainfo|\.desktop"
  dpkg-deb --fsys-tarfile build/*.deb | tar -xO ./usr/share/applications/scelo-ide.desktop
  ```

  The desktop file must be single-line per key and must not contain
  `entry=[object Object]`, and its `StartupWMClass` must be `@ia/scelo-ide`
  (the window's real WM_CLASS — see the comment in `electron-builder.yml`).
  With the wrong class the installed app runs under a generic gear icon in
  the GNOME dock instead of the Scelo logo. Verify after installing: launch
  from the dock and confirm the running window shows the logo; on X11
  `wmctrl -lx` should list it as `@ia/scelo-ide.@ia/scelo-ide`.
- **Accounts + money (you):** a Snap Store / Flathub publisher account (free) to
  clear the Linux "third party" flag, and Windows/Apple signing certs (paid) to
  clear SmartScreen / Gatekeeper.

The metadata file makes the listing read correctly; only a verified store
channel or a signing certificate makes the OS call you a *known, trusted*
publisher.
