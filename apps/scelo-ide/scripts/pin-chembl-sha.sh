#!/usr/bin/env bash
# pin-chembl-sha.sh — fetch the upstream SHA-256 digest for the
# ChEMBL SQLite tarball and rewrite the DATASETS entry in main.ts.
#
# EMBL-EBI publishes a checksums.txt file alongside each release in the
# same FTP directory as the archive. We pull it, validate the sha256
# for our archive, and patch the registry. Run this before each ship of
# the IDE so the bundled checksum tracks whatever was last released.
#
# Usage:
#   bash apps/scelo-ide/scripts/pin-chembl-sha.sh
#
# Exits nonzero (and leaves main.ts untouched) if the upstream digest
# can't be fetched or doesn't match the documented shape — the existing
# placeholder stays put so a downstream build fails loud, not silent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_TS="$SCRIPT_DIR/../src/main.ts"
CHEMBL_VERSION="${CHEMBL_VERSION:-34}"
ARCHIVE_NAME="chembl_${CHEMBL_VERSION}_sqlite.tar.gz"
BASE_URL="https://ftp.ebi.ac.uk/pub/databases/chembl/ChEMBLdb/releases/chembl_${CHEMBL_VERSION}"
SHA_URL="${BASE_URL}/checksums.txt"

echo "▷ Fetching ${SHA_URL}"
SHA_BODY="$(curl -fsSL "$SHA_URL")" || {
  echo "! upstream sha file unreachable; leaving main.ts placeholder unchanged" >&2
  exit 2
}

# checksums.txt format is two columns: `<sha256>  <filename>`.
# Find the line that ends with our archive's basename.
SHA="$(echo "$SHA_BODY" | awk -v f="$ARCHIVE_NAME" '$2 == f { print $1 }')"
if [ -z "$SHA" ] || [ "${#SHA}" -ne 64 ]; then
  echo "! ${ARCHIVE_NAME} not found in ${SHA_URL}, or sha length != 64" >&2
  echo "  Got: '${SHA}'" >&2
  exit 3
fi

echo "  ✓ ${ARCHIVE_NAME} sha256: ${SHA:0:12}…"

# Sanity check: make sure DATASETS already has a chembl entry to patch.
if ! grep -q '"chembl"' "$MAIN_TS"; then
  echo "! no chembl entry in $MAIN_TS — refusing to patch" >&2
  exit 4
fi

# Surgical replace of the expectedSha256 line inside the chembl block.
# We rely on the registry's stable formatting; the comment line that
# follows is preserved.
python3 - "$MAIN_TS" "$SHA" <<'PY'
import re, sys, pathlib
path, sha = sys.argv[1], sys.argv[2]
src = pathlib.Path(path).read_text()
# Match the chembl block's expectedSha256 line specifically: anchor to
# `id: "chembl"` first so we don't accidentally patch other entries if
# they ever grow an expectedSha256.
pat = re.compile(
    r'(id:\s*"chembl"[\s\S]*?expectedSha256:\s*)"[0-9a-fA-F]*"',
)
new_src, n = pat.subn(rf'\1"{sha}"', src)
if n != 1:
    print(f"! expected exactly 1 expectedSha256 replacement in chembl block, got {n}", file=sys.stderr)
    sys.exit(5)
pathlib.Path(path).write_text(new_src)
print(f"  ✓ patched {path}")
PY

echo "  ✓ done — re-build the IDE; the next download will verify against ${SHA:0:12}…"
