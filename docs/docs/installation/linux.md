# Linux

Three ways to install, from most to least recommended. On Ubuntu, apt is the
one to use: it is the only verified, auto-updating path.

!!! info "Supported distributions"
    **Ubuntu 22.04+, Debian 12+, or any distro on the same baseline** (x64).
    The floor is set by the bundled R runtime, which is built against
    Ubuntu 22.04's system libraries — this applies to all three install
    methods below, including the AppImage.

    The **apt** repository is published for two Ubuntu codenames only —
    `jammy` (22.04) and `noble` (24.04). Any other codename resolves to a
    valid but *empty* index, so `apt update` succeeds and then `apt install`
    reports "Unable to locate package". On 24.10+, or on Debian, either pin
    the suite to `noble` (see the manual tab) or use the `.deb` below.

## 1. apt (verified + auto-updating) — recommended

This adds Scelo's **GPG-signed apt repository**, so the package is
cryptographically verified and future versions arrive through normal
`apt upgrade`.

=== "Quick"

    ```bash
    curl -1sLf 'https://dl.cloudsmith.io/public/intelligentactuaries/scelo/setup.deb.sh' | sudo -E bash
    sudo apt install scelo-ide
    ```

    That works as-is on **22.04 and 24.04**, whose codenames are the two we
    publish. The script otherwise configures whatever codename your OS reports,
    which for 24.10+ or Debian is an empty index — pin it instead:

    ```bash
    curl -1sLf 'https://dl.cloudsmith.io/public/intelligentactuaries/scelo/setup.deb.sh' \
      | sudo -E distro=ubuntu codename=noble bash
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

    # 2 · pick the suite we publish to: jammy for a 22.04 base, else noble
    . /etc/os-release
    case "$VERSION_CODENAME" in
      jammy) SUITE=jammy ;;
      *)     SUITE=noble ;;
    esac

    # 3 · the repo, in deb822 format
    sudo tee /etc/apt/sources.list.d/scelo.sources >/dev/null <<EOF
    Types: deb
    URIs: https://dl.cloudsmith.io/public/intelligentactuaries/scelo/deb/ubuntu
    Suites: $SUITE
    Components: main
    Architectures: amd64
    Signed-By: /etc/apt/keyrings/scelo.asc
    EOF

    # 4 · install
    sudo apt update && sudo apt install scelo-ide
    ```

    `Suites` is deliberately **not** `$VERSION_CODENAME` verbatim. The repo
    carries `jammy` and `noble`; asking for any other codename gets you a
    signed, valid, *empty* index — `apt update` looks fine and the install then
    fails with "Unable to locate package". Falling back to `noble` is right for
    24.04 and later, whose system libraries satisfy the package. To remove the
    repo later, delete those two files.

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
