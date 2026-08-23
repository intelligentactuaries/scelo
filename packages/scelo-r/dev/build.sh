#!/usr/bin/env bash
# Document, build and check the R package from a clean state.
#   dev/build.sh            # roxygen → NAMESPACE + man/, R CMD build, R CMD check --no-manual
#   dev/build.sh install    # also install into the current library
# roxygen2 and testthat must be on the library path (R_LIBS_USER).
set -euo pipefail
cd "$(dirname "$0")/.."
Rscript -e 'roxygen2::roxygenise(".", roclets = c("rd", "namespace"))'
rm -f ../scelo_*.tar.gz
(cd .. && R CMD build --no-build-vignettes scelo-r)
tarball=$(ls -t ../scelo_*.tar.gz | head -1)
(cd .. && _R_CHECK_FORCE_SUGGESTS_=false R CMD check --no-manual --no-build-vignettes "$(basename "$tarball")")
if [ "${1:-}" = "install" ]; then R CMD INSTALL "$tarball"; fi
echo "built $tarball"
