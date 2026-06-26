#!/usr/bin/env bash
# Publish the built Scelo IDE .deb to a Cloudsmith apt repository.
#
# Cloudsmith hosts the package in a GPG-signed apt repo, so users get a
# *verified*, auto-updating install instead of a "third party / potentially
# unsafe" side-loaded .deb:
#
#   curl -1sLf 'https://dl.cloudsmith.io/public/<owner>/<repo>/setup.deb.sh' | sudo -E bash
#   sudo apt install scelo-ide
#
# One-time setup (yours):
#   1. Create a free Cloudsmith account (open-source tier): https://cloudsmith.com
#   2. Create a repository (e.g. "scelo") under your org.
#   3. Make an API key: Account → API Settings, then export it:
#        export CLOUDSMITH_API_KEY=...           (required)
#        export CLOUDSMITH_OWNER=intelligentactuaries   (defaults below)
#        export CLOUDSMITH_REPO=scelo
#
# Then, after `bun run dist:linux` has produced the .deb:
#   bash apps/scelo-ide/scripts/publish-deb-cloudsmith.sh
set -euo pipefail

: "${CLOUDSMITH_API_KEY:?Set CLOUDSMITH_API_KEY (Cloudsmith → Account → API Settings)}"
OWNER="${CLOUDSMITH_OWNER:-intelligentactuaries}"
REPO="${CLOUDSMITH_REPO:-scelo}"
# Cloudsmith needs a distro/release coordinate. Our .deb bundles its own
# Python/R and isn't distro-pinned, so the generic any-distro slot fits.
DISTRO="${CLOUDSMITH_DISTRO:-any-distro/any-version}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../build"
DEB="$(ls -1 "$BUILD_DIR"/*.deb 2>/dev/null | head -1 || true)"
if [ -z "$DEB" ]; then
  echo "✗ No .deb found in $BUILD_DIR — run 'bun run ide:dist:linux' first." >&2
  exit 1
fi

# Locate (or install) the Cloudsmith CLI. Modern Debian/Ubuntu mark the system
# Python "externally managed" (PEP 668), so a plain `pip install` is refused.
# Try, in order: an existing CLI, pipx, an isolated venv, then a user-site
# install with the PEP 668 override. CS holds the resolved binary path.
CS="$(command -v cloudsmith || true)"
if [ -z "$CS" ]; then
  echo "↓ Installing the Cloudsmith CLI…"
  if command -v pipx >/dev/null 2>&1; then
    pipx install cloudsmith-cli >/dev/null 2>&1 || true
  fi
  CS="$(command -v cloudsmith || true)"
  [ -z "$CS" ] && [ -x "$HOME/.local/bin/cloudsmith" ] && CS="$HOME/.local/bin/cloudsmith"
fi
if [ -z "$CS" ]; then
  VENV="$HOME/.cache/scelo-cloudsmith-venv"
  if python3 -m venv "$VENV" >/dev/null 2>&1 && \
     "$VENV/bin/pip" install -q --upgrade pip cloudsmith-cli >/dev/null 2>&1; then
    CS="$VENV/bin/cloudsmith"
  fi
fi
if [ -z "$CS" ]; then
  # Last resort: user-site install, overriding the externally-managed guard.
  python3 -m pip install --user --break-system-packages -q cloudsmith-cli >/dev/null 2>&1 || true
  CS="$(command -v cloudsmith || true)"
  [ -z "$CS" ] && [ -x "$HOME/.local/bin/cloudsmith" ] && CS="$HOME/.local/bin/cloudsmith"
fi
if [ -z "$CS" ]; then
  echo "✗ Could not install cloudsmith-cli automatically. Install it manually, e.g.:" >&2
  echo "    pipx install cloudsmith-cli      # recommended" >&2
  echo "    pip install --user --break-system-packages cloudsmith-cli" >&2
  exit 1
fi

echo "↑ Pushing $(basename "$DEB") → $OWNER/$REPO ($DISTRO)"
"$CS" push deb "$OWNER/$REPO/$DISTRO" "$DEB"

cat <<EOF

✓ Published. Cloudsmith signs the repo automatically.

  Users install the VERIFIED, auto-updating package with:
    curl -1sLf 'https://dl.cloudsmith.io/public/$OWNER/$REPO/setup.deb.sh' | sudo -E bash
    sudo apt install scelo-ide

  (That setup script adds the signed repo + Cloudsmith's GPG key, so apt
   verifies authenticity and future versions arrive via normal updates.)
EOF
