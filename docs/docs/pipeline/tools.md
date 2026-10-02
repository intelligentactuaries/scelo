# Tools (models)

The model bench. Choose the actuarial models that turn your soft data into hard
results — by hand, or let Scelo suggest a set for your data.

<div class="scelo-demo" data-scelo-demo="tools"><p class="sd-fallback">The Tools workstation: the dataset hub, attached model nodes, and the model catalog. The animated illustration needs JavaScript.</p></div>

## The canvas

Tools is a typed node graph that reads the way an Unreal Engine Blueprint
does: inputs on a node's left, outputs on its right, and a pin only where
something actually flows.

- The **Dataset Hub** is the source. It has one output pin for each role your
  data can really play — *claims triangle*, *mortality table*, *model points*,
  *claim counts*, *claim amounts*, *rating factors*, *target & features*,
  *exposure*, *numeric columns*, *WMTR parameters* — with its evidence beside
  it (`7 origins × 7 dev periods`, or the columns it reads). Each role is found
  by the same check the model runs in Hard, so a pin on the hub is a promise:
  if the hub offers a claims triangle, chain ladder will find one. Once models
  are attached, the hub shows the roles they read and folds the rest under
  **▸ N more this data can feed**. Click a role for the models that read it.
- **Model nodes** carry their family and name in a tinted header, then their
  pins, then a one-line rationale. A model that can't run here says so under
  its rationale — *⚠ can't run: needs a claims triangle* — with the full reason
  on hover.
- The **catalog** in the right-hand panel lists every model by family, marked
  **✓** runs on this data, **~** illustrative, or **✗** its inputs aren't here.
  Click a model to attach it; click it again to detach it.

The banner above the canvas is the check before you move on — for example
**✓ 4 ready · 1 off · 2 wires**, or **⚠ 3 ready · 1 can't run**. Switched-on
models whose inputs are all fed run in Hard; the rest report why not.

### Pins and wires

| Pin | Means |
| --- | --- |
| Round | Data from the Dataset Hub |
| Diamond | A result from another model |
| Hollow | Nothing plugged in yet |
| Dashed, red | A required input nothing can feed — the model can't run |

Pins and wires take the colour of what they carry. An optional input shows the
default it falls back to beside its label — *built-in defaults*, *severity
only*, *no rate stress*. A required input that's missing says *not in this
data* or *nothing plugged in*; when another model could feed it, the pin offers
the fix instead: **+ GBM (LightGBM)**, **switch on …** or **plug in …**.

Every input that takes a role your data has is fed from the hub automatically
(unless a model is wired into it), and those wires can't be unplugged.
Model-to-model wires carry results, and only four exist — each one consumed by
the model it feeds:

| From | Into | What flows |
| --- | --- | --- |
| Lee-Carter or Cairns-Blake-Dowd | Life Contingencies | *projected mortality*, priced as a cohort |
| GLM · frequency | GLM · severity | *claim frequency* — × severity gives the pure premium |
| GBM (LightGBM) | SHAP explainability | *fitted GBM* — SHAP explains exactly this model |
| Economic Scenario Generator | SCR · Standard Formula | *rate scenarios*, sized into an interest-rate stress |

The reserving methods take no model inputs: Mack and the bootstrap refit chain
ladder themselves, and Bornhuetter-Ferguson keeps a prior of its own, because
a chain-ladder prior would collapse it onto chain ladder.

New models arrive wired, and so do models you switch on. A model that joins
the canvas — from the catalog, the picker or the chat — or is switched on is
plugged into what it can consume or feed, taking the first switched-on model
that makes it (Lee-Carter before CBD); wires you drew or unplugged are left
alone. A fresh pick (**identify models**, **regenerate**) wires every model it
picks. A model that can't run without another brings it along: adding SHAP
adds the GBM it explains.

### Connecting

