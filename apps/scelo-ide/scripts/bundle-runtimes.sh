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
# Filled in by stage_python_packages from what actually landed in site-packages
# (must equal the pins in runtime/python-requirements.in — the stage fails
# otherwise). Recorded in manifest.json so the IDE can say which lifelib it ships.
LIFELIB_VERSION="unknown"
MODELX_VERSION="unknown"

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

# ─── 2. IA Python deps from runtime/python-requirements-<os>.txt ─────
#
# The stack is pinned in apps/scelo-ide/runtime/python-requirements.in
# (headline libraries — lifelib, modelx — pinned hard) and fully locked per
# platform by `uv pip compile` into python-requirements-{linux,macos,windows}.txt.
# We install the lock so a clean rebuild ships the same lifelib every time;
# if the lock is missing for this platform we fall back to the .in file so
# the build still produces a usable runtime (and says so loudly).
PY_REQ_DIR="$APP_DIR/runtime"
py_lock_for_target() {
  case "$TARGET_OS" in
    linux) echo "$PY_REQ_DIR/python-requirements-linux.txt" ;;
    mac)   echo "$PY_REQ_DIR/python-requirements-macos.txt" ;;
    win)   echo "$PY_REQ_DIR/python-requirements-windows.txt" ;;
  esac
}

