// Sample workspace catalog — shared between the Welcome view (UI) and
// the create-from-template IPC handler (main). Keep this list small;
// each entry maps to a tree under `apps/scelo-ide/templates/<id>/`
// that the main process copies to the user's chosen parent dir.
//
// Templates ship as plain text only — no binaries, no node_modules —
// so they're safe to bundle inside the Electron asar.

export interface SampleWorkspaceSpec {
  /** Stable id; must match the directory name under templates/. */
  id: string;
  /** Headline shown on the welcome tile. */
  title: string;
  /** One-line pitch — what the template gets the user to today. */
  blurb: string;
  /** Two or three short bullets the tile expands to. */
  highlights: string[];
  /** Datasets the template references; the welcome view links these
   *  to /settings/data so the user can prefetch before opening. */
  needsDatasets: string[];
}

export const SAMPLE_WORKSPACES: SampleWorkspaceSpec[] = [
  {
    id: "life-pricing",
    title: "Life pricing starter",
    blurb: "Mortality table + deterministic premium walk in Python and R, side by side.",
    highlights: [
      "Python notebook: load WHO life tables, build qx → lx → ex",
      "R script: deterministic level-premium cash-flow projection",
      "README with a step-by-step run order",
    ],
    needsDatasets: ["who-life-tables"],
  },
  {
    id: "climate-risk",
    title: "Climate risk starter",
    blurb: "IBTrACS tropical-cyclone footprint + Climada Python loss curve.",
    highlights: [
      "Python: filter IBTrACS to a basin, plot tracks on a basemap",
      "Python: Climada hazard → exposure → impact pipeline",
      "R: ggplot choropleth of return-period losses",
    ],
    needsDatasets: ["ibtracs"],
  },
  {
    id: "scelo-brain",
    title: "Scelo brain starter",
    blurb: "Soft → tools → hard pipeline scaffold with a single example flow.",
    highlights: [
      "TypeScript: minimal soft-data validator + tool registry",
      "Python: hard-data writer with a deterministic seed",
      "README with the soft → tools → hard contract spelled out",
    ],
    needsDatasets: [],
  },
  {
    id: "reserving",
    title: "Reserving starter (Mack chain-ladder)",
    blurb: "RAA triangle through R ChainLadder + chainladder.py cross-check (pinned IBNR ≈ 52,135).",
    highlights: [
      "R: ChainLadder::MackChainLadder + bootstrap percentiles",
      "Python: chainladder.MackChainladder cross-engine verifier",
      "Makefile that runs both engines + paste-into-PR report",
    ],
    needsDatasets: [],
  },
];
