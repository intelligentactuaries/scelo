# Getting started

This is the five-minute tour: from a dataset to a board pack to a swarm council.

## 1. Open the pipeline

From the welcome screen, the Scelo pipeline lives at **Dashboards → Scelo**.
The macro view shows three stages wired together:

<figure class="ia-diagram" markdown="0">
<svg viewBox="0 0 620 96" role="img" aria-label="Soft to Tools to Hard" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <rect x="14" y="20" width="156" height="56" rx="10"/>
  <text class="ia-tag" x="92" y="46" text-anchor="middle" fill="currentColor" stroke="none">soft</text>
  <text class="ia-sub" x="92" y="62" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">data</text>
  <circle cx="172" cy="48" r="2" fill="currentColor" stroke="none"/>
  <line x1="174" y1="48" x2="222" y2="48"/>
  <path d="M216 43 L223 48 L216 53"/>
  <rect x="232" y="20" width="156" height="56" rx="10"/>
  <text class="ia-tag" x="310" y="46" text-anchor="middle" fill="currentColor" stroke="none">tools</text>
  <text class="ia-sub" x="310" y="62" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">models</text>
  <circle cx="390" cy="48" r="2" fill="currentColor" stroke="none"/>
  <line x1="392" y1="48" x2="440" y2="48"/>
  <path d="M434 43 L441 48 L434 53"/>
  <rect x="450" y="20" width="156" height="56" rx="10"/>
  <text class="ia-tag" x="528" y="46" text-anchor="middle" fill="currentColor" stroke="none">hard</text>
  <text class="ia-sub" x="528" y="62" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">results</text>
</svg>
</figure>

Each node has a one-line summary, a scoped chat box, and an **open →** link that
drills into that stage's full workstation.

## 2. Soft Data — load and clean

Open the **Soft** node.

1. Click **load sample** (or **import csv / parquet** for your own file).
2. The grid appears with a per-column header showing type
   (`abc` / `123` / `📅`), a mini distribution, and quality.
3. If the data needs cleaning, a **banner** appears above the grid — tick the
   ops you want and **Apply**, or just type `clean my data` in the chat.
4. For dates, click the **📅 ▾** badge on a date column and pick a format
   (American / European / ISO), or ask the chat `make the dates american`.

See [Soft Data](pipeline/soft-data.md) for everything this stage can do.

## 3. Tools — choose models

Click **next: tools →**. You get a bench of actuarial models (Chain Ladder,
Mack, Bornhuetter-Ferguson, Lee-Carter, Cairns-Blake-Dowd, WMTR forecast, …).

- Drag or click models onto the canvas, or hit **identify models** to let Scelo
  suggest a set for your data's domain.
- Each model node has a scoped chat (`swap chain-ladder for Mack`, `compare
  models`).

See [Tools](pipeline/tools.md).

## 4. Hard Data — run and read

Click **next: hard →**. Scelo runs every selected model and lays the results out
on a canvas:

- **Result nodes** show a headline number, a sparkline or table, and a
  confidence interval. Click the **⤢** to open a model's detail dashboard.
- The **Board Pack** hub aggregates everything; click **⤢** → **report · pdf**
  for a printable board pack.
- On a result card, **Convene council** sends the forecast to the swarm.

See [Hard Data](pipeline/hard-data.md).

## 5. The swarm — pressure-test it

After convening a council, click **Open in swarm** to jump into the full swarm
view: a deliberation graph, society pulse, and a population simulator.

See [The swarm](swarm/index.md). (The swarm runs as a separate local server —
[start it first](swarm/running.md).)

---

!!! tip "Everything is reproducible"
    At any stage, **export · code** turns what you've done into a runnable
    Python, R, or C++ script. See [Exporting](exporting.md).
