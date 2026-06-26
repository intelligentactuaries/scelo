# Linux

Three ways to install, from most to least recommended.

## 1. apt (verified + auto-updating) — recommended

This adds Scelo's **GPG-signed apt repository**, so the package is
cryptographically verified and future versions arrive through normal
`apt upgrade`.

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/intelligentactuaries/scelo/setup.deb.sh' | sudo -E bash
sudo apt install scelo-ide
```

Launch it from your application menu (**Scelo IDE**) or run `scelo-ide`.

!!! success "Why this is the trusted path"
    The setup script registers the repo and its signing key, so `apt` verifies
    every install and update is genuinely from Intelligent Actuaries — no
    "untrusted download" warning.

To update later:

```bash
sudo apt update && sudo apt upgrade scelo-ide
```

To remove:

```bash
sudo apt remove scelo-ide
```

## 2. AppImage (portable, no install)

A single self-contained file that runs on any distro.

```bash
# download from the website's Linux tile, then:
chmod +x 'Scelo IDE-0.1.0-x86_64.AppImage'
./'Scelo IDE-0.1.0-x86_64.AppImage'
```

The AppImage needs no root and leaves nothing installed system-wide — handy for
trying Scelo or running it on a locked-down machine.

## 3. .deb (Debian / Ubuntu)

Download the `.deb` from the website and install it with `apt`:

```bash
sudo apt install ./'Scelo IDE-0.1.0-amd64.deb'
```

!!! warning "Side-loaded `.deb` shows 'third party'"
    Installing a downloaded `.deb` directly works, but Ubuntu's App Center flags
    any downloaded package as "third party / potentially unsafe" — that's
    expected for a side-loaded file. Use the [apt method](#1-apt-verified-auto-updating-recommended)
    above for the signed, verified experience.

## Snap

A classic-confinement snap is also available (it shows as a verified publisher
in the App Center once published to the Snap Store):

```bash
sudo snap install scelo-ide --classic
```