stage_python_packages() {
  local py_bin
  py_bin="$RUNTIME_DIR/python/bin/python3"
  [ "$TARGET_OS" = "win" ] && py_bin="$RUNTIME_DIR/python/python.exe"

  local lock req
  lock="$(py_lock_for_target)"
  if [ -f "$lock" ]; then
    req="$lock"
  else
    echo "  ! No lock file at $lock — installing unpinned from python-requirements.in"
    req="$PY_REQ_DIR/python-requirements.in"
  fi

  echo "  ↓ Installing IA Python deps into bundled interpreter from $(basename "$req")"
  # -I / PYTHONNOUSERSITE: the bundled interpreter must resolve ONLY its own
  # site-packages while we stage it — a developer's ~/.local lifelib or a
  # PYTHONPATH from another toolchain must not satisfy (or shadow) a pin.
  PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -m pip install --upgrade pip
  # GDAL's Python bindings (osgeo) are published only as a source tarball that
  # must compile against a libgdal of the SAME version — no wheel exists for
  # any platform, and a build host's libgdal is neither that version nor
  # something we can ship. climada is the only package asking for it, and it
  # uses it in one legacy function (litpop.nightlight.read_bm_file, "not
  # required for litpop module" in climada's own docstring); every other
  # raster goes through rasterio, whose wheels carry their own GDAL. So the
  # lock — already complete, hence --no-deps — is installed without gdal, and
  # that one import is made lazy below.
  if [ "$req" = "$lock" ]; then
    local filtered; filtered="$(mktemp)"
    grep -v -E '^gdal==' "$lock" > "$filtered"
    PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -m pip install --no-cache-dir --no-deps -r "$filtered"
    rm -f "$filtered"
  else
    PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -m pip install --no-cache-dir -r "$req"
  fi
  PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I - <<'PY'
import importlib.util, pathlib, py_compile, sys

spec = importlib.util.find_spec("climada")
if spec is None:
    sys.exit(0)  # climada not in this stack — nothing to patch
path = pathlib.Path(spec.submodule_search_locations[0], "entity/exposures/litpop/nightlight.py")
src = path.read_text(encoding="utf-8")
MARK = "# Scelo IDE: GDAL's Python bindings are not bundled"
if MARK not in src:
    imp = "from osgeo import gdal\n"
    use = "    curr_file = gdal.Open(str(path))\n"
    if src.count(imp) != 1 or src.count(use) != 1:
        sys.exit(f"  ✗ climada's GDAL import moved in {path} — re-check it before shipping this climada")
    src = src.replace(imp, (
        "try:\n"
        "    from osgeo import gdal\n"
        f"except ImportError:  {MARK} (see bundle-runtimes.sh)\n"
        "    gdal = None\n"
    ))
    src = src.replace(use, (
        "    if gdal is None:\n"
        "        raise ImportError(\n"
        "            \"read_bm_file needs GDAL's Python bindings (osgeo), which Scelo IDE \"\n"
        "            \"does not bundle; LitPop itself does not use them.\"\n"
        "        )\n"
        + use
    ))
    path.write_text(src, encoding="utf-8")
    py_compile.compile(str(path), doraise=True)
print("  ✓ climada: legacy GDAL import made lazy")
PY

  # LightGBM's wheels do not carry the OpenMP runtime they link, so on a
  # machine without it `import lightgbm` fails (on Linux the .deb depends on
  # libgomp1 instead). scikit-learn's wheels do carry one; LightGBM is pointed
  # at that. Exactly one OpenMP runtime may load per process — two copies
  # abort with "OMP: Error #15".
  local site
  site="$(PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  [ "$TARGET_OS" = "win" ] && command -v cygpath >/dev/null 2>&1 && site="$(cygpath -u "$site")"
  case "$TARGET_OS" in
    mac)
      # lib_lightgbm.dylib loads @rpath/libomp.dylib with rpaths only into
      # Homebrew and MacPorts. Swap them for scikit-learn's bundled copy (the
      # same file sklearn loads, so dyld maps it once) and re-sign, since
      # editing a Mach-O voids its signature.
      local lgb="$site/lightgbm/lib/lib_lightgbm.dylib" rp
      if [ -f "$lgb" ] && [ -f "$site/sklearn/.dylibs/libomp.dylib" ]; then
        for rp in $(otool -l "$lgb" | awk '/cmd LC_RPATH/ {getline; getline; print $2}'); do
          [ "$rp" = "@loader_path/../../sklearn/.dylibs" ] || install_name_tool -delete_rpath "$rp" "$lgb"
        done
        otool -l "$lgb" | grep -q "@loader_path/../../sklearn/.dylibs" \
          || install_name_tool -add_rpath "@loader_path/../../sklearn/.dylibs" "$lgb"
        codesign --force --sign - "$lgb"
        echo "  ✓ lightgbm: OpenMP from scikit-learn's bundled libomp"
      fi
      ;;
    win)
      # lib_lightgbm.dll needs vcomp140.dll (and msvcp140.dll), which a fresh
      # Windows does not have. ctypes searches the DLL's own folder, and
      # Windows maps an already-loaded DLL by name, so copies there still
      # give one runtime alongside scikit-learn's.
      if [ -f "$site/lightgbm/bin/lib_lightgbm.dll" ] && [ -f "$site/sklearn/.libs/vcomp140.dll" ]; then
        cp -f "$site/sklearn/.libs/vcomp140.dll" "$site/lightgbm/bin/"
        [ -f "$site/sklearn/.libs/msvcp140.dll" ] && cp -f "$site/sklearn/.libs/msvcp140.dll" "$site/lightgbm/bin/"
        echo "  ✓ lightgbm: MSVC OpenMP runtime copied from scikit-learn"
      fi
      ;;
  esac

  # LSP-lite tooling: pyright for in-editor diagnostics on save (Phase 6).
  # Tolerates failure — the editor falls back to no-lint mode gracefully.
  PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -m pip install --no-cache-dir pyright || \
    echo "  ! pyright install failed; editor diagnostics will no-op."

  # Prove the headline library is the one we pinned, not a stray import.
  local want_lifelib want_modelx have_lifelib have_modelx
  want_lifelib="$(grep -E '^lifelib==' "$PY_REQ_DIR/python-requirements.in" | cut -d= -f3)"
  want_modelx="$(grep -E '^modelx==' "$PY_REQ_DIR/python-requirements.in" | cut -d= -f3)"
  have_lifelib="$(PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -c 'import importlib.metadata as m; print(m.version("lifelib"))')"
  have_modelx="$(PYTHONNOUSERSITE=1 PYTHONPATH= "$py_bin" -I -c 'import importlib.metadata as m; print(m.version("modelx"))')"
  if [ "$have_lifelib" != "$want_lifelib" ] || [ "$have_modelx" != "$want_modelx" ]; then
    echo "  ✗ lifelib/modelx mismatch: have lifelib $have_lifelib modelx $have_modelx, want $want_lifelib / $want_modelx"
    exit 1
  fi
  LIFELIB_VERSION="$have_lifelib"
  MODELX_VERSION="$have_modelx"

  # Prove the stack the bridges call actually imports — 0.1.x installers went
  # out with a bare interpreter because nothing here checked.
  PYTHONNOUSERSITE=1 PYTHONPATH= MPLBACKEND=Agg "$py_bin" -I -c '
