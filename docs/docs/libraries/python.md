# Python notes

```bash
pip install "scelo @ git+https://github.com/intelligentactuaries/scelo#subdirectory=packages/scelo-py"
```

Python ≥ 3.9, numpy + pandas only in the core; the
[extras](install.md#extras) add statsmodels/scipy, lifelib, matplotlib,
parquet/Excel I/O. The package lives at
[`packages/scelo-py`](https://github.com/intelligentactuaries/scelo/tree/main/packages/scelo-py)
and runs as-is on the CPython Scelo IDE bundles.

## Idioms

**The accessor.** Importing scelo registers `df.sc`, so every frame-first
function is also a method — handy for people who chain:

```python
import scelo as sc
df.sc.profile()
df.sc.clean("all")
df.sc.triangle().sc.mack()
```

**Tables are DataFrames.** A [`Table`](table.md) subclasses
`pandas.DataFrame`; slicing keeps the title, basis and notes, `.df`
strips them, `.note("reviewed")` appends one. In Jupyter, a Table renders
as the usual HTML frame with its notes beneath.

**Results are dataclasses.** `mack(...)` → a `ReservingResult`
(`.table .ibnr .se .detail`), `glm(...)` → a `GLMResult`
(`.coef .predict() .relativities()`), `wmtr(...)` → a `WmtrResult`
(`.table .survival .drivers`), each printing a one-line headline before
its table.

**Charts return figures.** Every `plot_*` returns the figure (no pyplot
state): show it by being the last expression in a cell, save it with
`fig.savefig(...)` or `sc.save_figure(fig, "out.png")`.

**Optional dependencies degrade, loudly or gracefully — never silently
wrongly.** Without statsmodels the GLM falls back to a numpy IRLS tested
to agree to 1e-5 (the model header names the engine used). Without scipy
the risk module uses numpy fallbacks. Without matplotlib, `plot_*` says
`charts need matplotlib: pip install matplotlib`. Without lifelib,
`lifelib_run` points you at `pip install "scelo[life]"` — and
`basicterm` / `scr_life` / `csm` never needed it.

**Determinism.** Everything simulated is seeded by default —
`bootstrap`, `hull_white`, `aggregate_loss`, and the WMTR engine (whose
Mulberry32 stream is bit-exact with the IDE). Rerunning a script
reproduces the pack.

## Testing

```bash
pip install "scelo[dev]" && pytest
```

Ninety-plus tests: the IDE's golden actuarial-table identities, the
hand-computed descriptive statistics, Mack's published RAA figures, the
TypeScript-generated WMTR fixture, numpy-vs-statsmodels GLM parity for
five families, and every cleaning rule. `tests/make_golden.py`
regenerates the cross-language fixture the R suite checks against — run
it whenever a function's semantics change, and commit both together.
