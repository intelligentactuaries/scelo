# Hard Data

The readout desk. Scelo runs every switched-on model and lays the results out
on a canvas, with a board pack you can print and a bridge to the swarm.

<div class="scelo-demo" data-scelo-demo="hard"><p class="sd-fallback">The Hard Data workstation: result nodes on the canvas with a board-pack hub. The animated illustration needs JavaScript.</p></div>

## The results canvas

When you arrive, Scelo runs the models in wire order — a model runs after the
models [wired into it](tools.md#pins-and-wires) and receives their results —
and shows:

- **Result nodes** — one per model, coloured by family. Each shows a headline
  number (e.g. *Survival @ horizon · 0.514*), a **sparkline** or a small
  **table**, and a **confidence-interval strip** when the model carries
  uncertainty. Tables and long content scroll inside the node (with a soft
  fade at the clipped edge) so nothing is cut off. A badge says where the
  figures came from: **R** or **python** (Scelo IDE's bundled runtimes) or
  **in-browser**. If a bundled run fails, the card says *bridge failed* with
  the reason and shows the in-browser figure instead.
- **Not applicable** cards, for models whose inputs aren't in your data. The
  card stays neutral grey and prints the reason — *Needs a mortality table …*
  — and it's counted apart from failures in the run stats, on the macro card
  and in the board pack. A run that actually broke says **failed**, in red,
  with its error.
- The **wires** from Tools, drawn between the result cards as dashed brackets
  labelled with what flowed (*projected mortality*, *fitted GBM*, …).
- A **Board Pack** hub node that aggregates the run.

Click a result node's body to focus it in the side panel; click the **⤢**
icon to open its **detail dashboard**.

## What the models fit

These models are fitted to your data; where the inputs aren't there, the card
says *not applicable* rather than showing a stand-in figure.

| Model | What Hard computes | Not applicable when |
| --- | --- | --- |
| **GBM (LightGBM)** | Gradient-boosted trees fitted in the app (Newton boosting on binned features — the LightGBM recipe, not the LightGBM library), with a squared-error, logistic or Poisson loss to suit the target. A fifth of the rows are held out and the headline is scored on them: AUC for a 0/1 target, R² for an amount, deviance explained for a count. The chart is a lift chart on the holdout — the average actual outcome in each band of predictions, lowest to highest. | No numeric column to predict, fewer than 50 rows with a usable target, or no feature columns |
| **SHAP explainability** | Exact TreeSHAP of the wired GBM's own trees on up to 500 of its held-out rows: each feature's share of the mean absolute SHAP value, and whether higher values raise (↑) or lower (↓) the prediction | No switched-on GBM is wired into its *model to explain* pin, or that GBM didn't fit |
| **Lee-Carter** | log q = α(x) + β(x)·κ(t) fitted to the dataset's mortality table, κ projected ten years as a random walk with drift, with a 95% band. The headline is q at 65 (or the nearest age) in the last projected year. | No mortality table, or fewer than 3 years × 2 ages with a rate in every year |
| **Cairns-Blake-Dowd** | logit q = κ₁(t) + κ₂(t)(x − x̄) fitted year by year over ages 50 and up (every complete age, if fewer than three of those are), both κ projected ten years on their drifts | As Lee-Carter |
| **Life Contingencies** | Annuity-due, term assurance and pure endowment for a life aged 65 (or the nearest age) over up to ten years at 4% — priced on the cohort of a wired Lee-Carter or CBD projection or, with nothing wired, on the latest year of the dataset's life table | No mortality table in the data |

A mortality table means an `age` column with `qx`, `mx`, or `deaths` +
`exposure` — and a `year` column, to project. The GBM's target is chosen from
the data: a claim amount, a claim count, a 0/1 outcome, a column named
`target`, `label`, `y`, `response` or `outcome`, otherwise the last numeric
column — and the card says which, and why. For a claims target, the other
claims outcomes (`paid`, `incurred`, …) are kept out of the features so they
can't leak the answer.

In Scelo IDE the bundled runtimes compute two of these on the same basis:
Lee-Carter in Python (numpy and statsmodels) and Life Contingencies in R, with
the lifecontingencies package. Elsewhere on the canvas:

- **GLM · severity** — with GLM · frequency wired in, the card adds the pure
  premium (frequency × severity). Its in-browser headline is the
  claim-weighted mean severity.
- **Bornhuetter-Ferguson** takes the book-average ultimate as its prior, not
  chain ladder's.
- In Scelo IDE, when CLIMADA can't run on real hazard data, the bundled-Python
  fallback is labelled *synthetic loss model*, not CLIMADA.

## The model detail dashboard

The **⤢** on a result node opens a full-screen detail view:

- **Theory · assumptions · formulae** — rendered with proper math (KaTeX).
- **Run output** and **diagnostics** — model-specific charts/tables (ATA factors
  and CDF for chain-ladder, p5/p95 ranges for bootstrap, etc.). Null/empty
  fields are hidden; objects and arrays are summarised, not dumped as raw JSON.
- A scoped **chat** about that specific model's result.

## The board pack

The **Board Pack** hub node has a **⤢** that opens the **printable report**:

- An **executive summary** in plain English, written for the signing actuary
  and the board. It leads with the figure that matters, says how far the
  methods agree, gives the uncertainty as a range in words, and ends with what
  the figures rest on and what to check before relying on them — models that
  couldn't be applied, approximations not fit for sign-off, synthetic data. It
  uses no software names or statistical shorthand. Scelo writes it from the run
  results alone; with an [AI provider](../ai-providers.md) connected, the model
  rewords that draft for flow but must keep its figures.
- **Estimates** (a forest plot or a metrics list), a **trajectory** overlay, and
  a per-model breakdown.
- Every attached model that produced no figure, listed with its reason under
  **not applicable to this data** or **failed** — so the count of model runs is
  never mistaken for the number of models attached.
- A **download pdf** button (uses the system print dialog).

You can also open it from the toolbar: **report · pdf**.

## Convening the swarm

From the result side panel you can send a result to the multi-agent swarm —
the focused result or, with nothing focused, the dominant run:

1. **Convene council** — choose the number of agents (12 → 192) and whether to
   include the society pulse, then run.
2. The council deliberates (this uses the [swarm server](../swarm/running.md) and
   the local LLM, so it takes time — a few seconds per agent).
3. When it finishes, a **synthesis card** shows how much of the council
   trusts, distrusts or is uncertain about the result. A model result isn't a
   community the swarm's forecast can simulate, so the council judges it as
   stated; distrust means it found a flaw, uncertain that the result alone
   isn't enough to judge.
4. Click **Open in swarm** to jump into the full
   [swarm view](../swarm/index.md) for that run.

!!! warning "The swarm is its own server"
    Council and simulation features talk to the swarm server, which Scelo IDE
    bundles and starts with the app on a loopback port (3010 by default — see
    [Running the swarm](../swarm/running.md)). If a council reports "swarm
    server unreachable", open the swarm view for the server's status, its log
    and a **restart swarm server** button. A large 192-agent council on a local
    model can take many minutes — a smaller subset (12–48) completes much
    faster.

## Toolbar

| Action | What it does |
| --- | --- |
| **rerun & regenerate** | Re-run all models and regenerate the narrative |
| **re-layout** | Snap nodes back to the default circle |
| **edit models** | Back to Tools |
| **export · code** | Export the whole run as a script |
| **report · pdf** | Open the printable board pack |
