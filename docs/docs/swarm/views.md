# Council, society & simulation

A tour of the swarm's surfaces. Navigation is the **pet rail** down the
left edge — one animal per surface, and the animal is the only thing on
screen that identifies it: the bunny is Forecast, the dog Council
Reactions, the hamster Society Pulse, the turtle Readback, the chick
Simulation, and the cat — sitting slightly apart — the Canon. The active
pet grows a step and wears its name; the rest step back to icons.

## Forecast

The WMTR (Wealth = Material × Time × Relational) survival projection under
shocks, shown as four panels: wealth trajectory (25–75 band + mean), survival
probability S(t), the outcome distribution, and the M/T/R components.

From here you can **Forecast & convene** to run a council on the projection.

## Council reactions

The heart of the deliberation:

- A **force graph** of agents (Finance, Investor, Accountant, Actuary,
  Psychologist, Lawyer, …), coloured and bordered by their final stance.
- A **readback Sankey**: profession → *trust the forecast?* → confidence band.
- A **decision sidebar** — click an agent to see its per-round reasoning,
  key risk, and final vote — or open an [audit interview](#audit-interviews)
  with them; click a profession to see the group's aggregate.

### Recommended interventions

When an agent recommends changing a model parameter, it's shown as a tidy card
(e.g. **↑ α<sub>M</sub> · large** with a one-line rationale), not raw JSON. On
the strip you can **apply & re-simulate** a consensus intervention to see how
the forecast shifts.

## Society pulse

A broader simulated society's reaction to the same scenario, with configurable
society parameters (income mix, education mix, employment mix, culture).
A cluster's member list opens individual members — each of whom you can
[interview](#audit-interviews) about the sentiment they recorded.

## Audit interviews

Trust, but interview. On **Council reactions** and **Society pulse** you
can put any member back on the record and converse with them about the
position they recorded — watching whether they stay consistent with it.

- **Pick a member.** 🎲 in the header band picks one at random; shuffle
  in the drawer moves on to the next; or choose someone specific from the
  agent inspector (council) or a cluster's member list (society).
- **The drawer shows the record.** The member's card carries who they are
  and exactly what they recorded: all three rounds with confidences, the
  final vote, key risk and recommended intervention — and, for
  professionals, the justification they wrote, with its framework,
  citations and formulas.
- **Every reply is checked.** The member answers from inside the original
  brief — the same persona, IAAI canon and WMTR evidence they deliberated
  with — and each reply is verified against the recorded verdict and
  badged **consistent**, **drift** or **unverified**, with a running
  tally. Ready-made probes test the position from different angles.
- **It is all audit trail.** Transcripts persist to the swarm's chat log,
  and `GET /api/run/:id/interviews` indexes who has been interviewed,
  with their consistency counts.

The recorded verdict stands — an interview never rewrites a vote.
Professionals defend their position with the theory on their record;
society members answer as ordinary people, in plain language.

## Simulation

<div class="scelo-demo" data-scelo-demo="simulation"><p class="sd-fallback">The Simulation surface: scenario chips, drugs/compounds, sample size and population, then the macro impact tiles. The animated illustration needs JavaScript.</p></div>

A standalone population simulator:

1. Pick a **scenario** (a medical or social shock) — or paste your own.
2. Set the **drugs / compounds**, **sample size**, and **population**.
3. **Run simulation**. A progress panel walks the pipeline: *Resolving compound
   references* → *Sampling the population* → *Simulating agent outcomes* →
   *Scaling macro impact*.
4. Results: **macro impact** tiles (workdays lost, GDP drag, excess mortality,
   severe/critical, hospital admissions/cost, insurer claims, out-of-pocket),
   treatment-uptake bars, and distributional tables by age and comorbidity.

!!! note "What the progress panel is, and isn't"
    `/api/simulate` is a single request, so the four phases advance on a fixed
    cadence rather than reporting server state. Only the **elapsed timer** is
    live. The phases tell you what the pipeline does, not how far along it is.

Drug references are resolved live via PubChem, OpenFDA, and ChEMBL.

## IAAI Canon

<div class="scelo-demo" data-scelo-demo="canon"><p class="sd-fallback">The IAAI Canon editor: reference works with import for JSON or BibTeX. The animated illustration needs JavaScript.</p></div>

The reference works (title + takeaway) that get injected into every agent's
system prompt under "IAAI Canon — apply where relevant". Add, edit, or import
works (JSON or BibTeX). If empty, agents are told to say so — no fabricated
citations.

A fresh install starts with an **empty canon**. The **sample** button fills the
box with a worked example for whichever format is selected, so you can see the
shape before importing your own.

!!! note "State persists across surfaces"
    Switching surfaces keeps your scenario, slider values, and results — you resume
    exactly where you left off.
