# Linux

Three ways to install, from most to least recommended. On Ubuntu, apt is the
one to use: it is the only verified, auto-updating path.

!!! info "Supported distributions"
    **Ubuntu 22.04+, Debian 12+, or any distro on the same baseline** (x64).
    The floor is set by the bundled R runtime, which is built against
    Ubuntu 22.04's system libraries — this applies to all three install
    methods below, including the AppImage.

## 1. apt (verified + auto-updating) — recommended

This adds Scelo's **GPG-signed apt repository**, so the package is
cryptographically verified and future versions arrive through normal
`apt upgrade`.

=== "Quick"

    ```bash
    curl -1sLf 'https://dl.cloudsmith.io/public/intelligentactuaries/scelo/setup.deb.sh' | sudo -E bash
    sudo apt install scelo-ide
    ```

=== "Manual (no script run as root)"

    Same repository, added by hand. Nothing runs as root but `tee` and `apt`.
    Uses **deb822 `.sources`** — the current standard, replacing the
    deprecated `apt-key` and the transitional one-line `signed-by=` entry —
    with the key in `/etc/apt/keyrings/`.

    ```bash
    # 1 · our signing key
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://dl.cloudsmith.io/public/intelligentactuaries/scelo/gpg.key \
      | sudo tee /etc/apt/keyrings/scelo.asc >/dev/null

    # 2 · the repo, in deb822 format
    . /etc/os-release
    sudo tee /etc/apt/sources.list.d/scelo.sources >/dev/null <<EOF
    Types: deb
    URIs: https://dl.cloudsmith.io/public/intelligentactuaries/scelo/deb/ubuntu
    Suites: ${VERSION_CODENAME}
    Components: main
    Architectures: amd64
    Signed-By: /etc/apt/keyrings/scelo.asc
    EOF

    # 3 · install
    sudo apt update && sudo apt install scelo-ide
    ```

    `Suites` is read from `/etc/os-release` rather than hardcoded, so the same
    block is correct on 22.04, 24.04 and later. To remove the repo later,
    delete those two files.

    Verify the key you installed matches ours:

    ```
    838952DA5770540284FDD72F76A1D9D9E4EDA4CE
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

## 2. .deb (Debian / Ubuntu)

Download the `.deb` from the website and install it with `apt`:

```bash
sudo apt install ./Scelo.IDE-*-amd64.deb
```

!!! warning "Side-loaded `.deb` shows 'third party'"
    Installing a downloaded `.deb` directly works, but Ubuntu's App Center flags
    any downloaded package as "third party / potentially unsafe" — that's
    expected for a side-loaded file. Use the [apt method](#1-apt-verified-auto-updating-recommended)
    above for the signed, verified experience.

## 3. AppImage (portable — other distributions)

A single self-contained file that runs on any supported distro (see the
baseline above) — no package manager involved.

**On Debian or Ubuntu, prefer apt or the `.deb` above.** The AppImage needs
FUSE 2 there (below), gets no desktop-menu integration, and updates outside
`apt`. Its real use is distributions the `.deb` does not cover, or a machine
where you cannot install anything system-wide.

```bash
# download from the website's Linux tile, then:
chmod +x Scelo.IDE-*-x86_64.AppImage
./Scelo.IDE-*-x86_64.AppImage
```

The AppImage needs no root and leaves nothing installed system-wide — handy for
trying Scelo or running it on a locked-down machine.

!!! warning "Ubuntu 22.04+ needs FUSE 2"
    AppImages are mounted with FUSE 2, which Ubuntu stopped installing by
    default in 22.04. If the file downloaded fine but exits immediately with a
    `libfuse.so.2` error, install it:

    ```bash
    sudo apt install libfuse2t64   # libfuse2 on releases before 24.04
    ```

    The apt and `.deb` methods have no such requirement.

## Snap

Not published yet. A classic-confinement snap is planned — it will show as a
verified publisher in the App Center — but `scelo-ide` is not in the Snap Store
today, so `snap install` will not find it. Use apt above.
