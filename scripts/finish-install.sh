#!/usr/bin/env bash
# Scelo IDE — finish the install on YOUR operating system.
#
# Why this exists: the Scelo IDE installer is three layers — the app code
# (identical on every OS), the Electron binary (per-OS), and a bundled
# Python + R runtime (per-OS). We publish a complete Linux installer, but
# Windows/macOS installers of the very latest build are produced on their own
# machines. This script does that "finish on your OS" step: it fetches the
# OS-specific pieces and either launches the IDE or builds a native installer.
#
# Usage (from the repo root, after cloning or downloading the source):
#   bash scripts/finish-install.sh            # build a native installer for this OS
#   bash scripts/finish-install.sh --run      # just install deps + runtime and launch
#
# Requirements:
#   • macOS / Linux: a normal shell.
#   • Windows: run inside Git Bash (the runtime stager is a bash script).
#   • Internet on first run (downloads Electron + the Python/R runtime).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="build"
[ "${1:-}" = "--run" ] && MODE="run"

# ─── 1. Detect the target OS ────────────────────────────────────────────
case "$(uname -s)" in
  Darwin*)              TARGET_OS=mac;   DIST=ide:dist:mac ;;
  Linux*)               TARGET_OS=linux; DIST=ide:dist:linux ;;
  MINGW*|MSYS*|CYGWIN*) TARGET_OS=win;   DIST=ide:dist:win ;;
  *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac
echo "▷ Finishing Scelo IDE install for: $TARGET_OS"

# ─── 2. Ensure bun (the package runner) is available ────────────────────
if ! command -v bun >/dev/null 2>&1; then
  echo "  ↓ Installing bun (https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
echo "  ✓ bun $(bun --version)"

# ─── 3. Install JS deps (pulls the OS's Electron binary) ────────────────
echo "  ↓ Installing dependencies (Electron for $TARGET_OS, native modules)"
bun install

# ─── 4. Stage the OS-specific Python + R runtime ────────────────────────
# bundle-runtimes.sh downloads a portable CPython + installs R for THIS OS,
# then resolves the IA actuarial package set into the bundle. First run can
# take a while (R compiles/installs a large package set).
echo "  ↓ Staging the Python + R runtime for $TARGET_OS (first run is slow)"
TARGET_OS="$TARGET_OS" bun run --cwd apps/scelo-ide bundle:runtime

# ─── 5. Build a native installer, or just run it ────────────────────────
if [ "$MODE" = "run" ]; then
  echo "  ▷ Launching the IDE (dev shell)…"
  bun run dev
else
  echo "  ▷ Building a native installer for $TARGET_OS…"
  bun run "$DIST"
  echo
  echo "✓ Done. Your installer is in: apps/scelo-ide/build/"
  ls -1 apps/scelo-ide/build/ 2>/dev/null | grep -Ei '\.(dmg|exe|appimage|deb)$' || true
fi
