# What's new

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

- **The whole Python stack ships on Linux.** The Linux installer now carries
  the complete bundled Python stack — SciPy, scikit-learn, statsmodels,
  LightGBM, chainladder and climada — which earlier installers left out. See
  [Linux](installation/linux.md) and
  [Bundled Python & R](workspace/terminal.md#bundled-python-r).
- **chainladder that fits.** The bundled chainladder moves from 0.8.26, which
  imported under pandas 3 but could not fit a triangle, to 0.10.1; the RAA
  chain-ladder IBNR (52,135) now matches R's ChainLadder.
- **R that stands on its own.** The bundled R's packages (ChainLadder,
  forecast, lifecontingencies, lintr, languageserver) now travel with all of
  their dependencies; earlier Linux installers only worked where those
  happened to be installed already. On Linux the bundled R runs on Ubuntu
  24.04 and later. See [Linux](installation/linux.md).
- **A real terminal.** On Linux and macOS the integrated terminal runs in a
  real pseudo-terminal. Earlier installers silently fell back to a plain pipe:
  commands ran, but without a prompt, colours, line editing or full-screen
  programs. See [Terminal & runtimes](workspace/terminal.md#the-integrated-terminal).
- **A new mark.** The app icon and wordmark are now the S₀.₂ mark.
- **Apple Silicon.** A macOS build for Apple Silicon is being introduced. It
  is unsigned and not notarised, so Gatekeeper blocks the first launch until
  you allow it. See [Windows & macOS](installation/windows-macos.md).
