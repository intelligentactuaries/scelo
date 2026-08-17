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
#   3. Make an API key: Account → API Settings, then give it to the CLI one of
#      two ways. Prefer the credentials file — it keeps the key out of your
#      shell history, out of `ps`, and out of any transcript:
#        mkdir -p ~/.cloudsmith && chmod 700 ~/.cloudsmith
#        printf '[default]\napi_key = YOUR_KEY\n' > ~/.cloudsmith/credentials.ini
#        chmod 600 ~/.cloudsmith/credentials.ini
#      or, for CI, export it:
#        export CLOUDSMITH_API_KEY=...
#      Optional overrides (defaults below):
#        export CLOUDSMITH_OWNER=intelligentactuaries
#        export CLOUDSMITH_REPO=scelo
#
# Then, after `bun run dist:linux` has produced the .deb:
#   bash apps/scelo-ide/scripts/publish-deb-cloudsmith.sh
set -euo pipefail

OWNER="${CLOUDSMITH_OWNER:-intelligentactuaries}"
REPO="${CLOUDSMITH_REPO:-scelo}"
# Cloudsmith needs a distro/release coordinate. Our .deb bundles its own
# Python/R and isn't distro-pinned, so the generic any-distro slot fits.
DISTRO="${CLOUDSMITH_DISTRO:-any-distro/any-version}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/../build"

# The CLI reads ~/.cloudsmith/credentials.ini on its own, so the env var is
# only one of two valid ways in. Require *a* credential, not specifically the
# variable, or the file route can never be used.
CREDS_FILE="${HOME}/.cloudsmith/credentials.ini"
if [ -z "${CLOUDSMITH_API_KEY:-}" ] && [ ! -f "$CREDS_FILE" ]; then
  echo "✗ No Cloudsmith credential found. Either write $CREDS_FILE:" >&2
  echo "    mkdir -p ~/.cloudsmith && chmod 700 ~/.cloudsmith" >&2
  echo "    printf '[default]\\napi_key = YOUR_KEY\\n' > $CREDS_FILE" >&2
  echo "    chmod 600 $CREDS_FILE" >&2
  echo "  or export CLOUDSMITH_API_KEY (Cloudsmith → Account → API Settings)." >&2
  exit 1
fi

# Pick the .deb by the version we just built, never by glob order. build/ keeps
# every past release, and `ls | head -1` sorts lexically — with 0.1.2 and 0.1.3
# both present it selected 0.1.2, i.e. it would have pushed a stale package
# into a signed repo that users auto-update from.
VERSION="$(node -p "require('$SCRIPT_DIR/../package.json').version")"
DEB="$BUILD_DIR/Scelo IDE-$VERSION-amd64.deb"
if [ ! -f "$DEB" ]; then
  echo "✗ No .deb for version $VERSION in $BUILD_DIR." >&2
  echo "  Run 'bun run ide:dist:linux' to build it. Present:" >&2
  ls -1 "$BUILD_DIR"/*.deb 2>/dev/null | sed 's|^|    |' >&2 || echo "    (none)" >&2
  exit 1
fi

# Pre-flight the desktop integration. A signed apt repo is the one channel we
# cannot quietly correct — users pull from it automatically — and both of these
# have shipped broken before (0.1.0–0.1.3), so refuse to publish a package that
# would land a generic gear icon or an invalid .desktop on someone's machine.
#
# Both checks read their input from a variable rather than a pipe on purpose.
# `set -o pipefail` plus a `grep -q` that exits on the first match kills the
# upstream `dpkg` with SIGPIPE, and the pipeline then reports 141 — so piping
# straight into `grep -q` reports "absent" for a file that is right there.
DESKTOP="$(dpkg-deb --fsys-tarfile "$DEB" 2>/dev/null \
  | tar -xO ./usr/share/applications/scelo-ide.desktop 2>/dev/null || true)"
if [ -z "$DESKTOP" ]; then
  echo "✗ $(basename "$DEB") ships no /usr/share/applications/scelo-ide.desktop." >&2
  exit 1
fi
if ! grep -q '^StartupWMClass=@ia/scelo-ide$' <<<"$DESKTOP"; then
  echo "✗ $(basename "$DEB") has the wrong StartupWMClass — GNOME would show a" >&2
  echo "  generic gear instead of the Scelo logo. Expected '@ia/scelo-ide', got:" >&2
  grep '^StartupWMClass=' <<<"$DESKTOP" | sed 's|^|    |' >&2 || echo "    (absent)" >&2
  exit 1
fi
# Every line must be a group header, a comment, or key=value. A folded-away
# multi-line Comment is what made desktop-file-validate reject 0.1.0–0.1.3.
if BAD="$(grep -vnE '^([#[]|[^=]*=|$)' <<<"$DESKTOP")"; then
  echo "✗ $(basename "$DEB") ships a malformed .desktop — these lines are" >&2
  echo "  neither a group, a comment, nor an entry:" >&2
  sed 's|^|    |' <<<"$BAD" >&2
  exit 1
fi
CONTENTS="$(dpkg -c "$DEB")"
if ! grep -q 'usr/share/metainfo/.*\.metainfo\.xml' <<<"$CONTENTS"; then
  echo "✗ $(basename "$DEB") has no AppStream metainfo — App Center would read" >&2
  echo "  'Unknown publisher / License unknown / Last updated Unknown'." >&2
  exit 1
fi
echo "✓ Pre-flight: StartupWMClass, .desktop syntax and metainfo all good."

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
