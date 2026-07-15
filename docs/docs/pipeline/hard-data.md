# Hard Data

The readout desk. Scelo runs every selected model and lays the results out on a
canvas, with a board pack you can print and a bridge to the swarm.

<div class="scelo-demo" data-scelo-demo="hard"><p class="sd-fallback">The Hard Data workstation: result nodes on the canvas with a board-pack hub. The animated illustration needs JavaScript.</p></div>

## The results canvas

When you arrive, Scelo runs the models and shows:

- **Result nodes** — one per model, coloured by family. Each shows a headline
  number (e.g. *Survival @ horizon · 0.514*), a **sparkline** or a small
  **table**, and a **confidence-interval strip** when the model carries
  uncertainty. Tables and long content scroll inside the node (with a soft
  fade at the clipped edge) so nothing is cut off.
- A **Board Pack** hub node that aggregates the run.

Click a result node's body to focus it in the side panel; click the **⤢**
icon to open its **detail dashboard**.

## The model detail dashboard

The **⤢** on a result node opens a full-screen detail view:

- **Theory · assumptions · formulae** — rendered with proper math (KaTeX).
- **Run output** and **diagnostics** — model-specific charts/tables (ATA factors
  and CDF for chain-ladder, p5/p95 ranges for bootstrap, etc.). Null/empty
  fields are hidden; objects and arrays are summarised, not dumped as raw JSON.
- A scoped **chat** about that specific model's result.

## The board pack

The **Board Pack** hub node has a **⤢** that opens the **printable report**:

- An **executive summary** (the LLM narrative), rendered as markdown.
- **Estimates** (a forest plot or a metrics list), a **trajectory** overlay, and
  a per-model breakdown.
- A **download pdf** button (uses the system print dialog).

You can also open it from the toolbar: **report · pdf**.

## Convening the swarm

On a result card you can send the forecast to the multi-agent swarm:

1. **Convene council** — choose the number of agents (12 → 192) and whether to
   include the society pulse, then run.
2. The council deliberates (this uses the [swarm server](../swarm/running.md) and
   the local LLM, so it takes time — a few seconds per agent).
3. When it finishes, a **synthesis card** shows trust / dissent and the
   dominant recommended intervention.
4. Click **Open in swarm** to jump into the full
   [swarm view](../swarm/index.md) for that run.

!!! warning "The swarm is a separate server"
    Council and simulation features need the swarm running on port 3010. If you
    see "Swarm server unreachable", [start it first](../swarm/running.md). A
    large 192-agent council on a local model can take many minutes — a smaller
    subset (12–48) completes much faster.

## Toolbar

| Action | What it does |
| --- | --- |
| **rerun & regenerate** | Re-run all models and regenerate the narrative |
| **re-layout** | Snap nodes back to the default circle |
| **edit models** | Back to Tools |
| **export · code** | Export the whole run as a script |
| **report · pdf** | Open the printable board pack |
