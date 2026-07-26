# The pipeline

Scelo's core is a three-stage pipeline. It's a guided flow where each stage has
a clear job and its own scoped AI assistant.

<figure class="ia-diagram" markdown="0">
<svg viewBox="0 0 760 168" role="img" aria-label="Soft Data flows into Tools, which flows into Hard Data" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <!-- SOFT -->
  <rect x="20" y="30" width="200" height="110" rx="11"/>
  <text class="ia-tag" x="40" y="63" fill="currentColor" stroke="none">SOFT</text>
  <text class="ia-title" x="120" y="96" font-size="18" text-anchor="middle" fill="currentColor" stroke="none">Data</text>
  <text class="ia-sub" x="120" y="116" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">load · clean · shape</text>
  <!-- intake connector -->
  <circle cx="222" cy="85" r="2.1" fill="currentColor" stroke="none"/>
  <line x1="224" y1="85" x2="272" y2="85"/>
  <path d="M266 79 L273 85 L266 91"/>
  <text class="ia-tag" x="248" y="73" text-anchor="middle" fill="currentColor" stroke="none">intake</text>
  <!-- TOOLS -->
  <rect x="280" y="30" width="200" height="110" rx="11"/>
  <text class="ia-tag" x="300" y="63" fill="currentColor" stroke="none">TOOLS</text>
  <text class="ia-title" x="380" y="96" font-size="18" text-anchor="middle" fill="currentColor" stroke="none">Models</text>
  <text class="ia-sub" x="380" y="116" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">pick · suggest</text>
  <!-- compute connector -->
  <circle cx="482" cy="85" r="2.1" fill="currentColor" stroke="none"/>
  <line x1="484" y1="85" x2="532" y2="85"/>
  <path d="M526 79 L533 85 L526 91"/>
  <text class="ia-tag" x="508" y="73" text-anchor="middle" fill="currentColor" stroke="none">compute</text>
  <!-- HARD -->
  <rect x="540" y="30" width="200" height="110" rx="11"/>
  <text class="ia-tag" x="560" y="63" fill="currentColor" stroke="none">HARD</text>
  <text class="ia-title" x="640" y="96" font-size="18" text-anchor="middle" fill="currentColor" stroke="none">Results</text>
  <text class="ia-sub" x="640" y="116" font-size="9.5" text-anchor="middle" fill="currentColor" stroke="none">run · board pack</text>
</svg>
</figure>

## The macro view

<div class="scelo-demo" data-scelo-demo="macro"><p class="sd-fallback">The macro view: three pipeline stages wired together, each with a status summary and a scoped chat box. The animated illustration needs JavaScript.</p></div>

`Dashboards → Scelo` shows the three stages as cards on a canvas:

- Each card carries a **status summary** (rows/cols for Soft, model count for
  Tools, run count + headline for Hard).
- A small **chat box** on each card answers stage-scoped questions without
  drilling in (e.g. "restore a project", "swap chain-ladder for Mack",
  "explain this ultimate").
- **open →** drills into that stage's full workstation.
- **EXPORT · WHOLE PIPELINE** turns the entire flow into a script.
- **+ START PROJECT** scaffolds a new project.

## The three stages

<div class="grid cards" markdown>

-   :material-table: **[Soft Data](soft-data.md)**

    Load, inspect, clean, reshape, and augment a dataset. The intake desk.

-   :material-tune-vertical: **[Tools](tools.md)**

    Choose actuarial models — by hand or AI-suggested. The model bench.

-   :material-chart-box: **[Hard Data](hard-data.md)**

    Run the models, read the canvas, export the board pack. The readout desk.

</div>

!!! note "State flows forward"
    The dataset you load in Soft is available to Tools and Hard; the models you
    pick in Tools drive the runs in Hard. You can move freely between stages and
    your work persists.
