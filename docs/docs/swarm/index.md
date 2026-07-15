# The swarm

The swarm is a **multi-agent nanoeconomics engine** embedded in Scelo. It does
two things:

- **Convenes a council** of simulated professional agents to deliberate over a
  forecast — surfacing consensus, dissent, and reasoning (it does not decide; it
  surfaces inputs so *you* can).
- **Simulates a population's** response to a medical or social shock, scaling
  micro outcomes up to macro impact (workdays lost, GDP drag, mortality, cost).

You reach it two ways:

- From **Hard Data → Convene council → Open in swarm** (the pipeline route).
- Directly from the **swarm** view in the workspace.

<div class="scelo-demo" data-scelo-demo="swarm"><p class="sd-fallback">The swarm: the Forecast tab and the deliberation tabs, with eight professional agents landing a stance over three rounds. The animated illustration needs JavaScript.</p></div>

## The tabs

| Tab | What it shows |
| --- | --- |
| **Forecast** | The WMTR survival projection: wealth trajectory, survival curve, outcome distribution, M/T/R components |
| **Council reactions** | The deliberation graph + a readback Sankey (profession → trust the forecast? → confidence) |
| **Society pulse** | How a broader simulated society reacts |
| **Readback** | The synthesised narrative of the council |
| **Simulation** | Population simulation of a scenario → macro impact |
| **IAAI Canon** | The reference works injected into every agent's prompt |

## Important: it runs as a separate server

The swarm is a self-contained app with its own server. Scelo embeds it, but you
must **start it first**. See [Running the swarm](running.md).

!!! tip
    The swarm is a decision-*support* cockpit. The agents report; the actuary
    decides.
