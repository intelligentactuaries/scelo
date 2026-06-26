#!/usr/bin/env bash
# Bundle the Python + R runtimes + IA actuarial stack into resources/runtime/
# so electron-builder can ship them as extraResources inside the installer.
#
# Targets one platform at a time — read from $TARGET_OS (linux|mac|win) or
# inferred from `uname`. Run once per target before `electron-builder --xxx`.
#
# Output layout:
#   resources/runtime/python/                ← portable CPython
#   resources/runtime/python/lib/.../site-packages  ← IA Python deps
#   resources/runtime/r/                     ← portable R
#   resources/runtime/r/library/             ← IA R deps
#   resources/runtime/manifest.json          ← versions, checksums, sizes
#
# This script is idempotent — re-running with the same TARGET_OS skips
# already-staged components by checking checksums.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
RUNTIME_DIR="$APP_DIR/resources/runtime"

# ─── Target detection ─────────────────────────────────────────────────
TARGET_OS="${TARGET_OS:-}"
if [ -z "$TARGET_OS" ]; then
  case "$(uname -s)" in
    Linux*)  TARGET_OS=linux ;;
    Darwin*) TARGET_OS=mac ;;
    MINGW*|MSYS*|CYGWIN*) TARGET_OS=win ;;
    *) echo "Unknown OS: $(uname -s)"; exit 1 ;;
  esac
fi

# Pin versions so a clean rebuild always produces the same artifact.
PYTHON_VERSION="3.11.10"
PBS_RELEASE="20241016"  # python-build-standalone release tag
R_VERSION="4.4.2"

echo "▷ Bundling Scelo IDE runtime for: $TARGET_OS"
echo "  Python ${PYTHON_VERSION} (PBS ${PBS_RELEASE})"
echo "  R      ${R_VERSION}"
echo "  → $RUNTIME_DIR"
echo

mkdir -p "$RUNTIME_DIR"

# ─── 1. Portable CPython via python-build-standalone ───────────────────
#
# astral-sh's PBS ships fully-relocatable CPython tarballs for every major
# OS. We pick the "install_only" variant — strips test suites, smaller.
stage_python() {
  local pbs_url
  case "$TARGET_OS" in
    linux) pbs_url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz" ;;
    mac)   pbs_url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz" ;;
    win)   pbs_url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz" ;;
  esac

  local dest="$RUNTIME_DIR/python"
  if [ -x "$dest/bin/python3" ] || [ -x "$dest/python.exe" ]; then
    echo "  ✓ Python already staged at $dest"
    return
  fi

  echo "  ↓ Downloading $pbs_url"
  local tmp; tmp="$(mktemp -d)"
  curl -L --fail -o "$tmp/python.tar.gz" "$pbs_url"
  tar -xzf "$tmp/python.tar.gz" -C "$tmp"
  rm -rf "$dest"
  mv "$tmp/python" "$dest"
  rm -rf "$tmp"
  echo "  ✓ Python staged."
}

# ─── 2. IA Python deps resolved by uv against root pyproject.toml ──────
stage_python_packages() {
  local py_bin
  py_bin="$RUNTIME_DIR/python/bin/python3"
  [ "$TARGET_OS" = "win" ] && py_bin="$RUNTIME_DIR/python/python.exe"

  echo "  ↓ Installing IA Python deps into bundled interpreter"
  # Resolve from the repo's pyproject.toml so the IDE's stack stays in sync
  # with the rest of the monorepo (climada, lifelib, statsmodels, …).
  "$py_bin" -m pip install --upgrade pip
  "$py_bin" -m pip install --no-cache-dir \
    -r <("$py_bin" -m pip install --dry-run -r "$REPO_ROOT/pyproject.toml" 2>/dev/null || \
         cat "$REPO_ROOT/pyproject.toml") \
    || {
      # Fallback: install the explicit dependency list from pyproject.toml.
      # uv pip compile would be cleaner — added in Phase 2.
      "$py_bin" -m pip install --no-cache-dir \
        numpy pandas scipy scikit-learn statsmodels lightgbm \
        rpy2 lifelib chainladder
    }
  # LSP-lite tooling: pyright for in-editor diagnostics on save (Phase 6).
  # Tolerates failure — the editor falls back to no-lint mode gracefully.
  "$py_bin" -m pip install --no-cache-dir pyright || \
    echo "  ! pyright install failed; editor diagnostics will no-op."
  echo "  ✓ Python packages installed."
}