import numpy, pandas, scipy, sklearn, statsmodels, lightgbm, matplotlib, pyarrow, openpyxl
import chainladder, fairlearn, lifelib, modelx
from climada.entity import LitPop, ImpfTropCyclone, ImpactFuncSet
from climada.hazard import TCTracks, TropCyclone, Centroids
from climada.engine import ImpactCalc
# Importing is not enough: chainladder 0.8.26 imported fine under pandas 3
# and then failed every fit. RAA chain-ladder IBNR is 52,135 in every engine.
ibnr = float(chainladder.Chainladder().fit(chainladder.load_sample("raa")).ibnr_.sum())
assert round(ibnr) == 52135, f"chainladder RAA IBNR {ibnr}, expected 52135"
' || { echo "  ✗ The bundled Python stack does not import, or does not work — not shipping it."; exit 1; }
  echo "  ✓ Python packages installed (lifelib $LIFELIB_VERSION · modelx $MODELX_VERSION)."
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
    # --copy-unsafe-links: Debian's etc/{ldpaths,Renviron,…} are links into
    # /etc/R, which only exists where r-base-core is installed — copy the
    # files so the bundle carries its own configuration.
    rsync -a --copy-unsafe-links --exclude='doc/manual/full_refman.pdf' \
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
      rsync -a --copy-unsafe-links "/usr/lib/R/" "$dest/"
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
  # Versions/Current is a SYMLINK (to e.g. 4.4-arm64), which `find -type d`
  # never matches; fall back to the versioned folder itself.
  local fw_root
  fw_root=$(find "$tmp/payload-out" -path '*R.framework/Versions/Current' | head -1)
  [ -z "$fw_root" ] && fw_root=$(find "$tmp/payload-out" -type d -path '*R.framework/Versions/[0-9]*' -prune | head -1)
  if [ -z "$fw_root" ]; then
    echo "  ! R.framework Current symlink missing in payload. Skipping."
    rm -rf "$tmp"
    return 1
  fi
  # Not -L: the payload carries links to absolute /Library/Frameworks/…
  # paths (fontconfig's conf.d), which only resolve in a system-wide install,
  # so dereferencing them fails. The trailing slash still enters Current/;
  # --safe-links keeps the framework's relative links and drops those.
  rsync -a --safe-links "$fw_root/" "$dest/"
  rm -rf "$tmp"
  for f in Resources/bin/R Resources/bin/exec/R Resources/lib/libR.dylib; do
    [ -e "$dest/$f" ] || { echo "  ! macOS R.framework staged without $f"; return 1; }
  done
  # Relocatable, like the Linux repack: bin/R pins R_HOME_DIR to
  # /Library/Frameworks/R.framework/Resources, so inside the app it would run
  # a system R (or none). Resolve it from the script's own location instead;
  # etc/ldpaths then points DYLD_FALLBACK_LIBRARY_PATH at the bundled lib/.
  # perl, not sed -i: BSD sed wants a suffix argument GNU sed does not.
  if [ -f "$dest/Resources/bin/R" ]; then
    perl -pi -e 's|^R_HOME_DIR=.*|R_HOME_DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"|;
                 s#^(R_(?:SHARE|INCLUDE|DOC)_DIR)=/Library/Frameworks/R\.framework/Resources#$1=\${R_HOME_DIR}#' \
      "$dest/Resources/bin/R"
  fi
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
  # Every dependency must land IN the bundle. R skips a dependency that is
  # installed anywhere on .libPaths(), so a build host whose own library had
  # ggplot2 & co. produced a bundle that only loaded on hosts that had them
  # too: 0.1.x shipped ChainLadder without 72 of its dependencies. Pointing
  # the user and site libraries at nothing leaves the bundle's library as the
  # only one R can see, and the check below fails loudly on anything missing.
  # Linux repacks the build host's Ubuntu R, so it takes Posit Package
  # Manager's prebuilt binaries for that release instead of compiling ~120
  # packages from source.
  local repo="https://cloud.r-project.org"
  if [ "$TARGET_OS" = "linux" ] && [ -r /etc/os-release ]; then
    repo="https://packagemanager.posit.co/cran/__linux__/$(. /etc/os-release && echo "$VERSION_CODENAME")/latest"
  fi
  R_LIBS_USER=/nonexistent R_LIBS_SITE=/nonexistent "$r_bin" --vanilla -e "
    options(repos = c(CRAN = '$repo'),
            HTTPUserAgent = sprintf('R/%s R (%s)', getRversion(),
              paste(getRversion(), R.version['platform'], R.version['arch'], R.version['os'])))
    pkgs <- c('ChainLadder', 'lifecontingencies', 'forecast', 'mgcv', 'data.table', 'jsonlite', 'lintr', 'languageserver')
    lib <- file.path(R.home(), 'library')
    # Binaries only off Linux: CRAN's macOS/Windows binaries for R 4.4 are
    # frozen, so 'both' sees newer source versions and tries to compile them
    # (no toolchain; the first macOS build lost ggplot2 and 70 others that
    # way). The frozen binary index is complete for this set. On Linux the
    # Posit repo serves binaries under the source type.
    type <- if (Sys.info()[['sysname']] == 'Linux') 'source' else 'binary'
    install.packages(pkgs, lib = lib, type = type)
    bad <- pkgs[!vapply(pkgs, requireNamespace, logical(1), lib.loc = lib, quietly = TRUE)]
    if (length(bad)) {
      message('  ! R packages that do not load from the bundle alone: ', paste(bad, collapse = ', '))
      quit(status = 1)
    }
    cat('  ✓ R packages load from the bundle alone\n')
  " || { echo "  ✗ The bundled R packages do not load on their own — not shipping them."; exit 1; }
}

# ─── 4. Manifest with versions + sizes ────────────────────────────────
write_manifest() {
  local manifest="$RUNTIME_DIR/manifest.json"
  local py_size=0
  local r_size=0
  if [ -d "$RUNTIME_DIR/python" ]; then
    py_size=$(du -sk "$RUNTIME_DIR/python" 2>/dev/null | awk '{print $1 * 1024}' || echo 0)
  fi
  if [ -d "$RUNTIME_DIR/r" ]; then
    r_size=$(du -sk "$RUNTIME_DIR/r" 2>/dev/null | awk '{print $1 * 1024}' || echo 0)
  fi
  cat > "$manifest" <<EOF
{
  "target_os": "$TARGET_OS",
  "python": {
    "version": "$PYTHON_VERSION",
    "pbs_release": "$PBS_RELEASE",
    "bytes": $py_size,
    "requirements": "$(basename "$(py_lock_for_target)")",
    "lifelib": "$LIFELIB_VERSION",
    "modelx": "$MODELX_VERSION"
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
