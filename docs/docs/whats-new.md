# What's new

## 0.2.2

*Released 2026-10-02.*

### Simulate from a scenario

- **It opens again.** Clicking **▷ simulate** blanked the whole window in every
  release since 0.1.2. It now opens the dialog.
- **You can see it work.** While a run is under way, the dialog shows the same
  progress overlay as the rest of Scelo: a table materialising over a rail
  that fills with the agents that have answered ("30 / 120") and scans while
  references are resolved and results are scaled.
- **Pause, resume, stop.** Pause holds the run where it stands: the calls in
  flight are cancelled and asked again on resume, and no new agent starts.
  Stop ends the run and changes nothing. Closing the dialog leaves a run going:
  it lands when it finishes, and reopening the dialog shows where it is.
  Leaving the pipeline (for the workspace or settings) or quitting Scelo stops
  it.
- **Augment matches only what your rows say.** A row is matched to the
  reference cohort on the age, sex and comorbidity columns it actually has.
  Rows without them used to be treated as a 35-year-old woman with no
  comorbidities, and all handed one agent's answers; they now get the whole
  cohort's figures, labelled `cohort` in `sim_bucket_match`. The dialog says
  so before you run it and suggests generating a dataset instead.
- **You land on what it added.** When a run finishes, the grid scrolls to its
  first `sim_*` column. Running augment again replaces the earlier `sim_*`
  values instead of stacking another "+ sim", and a run in which every agent
  failed says so and changes nothing. See
  [Simulating and exporting](pipeline/soft-data.md#simulating-and-exporting).

### Tools

- **Switching a model on wires it.** A model that arrives switched off,
  because the data can't feed it, and is switched on later (by its toggle, a
  new pick or the chat) is now plugged into the models waiting on it, so SHAP
  beside a GBM no longer says it can't run. **Identify models** and
  **regenerate** wire every model they pick, and sessions and `.sce` projects
  saved with a model left unplugged this way are repaired when they open. See
  [Pins and wires](pipeline/tools.md#pins-and-wires).

### Council

- **The council card says what comes back.** On a Hard Data result, the
  council card and the deliberation overlay no longer promise a proposed
  parameter shift: since 0.2.1 a result is judged as stated, so trust,
  distrust or uncertain come back, with the reasons in the swarm.

## 0.2.1

*Released 2026-10-01.*

### The swarm judges what it is given

- **No more blanket distrust.** The swarm's forecast models a community:
  people, and the money, time and relationships that carry them. A scenario
  that isn't one (a fund's allocation, an insurer's capital decision, or a
  model result sent from Hard Data) used to get the same generic forecast,
  and the council distrusted it every time. The council now judges such a
  scenario as stated: **trust** means it holds up on what is given,
  **distrust** that something it states is wrong, and **uncertain** that
  there isn't enough to judge. Community scenarios still get the forecast,
  and the council still votes on it. See
  [Council, society & simulation](swarm/views.md#forecast).

### Opening on the pipeline

- **A launch intro.** The S₀.₂ mark draws itself in, and the window opens in
  your theme's colour, with no white flash. A click or a key skips it. See
  [First launch](installation/first-launch.md).
- **Straight to the pipeline.** Scelo opens on Soft → Tools → Hard. The bar
  above it carries **workspace** and **reset session**, and **get started**,
  top left, leads to the welcome screen.
- **Level cards.** The three pipeline cards share one height, so their chat
  boxes line up and the wires between them run straight. The chat's send
  button is now an enter key.

### One typeface

- The whole interface uses SN Pro, with its own arrows: labels, headings,
  charts and the swarm alike. The code editor and terminal keep a
  fixed-width font, so columns line up.

## 0.2.0

*Released 2026-09-30.*

### Tools: a typed canvas

- **Only the pins that matter.** The dataset hub offers only the inputs your
  data really contains — a claims triangle, a mortality table, model points
  and so on — each with the evidence it found, and every model shows only the
  pins it uses: inputs on the left, outputs on the right. See
  [Tools](pipeline/tools.md#the-canvas).
- **Every wire carries something.** A wire joins only pins whose types agree,
  and each one carries a result the next model actually uses: a Lee-Carter or
  CBD projection priced by Life Contingencies, claim frequency into severity
  for the pure premium, the GBM that SHAP explains, rate scenarios into the
  SCR. The old decorative arrows are gone, and sessions and `.sce` projects
  saved by earlier versions are rewired when they open. See
  [Pins and wires](pipeline/tools.md#pins-and-wires).
- **The canvas says what fits.** A dragged wire says why a drop won't take;
  dropping it on empty canvas, or right-clicking, lists the models that fit;
  and the Tools chat can wire models too. A model your data can't feed says so
  on its node, and suggested models the data can't feed arrive switched off.
  See [Connecting](pipeline/tools.md#connecting).

### Hard Data: fitted models, honest results

- **Gradient boosting and SHAP are fitted.** GBM fits boosted trees to your
  data and scores them on rows it never trained on; SHAP gives exact
  attributions for that same model. See
  [What the models fit](pipeline/hard-data.md#what-the-models-fit).
- **Mortality models are fitted.** Lee-Carter and Cairns-Blake-Dowd fit your
  mortality table, and Life Contingencies prices a wired projection's cohort
  or the table itself. In Scelo IDE, the bundled R now prices Life
  Contingencies on Linux and macOS too, wherever the bundled R runs; before,
  that bridge failed on every run there. See
  [What the models fit](pipeline/hard-data.md#what-the-models-fit).
- **"Not applicable", not a stand-in number.** A model whose inputs aren't in
  your data says so, with the reason, and is counted apart from real failures.
  When a bundled Python or R run fails, the card shows the real reason. See
  [The results canvas](pipeline/hard-data.md#the-results-canvas).
- **Reserving methods line up.** All four reserving methods now share one
  forest plot (in Scelo IDE it never formed before), with Mack's standard
  error and the bootstrap's range, and Bornhuetter-Ferguson uses an
  independent prior, the book-average ultimate. See
  [What the models fit](pipeline/hard-data.md#what-the-models-fit).
- **A board pack in plain English.** The executive summary is written for the
  signing actuary — the figure that matters, how far the methods agree, the
  uncertainty in words, what to check before relying on it — and the pack
  lists every model it couldn't compute, with the reason. See
  [The board pack](pipeline/hard-data.md#the-board-pack).

### A quieter interface

- **Visible panel toggles.** Every side panel in Soft, Tools and Hard
  has a panel-toggle icon in its header corner, and a collapsed panel leaves a
  thin rail with its name. Toolbars and scrollbars are quieter, and views,
  dialogs and menus arrive with a brief, purposeful motion (none, if your
  system asks for reduced motion). See [Side panels](pipeline/index.md#side-panels).
- **The swarm's pets are alive.** They breathe, blink and follow your cursor,
  lean in when you hover and hop when chosen — and the swarm now follows the
  IDE's light or dark theme. See
  [The swarm](swarm/index.md#the-surfaces-and-their-pets).

### Installers

- **The whole Python stack ships.** The Linux, Windows and macOS installers
  now carry the complete bundled Python stack — SciPy, scikit-learn,
  statsmodels, LightGBM, chainladder and climada — which earlier installers
  left out. See [Bundled Python & R](workspace/terminal.md#bundled-python-r).
- **chainladder that fits.** The bundled chainladder moves from 0.8.26, which
  imported under pandas 3 but could not fit a triangle, to 0.10.1; the RAA
  chain-ladder IBNR (52,135) now matches R's ChainLadder.
- **R that stands on its own.** The bundled R's packages (ChainLadder,
  forecast, lifecontingencies, lintr, languageserver) now travel with all of
  their dependencies; earlier Linux installers only worked where those
  happened to be installed already. On Linux the bundled R runs on Ubuntu
  24.04 and later. See [Linux](installation/linux.md).
- **A real terminal.** On Linux, macOS and Windows (ConPTY) the integrated
  terminal runs in a real pseudo-terminal. Earlier installers silently fell
  back to a plain pipe:
  commands ran, but without a prompt, colours, line editing or full-screen
  programs. See [Terminal & runtimes](workspace/terminal.md#the-integrated-terminal).
- **A new mark.** The app icon and wordmark are now the S₀.₂ mark.
- **Apple Silicon.** 0.2.0 adds a macOS build: a `.dmg` for Apple Silicon
  Macs on macOS 14 or later, with the same bundled Python and R. It is
  unsigned and not notarised, so clear the download's quarantine flag once
  (one Terminal command) before opening it. See
  [Windows & macOS](installation/windows-macos.md).
- **Built and tested in CI.** The macOS and Windows installers are built on
  GitHub's own macOS and Windows machines, which check the bundled Python and
  R and launch the app before anything is published; the Windows installer is
  also installed there first.