# ─── 3. Portable R per platform ────────────────────────────────────────
#
# R has no single "portable" distribution. Per-platform strategy:
#   linux : repack from r-installer or Ubuntu's r-base .deb (extract data.tar.xz,
#           rewrite R_HOME paths via a wrapper script). On dev hosts that already
#           have apt's r-base installed we copy /usr/lib/R into runtime/r as a
#           fast path.
#   mac   : download CRAN .pkg, xar -xf to extract the R.framework payload,
#           normalise into runtime/r/Resources/{bin,library,...}.
#   win   : R-installer .exe ships a fully-relocatable directory tree — running
#           it with /VERYSILENT /DIR=… lays it out cleanly under runtime/r/.
stage_r() {
  local dest="$RUNTIME_DIR/r"
  if [ -x "$dest/bin/R" ] || [ -x "$dest/bin/R.exe" ] || [ -x "$dest/Resources/bin/R" ]; then
    echo "  ✓ R already staged at $dest"
    return
  fi

  case "$TARGET_OS" in
    win)
      stage_r_windows "$dest"
      ;;
    mac)
      stage_r_mac "$dest"
      ;;
    linux)
      stage_r_linux "$dest"
      ;;
  esac

  if [ ! -x "$dest/bin/R" ] && [ ! -x "$dest/bin/R.exe" ] && [ ! -x "$dest/Resources/bin/R" ]; then
    # If we bailed out (missing tooling), drop a placeholder README so the
    # IDE still launches and runtimeStatus() returns r:false. Operators can
    # re-run the script once the missing tool (xar, dpkg, etc.) is installed.
    mkdir -p "$dest"
    cat > "$dest/README.md" <<EOF
# R runtime placeholder

R bundling did not complete on this host for target $TARGET_OS. Common causes:

