# Tools (models)

The model bench. Choose the actuarial models that turn your soft data into hard
results — by hand, or let Scelo suggest a set for your data.

<div class="scelo-demo" data-scelo-demo="tools"><p class="sd-fallback">The Tools workstation: the dataset hub, attached model nodes, and the model catalog. The animated illustration needs JavaScript.</p></div>

## The canvas

Tools is a node canvas:

- A **Dataset Hub** node at the centre represents your loaded data.
- **Model nodes** hang off it, each showing its family (forecast, capital,
  reserving, climate, …), name, and a tiny key-parameter summary.
- A **model library** strip lets you add models with a click.

## Choosing models

**By hand** — add from the library:

- **Reserving** — Chain Ladder, Mack Chain Ladder, Bornhuetter-Ferguson,
  Bootstrap (IBNR).
- **Mortality / longevity** — Lee-Carter, Cairns-Blake-Dowd, Life Contingencies.
- **Pricing / GLM** — GLM · frequency, and more.
- **Forecast / capital / climate** — WMTR forecast, Economic Scenario
  Generator, CLIMADA climate hazard exposure.

**AI-suggested** — click **identify models**. Scelo reads your dataset's shape
and domain and proposes a set, with a short rationale per pick. You can accept,
add to, or swap them.

## Per-model controls

Each model node has:

- A scoped **chat** (`ASK SCELO ▸`) — `swap chain-ladder for Mack`,
  `explain this model's assumptions`, `compare models`.
- A **↻ rerun** and **× remove**.
- An expand for theory/details on the Hard stage.

Model notation renders mathematically — e.g. a WMTR rationale reads
"α<sub>M</sub> / α<sub>T</sub> / α<sub>R</sub> triplet detected".

## Other actions

| Action | What it does |
| --- | --- |
| **identify models** | AI-suggest a model set for the data |
| **regenerate** | Re-run the AI suggestion |
| **re-layout** | Snap nodes back to the default layout |
| **export · code** | Export the model setup as a script |
| **← back: soft** / **next: hard →** | Move through the pipeline |

When your model set looks right: **next: hard →**.
