# Becoming a known, trusted publisher

When users install a downloaded `.deb` / `.exe` / `.dmg`, the OS flags it as
**"Unknown publisher / potentially unsafe / third party."** That's not a bug in
the build: it's the OS telling the user the package didn't come from a trusted
*channel* and isn't *signed* by a verified identity. Removing it is a
**distribution + signing** task, not a code change. Here's the path per OS.

There are two distinct problems, and they need different fixes:

| Symptom | Cause | Fix |
|---|---|---|
| "Unknown publisher / license / date" | no AppStream metadata in the package | the `metainfo.xml` in this folder (done) |
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

Each release:
```bash
bun run ide:dist:linux                       # builds the .deb (+ AppImage)
export CLOUDSMITH_API_KEY=...                 # your key
export CLOUDSMITH_OWNER=intelligentactuaries  # your org slug
export CLOUDSMITH_REPO=scelo
bash apps/scelo-ide/scripts/publish-deb-cloudsmith.sh
```

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

- **Code (done):** AppStream `metainfo.xml` + `.desktop` + the snap target →
  fixes "Unknown publisher/license/date" and wires the Snap path.
- **Accounts + money (you):** a Snap Store / Flathub publisher account (free) to
  clear the Linux "third party" flag, and Windows/Apple signing certs (paid) to
  clear SmartScreen / Gatekeeper.

The metadata file makes the listing read correctly; only a verified store
channel or a signing certificate makes the OS call you a *known, trusted*
publisher.