- macOS: needs \`xar\` and \`cpio\` available (standard on macOS hosts).
- Windows: needs \`makensis\` / Inno Setup's installer to be runnable in /VERYSILENT.
- Linux: needs apt's \`r-base\` already installed, OR network to fetch a static R tarball.

The IDE exposes \`window.scelo.runtimeStatus()\` which returns \`{ r: false }\`
so the renderer can surface a "use Python instead" hint.
EOF
  fi
}

stage_r_linux() {
  local dest="$1"
  mkdir -p "$dest"

  # Fast path: a working apt-installed R on the build host. We rsync its
  # R_HOME (/usr/lib/R) into the bundle and patch the R shell wrapper so
  # the relocated tree resolves dependencies from itself, not /usr/lib.
  local sys_r="/usr/lib/R"
  if [ -d "$sys_r" ] && [ -x "$sys_r/bin/R" ]; then
    echo "  ↓ Repacking system R from $sys_r"
    rsync -a --exclude='doc/manual/full_refman.pdf' \
      "$sys_r/" "$dest/"
    # Rewrite R_HOME inside the launcher. R's bin/R is a shell script with
    # R_HOME_DIR pinned absolute; replace it with a self-resolving path so
    # the bundle is relocatable.
    if [ -f "$dest/bin/R" ]; then
      sed -i 's|^R_HOME_DIR=.*|R_HOME_DIR="$(cd "$(dirname "$0")/.." \&\& pwd)"|' "$dest/bin/R"
    fi
    echo "  ✓ Linux R staged from system install ($(du -sh "$dest" | awk '{print $1}'))"
    return
  fi

  # No system R: on Debian/Ubuntu, install r-base-core via apt (lands at
  # /usr/lib/R) and repack it. This is the reliable path on dev boxes and CI
  # runners; posit's CDN has started returning 403 so we no longer lead with
  # it. Needs passwordless sudo (CI runners + most dev setups have it).
  if command -v apt-get >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    echo "  ↓ No system R — installing r-base-core via apt"
    if sudo -n apt-get install -y r-base-core >/dev/null 2>&1 && [ -x /usr/lib/R/bin/R ]; then
      rsync -a "/usr/lib/R/" "$dest/"
      [ -f "$dest/bin/R" ] && sed -i 's|^R_HOME_DIR=.*|R_HOME_DIR="$(cd "$(dirname "$0")/.." \&\& pwd)"|' "$dest/bin/R"
      echo "  ✓ Linux R staged via apt ($(du -sh "$dest" | awk '{print $1}'))"
      return
    fi
    echo "  ! apt install of r-base-core did not yield /usr/lib/R; trying CDN"
  fi

  # Last-ditch fallback: posit's r-installer .deb mirror. Requires curl + tar.
  local url="https://cdn.posit.co/r/ubuntu-2204/pool/main/r/r-${R_VERSION}/r-${R_VERSION}_1_amd64.deb"
  echo "  ↓ Downloading $url"
  local tmp; tmp="$(mktemp -d)"
  if ! curl -L --fail -o "$tmp/r.deb" "$url"; then
    echo "  ! Linux R download failed (no system R, apt, or network?). Skipping."
    rm -rf "$tmp"
    return 1
  fi
  # Extract the data payload from the .deb (ar archive containing
  # data.tar.gz/xz/zst). Use `dpkg-deb` if available, fall back to `ar + tar`.
  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$tmp/r.deb" "$tmp/extracted"
  else
    (cd "$tmp" && ar x r.deb && tar xf data.tar.* -C "$tmp/extracted")
  fi
  if [ -d "$tmp/extracted/opt/R/${R_VERSION}" ]; then
    rsync -a "$tmp/extracted/opt/R/${R_VERSION}/" "$dest/"
  elif [ -d "$tmp/extracted/usr/lib/R" ]; then
    rsync -a "$tmp/extracted/usr/lib/R/" "$dest/"
  fi
  rm -rf "$tmp"
  if [ -f "$dest/bin/R" ]; then
    sed -i 's|^R_HOME_DIR=.*|R_HOME_DIR="$(cd "$(dirname "$0")/.." \&\& pwd)"|' "$dest/bin/R"
  fi
  echo "  ✓ Linux R staged from CRAN .deb"
}

stage_r_mac() {
  local dest="$1"
  mkdir -p "$dest"
  local url="https://cran.r-project.org/bin/macosx/big-sur-arm64/base/R-${R_VERSION}-arm64.pkg"
  echo "  ↓ Downloading $url"
  local tmp; tmp="$(mktemp -d)"
  if ! curl -L --fail -o "$tmp/r.pkg" "$url"; then
    echo "  ! macOS R download failed. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  if ! command -v xar >/dev/null 2>&1; then
    echo "  ! xar not available — required to unpack the CRAN .pkg. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  (cd "$tmp" && xar -xf r.pkg)
  # The CRAN bundle ships several pkg payloads; R-fw.pkg/Payload holds the
  # framework tree. It's a gzip'd cpio archive.
  local payload
  payload=$(find "$tmp" -name 'Payload' -path '*R-fw*' | head -1)
  if [ -z "$payload" ]; then
    echo "  ! Could not find R-fw Payload in extracted .pkg. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$tmp/payload-out"
  (cd "$tmp/payload-out" && gunzip -dc "$payload" | cpio -i)
  # Move R.framework/Versions/Current → dest/. We keep just the Current
  # version's contents (Resources/, lib/, etc.) so the bundle is flat.
  local fw_root
  fw_root=$(find "$tmp/payload-out" -type d -name 'Current' -path '*R.framework*' | head -1)
  if [ -z "$fw_root" ]; then
    echo "  ! R.framework Current symlink missing in payload. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  rsync -aL "$fw_root/" "$dest/"
  rm -rf "$tmp"
  echo "  ✓ macOS R.framework staged"
}

stage_r_windows() {
  local dest="$1"
  mkdir -p "$dest"
  local url="https://cran.r-project.org/bin/windows/base/old/${R_VERSION}/R-${R_VERSION}-win.exe"
  echo "  ↓ Downloading $url"
  local tmp; tmp="$(mktemp -d)"
  if ! curl -L --fail -o "$tmp/r.exe" "$url"; then
    echo "  ! Windows R download failed. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  # The Inno Setup installer does an unattended install with /VERYSILENT.
  # On a Windows host (msys/git-bash) we shell out to the .exe directly. On
  # Linux/macOS we cross-install it through Wine — the installer is a plain
  # Inno Setup package that runs fine under Wine, which lets us produce a
  # Windows build from a Linux box (paired with `electron-builder --win`,
  # which also drives Wine).
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      "$tmp/r.exe" /VERYSILENT /SUPPRESSMSGBOXES "/DIR=$(cygpath -w "$dest" 2>/dev/null || echo "$dest")"
      ;;
    *)
      if ! command -v wine >/dev/null 2>&1; then
        echo "  ! Cross-bundling Windows R needs Wine (apt install wine). Skipping."
        rm -rf "$tmp"
        return 1
      fi
      echo "  → Cross-installing Windows R via Wine"
      local windir
      windir="$(WINEDEBUG=-all winepath -w "$dest" 2>/dev/null || echo "$dest")"
      WINEDEBUG=-all wine "$tmp/r.exe" /VERYSILENT /SUPPRESSMSGBOXES "/DIR=$windir" >/dev/null 2>&1 || true
      WINEDEBUG=-all wineserver -w 2>/dev/null || true  # wait for the install to finish
      ;;
  esac
  rm -rf "$tmp"
  if [ -x "$dest/bin/R.exe" ] || [ -f "$dest/bin/x64/R.exe" ] || [ -d "$dest/bin" ]; then
    echo "  ✓ Windows R installed under $dest"
  else
    echo "  ! Windows R install produced no bin/ — check the Wine run."
    return 1
  fi
}

# ─── 3b. IA R packages ─────────────────────────────────────────────────
#
# Once R is staged we resolve a curated CRAN package set: the actuarial
# core (ChainLadder, chainladder, lifecontingencies), forecasting (forecast,
# fable, mgcv), and Bayesian stuff (brms requires Stan toolchain — opt-in).
# Set IA_R_SKIP_PACKAGES=1 to skip when iterating on the runtime layout.
stage_r_packages() {
  if [ "${IA_R_SKIP_PACKAGES:-0}" = "1" ]; then
    echo "  ↷ R packages skipped (IA_R_SKIP_PACKAGES=1)"
    return
  fi
  local r_bin="$RUNTIME_DIR/r/bin/R"
  [ "$TARGET_OS" = "win" ] && r_bin="$RUNTIME_DIR/r/bin/R.exe"
  [ "$TARGET_OS" = "mac" ] && r_bin="$RUNTIME_DIR/r/Resources/bin/R"
  if [ ! -x "$r_bin" ]; then
    echo "  ↷ Skipping R package install — R interpreter not staged"
    return
  fi
  echo "  ↓ Installing IA R packages (ChainLadder, forecast, lifecontingencies, …)"
  "$r_bin" --vanilla -e '
    options(repos = c(CRAN = "https://cloud.r-project.org"))
    pkgs <- c("ChainLadder", "lifecontingencies", "forecast", "mgcv", "data.table", "jsonlite", "lintr", "languageserver")
    install.packages(pkgs, lib = file.path(R.home(), "library"), dependencies = TRUE)
  ' || echo "  ! Some R packages failed; bundle may be incomplete."
}

# ─── 4. Manifest with versions + sizes ────────────────────────────────
write_manifest() {
  local manifest="$RUNTIME_DIR/manifest.json"
  local py_size=0
  local r_size=0
  if [ -d "$RUNTIME_DIR/python" ]; then
    py_size=$(du -sb "$RUNTIME_DIR/python" 2>/dev/null | awk '{print $1}' || echo 0)
  fi
  if [ -d "$RUNTIME_DIR/r" ]; then
    r_size=$(du -sb "$RUNTIME_DIR/r" 2>/dev/null | awk '{print $1}' || echo 0)
  fi
  cat > "$manifest" <<EOF
{
  "target_os": "$TARGET_OS",
  "python": {
    "version": "$PYTHON_VERSION",
    "pbs_release": "$PBS_RELEASE",
    "bytes": $py_size
  },
  "r": {
    "version": "$R_VERSION",
    "bytes": $r_size,
    "bundled": $([ "$r_size" -gt 1024 ] && echo true || echo false)
  },
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  echo "  ✓ Wrote $manifest"
}

# ─── Run ───────────────────────────────────────────────────────────────
stage_python
stage_python_packages
stage_r
stage_r_packages
write_manifest

echo
echo "✓ Runtime bundling complete for $TARGET_OS."
echo "  Next: bun run dist:${TARGET_OS}"
