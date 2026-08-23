# Workspace diagnostics

Two readouts from the lab's interpretability research — the paper
[*A Global Workspace for Actuarial Models*](https://intelligentactuaries.com/research/global-workspace)
— ported from the IDE's numpy bridge. They answer a question black-box
model governance keeps asking: **which few directions in the inputs
actually carry the decision?**

## The bottleneck

=== "Python"

    ```python
    ws = sc.sample("workspace-demo")     # 2,000 policies, 14 drivers, 3 readouts
    b = sc.bottleneck(ws, r=3)           # compress the drivers through r codes
    b.attrs["participation_ratio"]       # effective number of directions in use
    b.attrs["causal_alignment"]          # do the codes point where the readouts move?
    b.attrs["code_loadings"]             # what each code is made of
    ```

=== "R"

    ```r
    ws <- sc_sample("workspace-demo")
    b <- sc_bottleneck(ws, r = 3)
    attr(b, "participation_ratio"); attr(b, "causal_alignment")
    ```

The codes are the leading eigenvectors of the standardised driver
covariance, oriented to correlate positively with the row sum, with a
non-negative broadcast matrix fitted on top — the linear special case
with one code is exactly Lee–Carter. On the demo book the basis line
reads `PR 3.00 · reconstruction R² 0.14 · causal alignment 0.81 ·
sparsity 0.43`: three codes that reconstruct little of the *variance*
but align strongly with what the readouts *do* — the workspace
signature.

## The active subspace

=== "Python"

    ```python
    a = sc.active_subspace(ws, "annuity_60")   # which directions move THIS readout
    a[["direction", "sensitivity_share", "variance_share", "name"]]
    a.attrs["rank"]                            # how many directions matter (here: 2)
    ```

=== "R"

    ```r
    a <- sc_active_subspace(ws, "annuity_60")
    attr(a, "rank")
    ```

A linear-quadratic surrogate of the readout is fitted, and the
eigen-decomposition of its average outer-product gradient
`C = E[∇f∇fᵀ]` names the directions the decision actually moves along —
with each direction's **sensitivity share** next to its **variance
share**. On the demo, the top direction carries most of the sensitivity
and under 15 % of the variance: the direction a variance-led analysis
(a PCA) would have discarded.

Both functions state their preconditions plainly (at least 10 complete
rows and 3 numeric columns) and thin very large books by a regular
stride. `participation_ratio(eigenvalues)` is exported on its own for
spectra you computed elsewhere.