Drag from an output (right) to an input (left). A wire joins only pins whose
types agree, and an input takes one wire — so plugging CBD into Life
Contingencies unplugs Lee-Carter. While you drag, a tag at the cursor says what
the wire carries and, over a pin, whether the drop will take
(**✓ release to plug in**) or why not: *✗ claim frequency can't feed mortality —
it takes a mortality table or projected mortality*, or *✗ a model can't feed
itself*.

**Drop a wire on empty canvas** and a menu opens with the models that fit: the
ones that take what the wire carries or, dragged from an input that takes a
model's result, the ones that make it. Picking one adds it and plugs it in.
**Right-click the canvas** for every model, ranked by what this data can feed.
Both menus group their entries under *fits this data*, *illustrative*, *on the
canvas* and *can't run on this data* (greyed out, with the reason); type to
filter, **↑**/**↓** to move, **Enter** to pick, **Esc** to close.

Dragging a hub pin onto an input that a model currently feeds hands it back to
the dataset (**✓ release to feed it from the dataset instead**). To unplug a
model-to-model wire, click the **×** on it, or select it and press
**Backspace** or **Delete**. A wire whose source is switched off turns dashed,
and its input falls back to the dataset or its default, if it has one.

## Choosing models

**By hand** — click a model in the catalog, or add one from the canvas menus
(see [Connecting](#connecting)):

- **Reserving** — Chain Ladder, Mack Chain Ladder, Bornhuetter-Ferguson,
  Bootstrap (IBNR).
- **Mortality / longevity** — Lee-Carter, Cairns-Blake-Dowd, Life Contingencies.
- **Pricing / GLM** — GLM · frequency, GLM · severity, GBM (LightGBM), SHAP
  explainability.
- **Forecast / capital / climate** — WMTR forecast, Economic Scenario
  Generator, CLIMADA climate hazard exposure.

A model whose figures come from built-in assumptions rather than your data
carries an **illustrative** tag on its node: SCR · Standard Formula, Economic
Scenario Generator, DB / DC Valuation, Smith-Wilson · curve fit and Economic
curves. A model the data can't feed can still be attached, but it arrives
switched off.

**AI-suggested** — click **identify models**. Scelo reads your dataset's shape
and domain and proposes a set, with a short rationale per pick. You can accept,
add to, or swap them. Picks the data can't feed arrive switched off, with the
reason, so Hard won't run them unless you switch them on; a pick that needs
another model brings it along (SHAP arrives with its GBM).

## Per-model controls

Each model node has:

- A scoped **chat** (`ASK SCELO ▸`) — `swap chain-ladder for Mack`,
  `explain this model's assumptions`, `compare models`. It wires, too —
  `wire cbd into life contingencies`,
  `unplug lee-carter from life contingencies` — as long as both models are
  already on the canvas.
- **↻** to replace it with another model — the ones that read the same inputs
  are listed first, each marked ✓ fits or ✗ can't run — an on/off switch, and
  **×** to remove it (or select it and press **Backspace** / **Delete**).
- Click a node for its details in the right-hand panel: whether it can run,
  each pin and what feeds it, and why it was picked.

A model's theory, run output and diagnostics are in its detail dashboard on the
[Hard stage](hard-data.md#the-model-detail-dashboard).

Model notation renders mathematically — e.g. a WMTR rationale reads
"α<sub>M</sub> / α<sub>T</sub> / α<sub>R</sub> triplet detected".

## Other actions

| Action | What it does |
| --- | --- |
| **identify models** | AI-suggest a model set for the data |
| **regenerate** | Re-run the AI suggestion |
| **re-layout** | Lay the graph back out left to right and refit the view |
| **export · code** | Export the model setup as a script |
| **← back: soft** / **next: hard →** | Move through the pipeline |

The canvas lays itself out left to right until you drag a node; from then on
it keeps your arrangement, and a model you add by dropping a wire or
right-clicking lands where you did it. **re-layout** hands the layout back to
Scelo.

When your model set looks right: **next: hard →**.
