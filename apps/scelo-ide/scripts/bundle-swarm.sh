#!/usr/bin/env bash
# Bundle the swarm (apps/swarm — council + society simulator) into
# resources/swarm/ so electron-builder ships it inside the installer and the
# IDE's main process can start it with the app.
#
#   resources/swarm/swarm-server[.exe]   ← `bun build --compile` of the Bun server
#                                          (single executable, Bun runtime + bun:sqlite inside)
#   resources/swarm/ui/                  ← the Vite-built client (index.html + assets),
#                                          served by that server on the same origin
#   resources/swarm/manifest.json        ← target, bun version, sizes, built_at
#
# One target per invocation — TARGET_OS=linux|mac|win, inferred from `uname`
# when unset — matching bundle-runtimes.sh. Bun cross-compiles, so any host
# can build any target. Idempotent: re-running overwrites.
#
# Why compile rather than ship `bun` + sources: one file, no runtime to
# locate at start-up, no node_modules to package, and the exact Bun that
# built it is the Bun that runs it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
SWARM_DIR="$REPO_ROOT/apps/swarm"
OUT_DIR="$APP_DIR/resources/swarm"

TARGET_OS="${TARGET_OS:-}"
if [ -z "$TARGET_OS" ]; then
  case "$(uname -s)" in
    Linux*)  TARGET_OS=linux ;;
    Darwin*) TARGET_OS=mac ;;
    MINGW*|MSYS*|CYGWIN*) TARGET_OS=win ;;
    *) echo "Unknown OS: $(uname -s)"; exit 1 ;;
  esac
fi

# Same architectures the Python runtime is staged for (bundle-runtimes.sh).
case "$TARGET_OS" in
  linux) BUN_TARGET="bun-linux-x64";   BIN_NAME="swarm-server" ;;
  mac)   BUN_TARGET="bun-darwin-arm64"; BIN_NAME="swarm-server" ;;
  win)   BUN_TARGET="bun-windows-x64"; BIN_NAME="swarm-server.exe" ;;
  *) echo "Unknown TARGET_OS: $TARGET_OS"; exit 1 ;;
esac

command -v bun >/dev/null 2>&1 || { echo "bun is required (https://bun.sh)"; exit 1; }

echo "▷ Bundling swarm for: $TARGET_OS ($BUN_TARGET)"
echo "  → $OUT_DIR"

mkdir -p "$OUT_DIR"

# ─── 1. Client (Vite) ──────────────────────────────────────────────────
echo "  ↓ Building swarm client (vite)"
(cd "$SWARM_DIR" && bun run build >/dev/null)
rm -rf "$OUT_DIR/ui"
cp -R "$SWARM_DIR/dist" "$OUT_DIR/ui"
echo "  ✓ Client at $OUT_DIR/ui"

# ─── 2. Server (single executable) ─────────────────────────────────────
echo "  ↓ Compiling swarm server ($BUN_TARGET)"
(cd "$SWARM_DIR" && bun build --compile --minify --target="$BUN_TARGET" \
  src/server/index.ts --outfile "$OUT_DIR/$BIN_NAME" >/dev/null)
chmod +x "$OUT_DIR/$BIN_NAME" 2>/dev/null || true
echo "  ✓ Server at $OUT_DIR/$BIN_NAME ($(du -h "$OUT_DIR/$BIN_NAME" | cut -f1))"

# ─── 3. Manifest ────────────────────────────────────────────────────────
bin_size=$(du -sb "$OUT_DIR/$BIN_NAME" 2>/dev/null | awk '{print $1}' || echo 0)
ui_size=$(du -sb "$OUT_DIR/ui" 2>/dev/null | awk '{print $1}' || echo 0)
cat > "$OUT_DIR/manifest.json" <<EOF
{
  "target_os": "$TARGET_OS",
  "bun_target": "$BUN_TARGET",
  "bun_version": "$(bun --version)",
  "server": { "file": "$BIN_NAME", "bytes": $bin_size },
  "ui": { "dir": "ui", "bytes": $ui_size },
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "  ✓ Wrote $OUT_DIR/manifest.json"
echo "▷ Swarm bundle ready."
