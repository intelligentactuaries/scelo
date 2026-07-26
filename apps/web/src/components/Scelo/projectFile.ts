// The .sce project file — Scelo's portable "save my whole session" format.
//
// A .sce file is a single JSON document wrapping the full pipeline snapshot
// (dataset + filters + model picks + runs + derived columns + activity log)
// plus the project identity, behind a magic header + version so we can
// validate what we're opening and evolve the shape later. It's the file you
// hand to a colleague or archive at the end of a working session; localStorage
// autosave is the within-machine convenience, the .sce is the artifact.

import type { SceloProject, StoredSessionSnapshot } from "./sceloContext";

export const SCE_MAGIC = "scelo-project";
export const SCE_VERSION = 1;
export const SCE_EXTENSION = ".sce";
/** Custom MIME so the OS can (optionally) associate .sce with Scelo. */
export const SCE_MIME = "application/vnd.scelo.project+json";

export interface SceProjectFile {
  format: typeof SCE_MAGIC;
  version: number;
  app: "Scelo";
  /** ISO timestamp stamped by the caller (the browser has the clock). */
  savedAt: string;
  project: SceloProject | null;
  session: StoredSessionSnapshot;
}

// ── filename ─────────────────────────────────────────────────────────────────

/** Lowercase, filesystem-safe stem — never empty. Underscores and hyphens are
 *  kept (they read fine in filenames); any other punctuation collapses to a
 *  hyphen. */
function slugify(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "scelo-project";
}

/** Suggested download name: the project name, else the dataset name, else a
 *  generic stem — always ending in .sce. */
export function suggestSceFilename(
  project: SceloProject | null,
  datasetName: string | null | undefined,
): string {
  const base =
    project?.name ?? (datasetName ? datasetName.replace(/\.(csv|tsv|parquet)$/i, "") : null);
  return `${slugify(base ?? "scelo-project")}${SCE_EXTENSION}`;
}

// ── serialise ────────────────────────────────────────────────────────────────

export function buildSceFile(
  session: StoredSessionSnapshot,
  project: SceloProject | null,
  savedAt: string,
): SceProjectFile {
  return { format: SCE_MAGIC, version: SCE_VERSION, app: "Scelo", savedAt, project, session };
}

/** Serialise + trigger a browser download of `<name>.sce`. Returns the row
 *  count written so the caller can surface "saved N rows". */
export function downloadSce(
  session: StoredSessionSnapshot,
  project: SceloProject | null,
  datasetName: string | null | undefined,
): { filename: string; bytes: number } {
  const file = buildSceFile(session, project, new Date().toISOString());
  const json = JSON.stringify(file);
  const blob = new Blob([json], { type: SCE_MIME });
  const filename = suggestSceFilename(project, datasetName);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click's navigation has committed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { filename, bytes: blob.size };
}

// ── parse ────────────────────────────────────────────────────────────────────

export interface ParsedSce {
  session: StoredSessionSnapshot;
  project: SceloProject | null;
  savedAt: string | null;
}

/** Parse + validate a .sce file's text. Throws an Error with a user-facing
 *  message on anything malformed — the caller surfaces it in the UI. */
export function parseSce(text: string): ParsedSce {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON — it may be corrupted or not a .sce project file.");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Not a Scelo project file (empty or non-object).");
  }
  const obj = raw as Partial<SceProjectFile>;
  if (obj.format !== SCE_MAGIC) {
    throw new Error("Not a Scelo project file — missing the scelo-project header.");
  }
  if (typeof obj.version !== "number" || obj.version > SCE_VERSION) {
    throw new Error(
      `This .sce was saved by a newer version of Scelo (file v${obj.version ?? "?"}, this app reads up to v${SCE_VERSION}). Update Scelo to open it.`,
    );
  }
  const session = obj.session as StoredSessionSnapshot | undefined;
  if (!session || typeof session !== "object" || !("dataset" in session)) {
    throw new Error("This .sce is missing its session data — nothing to restore.");
  }
  // Normalise: fill any fields an older/hand-edited file might omit so the
  // restore never hits an undefined it doesn't expect.
  const normalised: StoredSessionSnapshot = {
    dataset: session.dataset ?? null,
    filters: Array.isArray(session.filters) ? session.filters : [],
    selectedModels: Array.isArray(session.selectedModels) ? session.selectedModels : [],
    domain: session.domain ?? null,
    pickSummary: session.pickSummary ?? null,
    picksDatasetName: session.picksDatasetName ?? null,
    modelWires: Array.isArray(session.modelWires) ? session.modelWires : [],
    runs: session.runs && typeof session.runs === "object" ? session.runs : {},
    derivedColumns:
      session.derivedColumns && typeof session.derivedColumns === "object"
        ? session.derivedColumns
        : {},
    transformLog: Array.isArray(session.transformLog) ? session.transformLog : [],
    events: Array.isArray(session.events) ? session.events : [],
  };
  const project =
    obj.project && typeof obj.project === "object" && typeof obj.project.name === "string"
      ? obj.project
      : null;
  return { session: normalised, project, savedAt: obj.savedAt ?? null };
}
