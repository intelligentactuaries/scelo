# Install & set up

Both libraries live in the [`intelligentactuaries/scelo`](https://github.com/intelligentactuaries/scelo)
repository, in `packages/scelo-py` and `packages/scelo-r`, and install from a
checkout in one command each. They are deliberately light: the Python core
needs numpy and pandas alone; the R package needs base R alone.

## Python

```bash
pip install scelo
```

[`scelo` on PyPI](https://pypi.org/project/scelo/). Python 3.9+ on any
OS. Two other routes to the same thing:

```bash
# straight from GitHub
pip install "scelo @ git+https://github.com/intelligentactuaries/scelo#subdirectory=packages/scelo-py"

# from a repository checkout
git clone https://github.com/intelligentactuaries/scelo
pip install scelo/packages/scelo-py
```

### Extras

The core installs numpy + pandas only. Everything statistical has a pure
numpy implementation, and upgrades itself when the optional packages are
present:

| Extra | Adds | Unlocks |
|---|---|---|
| `scelo[stats]` | scipy, statsmodels | GLMs via statsmodels (the numpy GLM agrees to 1e-5), scipy distribution fits |
| `scelo[life]` | lifelib 0.14.0, modelx 0.32.0, openpyxl | `sc.lifelib_run()` — the real lifelib models, the pair Scelo IDE ships |
| `scelo[reserving]` | chainladder | cross-checks against the chainladder package |
| `scelo[io]` | pyarrow, openpyxl | parquet and Excel in `sc.load()` / `sc.export()` |
| `scelo[viz]` | matplotlib | the `sc.plot_*` chart family |
| `scelo[all]` | all of the above | |
| `scelo[dev]` | pytest + the working set | `pytest` runs the golden-value suite |

```bash
pip install "scelo[stats,viz]"
```

## R

```r
install.packages("scelo", repos = c("https://intelligentactuaries.com/r", getOption("repos")))
library(scelo)
```

That is the lab's own CRAN-style repository at
[intelligentactuaries.com/r](https://intelligentactuaries.com/r) — CRAN
itself requires an open-source licence, so the package is distributed
from there and from GitHub instead. The package is pure R, so the source
install works on Windows, macOS and Linux without build tools. Two other
routes to the same thing:

```r
# straight from GitHub
install.packages("remotes")
remotes::install_github("intelligentactuaries/scelo", subdir = "packages/scelo-r")

# from a repository checkout
install.packages("scelo/packages/scelo-r", repos = NULL, type = "source")
```

R ≥ 4.1. The package imports nothing beyond `stats`, `utils` and `tools`,
so it installs on a bare R. Optional packages add extras rather than
gate the basics:

| Package | Unlocks |
|---|---|
| `jsonlite`, `curl` | the swarm client (`sc_council`, `sc_society`, `sc_augment`) |
| `statmod` | Tweedie GLMs in `sc_glm()` |
| `reticulate` | `sc_lifelib_run()` — lifelib models through Python |
| `testthat` | `tests/` — the parity suite against the Python goldens |

## Inside Scelo IDE

Scelo IDE bundles its own CPython and R. The libraries run on both as they
are: open the IDE terminal and run the same `pip install` /
`install.packages()` lines against the bundled runtimes. Everything the
libraries compute matches what the IDE's own panels compute, down to the
random stream — that is the point of them.

## The swarm (optional)

`sc.wmtr` / `sc_wmtr` need **no server**: the W(M, T, R) engine is ported
into each library. The deliberation functions — `sc.council`,
`sc.society`, `sc.augment` and friends — talk to the Scelo swarm, a local
Bun server:

- **Scelo IDE 0.1.6+** starts it automatically on `127.0.0.1:3010` while
  the app is open — nothing to do.
- From a repository checkout, `bun run dev:swarm` starts the same server.
- `sc.connect("http://host:3010")` / `sc_connect("http://host:3010")`
  points the client somewhere else.

Without a reachable swarm those functions say so and stop; nothing else in
the libraries depends on it.

## Check the install

```python
import scelo as sc
sc.life_table().head(3)     # prints the table, its basis and its caveats
sc.cheatsheet()             # the one-screen map of everything
```

```r
library(scelo)
sc_life_table()[1:3, ]
sc_cheatsheet()
```

If the life table prints with its basis line and notes underneath, the
library is working. The illustrative Gompertz–Makeham warning in those
notes is not an error — it is the library telling you, as it always will,
what basis produced the numbers you are looking at.
