// Scelo-wide state shared across the macro view and the three drill-ins
// (Soft Data, Tools, Hard Data). Lives at the Scelo route level so the user's
// dataset and model picks survive flipping between sub-routes without
// re-uploading or re-selecting. Resets when the user leaves /dashboards/scelo
// entirely.

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Dataset, Filter } from "./SoftDataWorkstation";
import { type ActivityEvent, isDuplicateOfLast, trimEventsPreservingAnchors } from "./activityLog";
import type { ModelFamily } from "./modelCatalog";
import type { RunResult } from "./modelRunner";

export type SelectedModel = {
  id: string;
  enabled: boolean;
  source: "ai" | "user";
  rationale?: string;
};

// Two operating modes set at the macro view. "explore" is the default —
// transient session, nothing persisted to localStorage. "project" gives the
// session a name + id, which downstream chats use as a memory key so the
// conversation survives reloads and route changes.
export type SceloMode = "project" | "explore";

export type SceloProject = {
  id: string;
  name: string;
  createdAt: number;
};

const PROJECT_STORAGE_KEY = "scelo:project-state";
// Full-session snapshot key. Stores dataset + filters + model picks +
// runs + derived columns + activity log so navigating between Scelo
// and other top-level routes (workspace / swarm / settings) doesn't
// nuke in-progress work. Cleared only by the explicit "Reset Scelo"
// affordance. Size capped on save (dataset rows trimmed, events
// capped) so we don't blow the localStorage 5 MB ceiling.
const SESSION_STORAGE_KEY = "scelo:session-snapshot.v1";
const SESSION_MAX_ROWS = 5000;
// When even the 5k-row snapshot overflows the quota, retry with this much
// smaller slice before dropping rows entirely — a 1k sample still lets the
// workstations render something real after a reload.
const SESSION_FALLBACK_ROWS = 1000;
const SESSION_MAX_EVENTS = 200;
// In-memory ceiling for the activity log — logEvent trims past this so a
// marathon session can't grow the array (and every downstream memo that
// walks it) without bound. Well above SESSION_MAX_EVENTS so persistence,
// not memory, remains the tighter constraint.
const MEMORY_MAX_EVENTS = 1000;

type StoredProjectState = {
  mode: SceloMode;
  project: SceloProject | null;
};

interface StoredSessionSnapshot {
  dataset: Dataset | null;
  filters: Filter[];
  selectedModels: SelectedModel[];
  domain: ModelFamily | null;
  pickSummary: string | null;
  /** Which dataset (by name) the current model picks were computed for.
   *  Lets the Tools node tell "picks curated for THIS data" apart from
   *  stale picks left over from a previous dataset — including across a
   *  reload, where a mount-time guess can't. */
  picksDatasetName: string | null;
  runs: Record<string, RunResult>;
  derivedColumns: Record<string, string>;
  /** Serialised as array since JSON doesn't carry Set. */
  transformLog: string[];
  events: ActivityEvent[];
}

const EMPTY_SESSION: StoredSessionSnapshot = {
  dataset: null,
  filters: [],
  selectedModels: [],
  domain: null,
  pickSummary: null,
  picksDatasetName: null,
  runs: {},
  derivedColumns: {},
  transformLog: [],
  events: [],
};

function loadStoredProject(): StoredProjectState {
  if (typeof localStorage === "undefined") return { mode: "explore", project: null };
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return { mode: "explore", project: null };
    const parsed = JSON.parse(raw) as Partial<StoredProjectState>;
    const mode: SceloMode = parsed.mode === "project" ? "project" : "explore";
    const project =
      mode === "project" &&
      parsed.project &&
      typeof parsed.project.id === "string" &&
      typeof parsed.project.name === "string"
        ? {
            id: parsed.project.id,
            name: parsed.project.name,
            createdAt: Number(parsed.project.createdAt) || Date.now(),
          }
        : null;
    return { mode: project ? "project" : "explore", project };
  } catch {
    return { mode: "explore", project: null };
  }
}

function loadStoredSession(): StoredSessionSnapshot {
  if (typeof localStorage === "undefined") return EMPTY_SESSION;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return EMPTY_SESSION;
    const parsed = JSON.parse(raw) as Partial<StoredSessionSnapshot>;
    return {
      dataset: (parsed.dataset as Dataset | null) ?? null,
      filters: Array.isArray(parsed.filters) ? (parsed.filters as Filter[]) : [],
      selectedModels: Array.isArray(parsed.selectedModels)
        ? (parsed.selectedModels as SelectedModel[])
        : [],
      domain: (parsed.domain as ModelFamily | null) ?? null,
      pickSummary: typeof parsed.pickSummary === "string" ? parsed.pickSummary : null,
      picksDatasetName:
        typeof parsed.picksDatasetName === "string" ? parsed.picksDatasetName : null,
      runs:
        parsed.runs && typeof parsed.runs === "object"
          ? (parsed.runs as Record<string, RunResult>)
          : {},
      derivedColumns:
        parsed.derivedColumns && typeof parsed.derivedColumns === "object"
          ? (parsed.derivedColumns as Record<string, string>)
          : {},
      transformLog: Array.isArray(parsed.transformLog) ? (parsed.transformLog as string[]) : [],
      events: Array.isArray(parsed.events) ? (parsed.events as ActivityEvent[]) : [],
    };
  } catch {
    return EMPTY_SESSION;
  }
}

// Dataset provenance fields the import pipeline stamps on sampled loads.
// Widened locally so the persistence path can read/write them regardless
// of whether the base Dataset type declares them yet.
type PersistedDataset = Dataset & { sampled?: boolean; sourceTotalRows?: number };

// Cap a dataset's rows for persistence. Whenever rows are actually dropped
// the snapshot is stamped with `sampled: true` and `sourceTotalRows` (the
// full in-memory row count at save time) so the rehydrated dataset
// self-describes its truncation — the Soft Data workstation banners on
// sourceTotalRows > rows.length. An import-sampled dataset already carries
// the source file's true total; never overwrite it with the smaller
// in-memory count.
export function sliceDatasetForPersist(
  dataset: PersistedDataset,
  maxRows: number,
): PersistedDataset {
  if (dataset.rows.length <= maxRows) return dataset;
  return {
    ...dataset,
    rows: dataset.rows.slice(0, maxRows),
    sampled: true,
    sourceTotalRows: dataset.sourceTotalRows ?? dataset.rows.length,
  };
}

function saveStoredSession(snap: StoredSessionSnapshot): void {
  if (typeof localStorage === "undefined") return;
  // Cap dataset rows + events before serialising so we don't blow the
  // quota on big uploads. The cap is generous (5k rows is plenty for
  // workstation interaction; full computes happen in the bridges). The
  // event trim pins the most recent dataset.load / models.aiPick so the
  // script exporters never lose their read_csv step after a reload.
  const dataset = snap.dataset ? sliceDatasetForPersist(snap.dataset, SESSION_MAX_ROWS) : null;
  const trimmed: StoredSessionSnapshot = {
    ...snap,
    dataset,
    events: trimEventsPreservingAnchors(snap.events, SESSION_MAX_EVENTS),
  };
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // QuotaExceededError most likely : the dataset crossed the 5 MB
    // localStorage ceiling even after row-capping. Retry with a much
    // smaller slice, then with no rows at all — every attempt keeps the
    // rest of the session (model picks, derived-column formulas) and the
    // honest sampled/sourceTotalRows stamp so a reload can still tell the
    // user what was dropped.
    const totalRows = snap.dataset?.rows.length ?? 0;
    for (const cap of [SESSION_FALLBACK_ROWS, 0]) {
      try {
        const smaller = snap.dataset ? sliceDatasetForPersist(snap.dataset, cap) : null;
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...trimmed, dataset: smaller }));
        console.warn(
          `Scelo session snapshot exceeded the localStorage quota — kept ${cap.toLocaleString()} of ${totalRows.toLocaleString()} dataset rows.`,
        );
        return;
      } catch {
        // Still too big — fall through to the next, smaller cap.
      }
    }
    console.warn(
      "Scelo session snapshot exceeded the localStorage quota — the session could not be persisted and will not survive a reload.",
    );
  }
}

export function clearSceloSession(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

type SceloState = {
  dataset: Dataset | null;
  setDataset: (d: Dataset | null) => void;
  filters: Filter[];
  setFilters: (f: Filter[] | ((prev: Filter[]) => Filter[])) => void;
  selectedModels: SelectedModel[];
  setSelectedModels: (m: SelectedModel[] | ((prev: SelectedModel[]) => SelectedModel[])) => void;
  domain: ModelFamily | null;
  setDomain: (d: ModelFamily | null) => void;
  pickSummary: string | null;
  setPickSummary: (s: string | null) => void;
  // Which dataset (by name) the current picks were computed for — set by
  // the Tools node when a pick lands, compared on mount / dataset swap so
  // stale picks from a previous dataset trigger re-identification even
  // across a full reload.
  picksDatasetName: string | null;
  setPicksDatasetName: (n: string | null) => void;
  // Additional offline imports staged for combining with the active dataset
  // (at most 2 staged + 1 active = 3). Session-only — deliberately NOT
  // persisted: staged files can be big, and a combine is expected to happen
  // in the same sitting it was staged in.
  stagedDatasets: Dataset[];
  setStagedDatasets: (d: Dataset[] | ((prev: Dataset[]) => Dataset[])) => void;
  // Results from the (mock) model runner — keyed by model id. Cleared
  // automatically when the dataset changes upstream so stale outputs
  // never leak between Soft Data swaps.
  runs: Record<string, RunResult>;
  setRuns: (
    r: Record<string, RunResult> | ((prev: Record<string, RunResult>) => Record<string, RunResult>),
  ) => void;
  // Derived columns — column name → formula source. The actual computed
  // values live on `dataset.columns` / `dataset.rows`; this map is what
  // lets the UI badge them and (later) recompute when source columns
  // change. Cleared whenever a fresh dataset replaces the current one.
  derivedColumns: Record<string, string>;
  setDerivedColumns: (
    r: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  // In-place transform log — fingerprints of (column + formula) that the
  // chat agent has applied as `transform` actions, keyed so the chat can
  // mark a re-render of the same reply as "already applied" rather than
  // running the transform a second time. Cleared with the dataset.
  transformLog: Set<string>;
  setTransformLog: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  // Activity log — chronological record of every major user action (data
  // load, filters, cleaning, derived columns, model picks, runs). Feeds the
  // Export Screen's Python / R / C++ / prompt generators. In-memory only;
  // cleared whenever a fresh dataset replaces the current one because the
  // log only makes sense in the context of a single dataset session.
  events: ActivityEvent[];
  logEvent: (e: Omit<ActivityEvent, "ts">) => void;
  clearEvents: () => void;
  // Project / mode — drives chat-memory persistence. `chatMemoryPrefix` is
  // the canonical key suffix child chats should use when constructing their
  // memoryKey ("<project.id>"), or null when memory is off.
  mode: SceloMode;
  project: SceloProject | null;
  chatMemoryPrefix: string | null;
  startProject: (name: string) => void;
  endProject: () => void;
};

const SceloContext = createContext<SceloState | null>(null);

export function SceloProvider({ children }: { children: ReactNode }) {
  // Hydrate the full working session from localStorage on mount so a
  // round-trip to /workspace, /swarm, /settings, or even a full
  // reload doesn't nuke the user's progress. Only the explicit
  // "Reset Scelo" affordance + clearSceloSession() drop it.
  const [storedSession] = useState<StoredSessionSnapshot>(() => loadStoredSession());
  const [dataset, setDataset] = useState<Dataset | null>(storedSession.dataset);
  const [filters, setFilters] = useState<Filter[]>(storedSession.filters);
  const [selectedModels, setSelectedModels] = useState<SelectedModel[]>(
    storedSession.selectedModels,
  );
  const [domain, setDomain] = useState<ModelFamily | null>(storedSession.domain);
  const [pickSummary, setPickSummary] = useState<string | null>(storedSession.pickSummary);
  const [picksDatasetName, setPicksDatasetName] = useState<string | null>(
    storedSession.picksDatasetName,
  );
  const [stagedDatasets, setStagedDatasets] = useState<Dataset[]>([]);
  const [runs, setRuns] = useState<Record<string, RunResult>>(storedSession.runs);
  const [derivedColumns, setDerivedColumns] = useState<Record<string, string>>(
    storedSession.derivedColumns,
  );
  const [transformLog, setTransformLog] = useState<Set<string>>(
    () => new Set(storedSession.transformLog),
  );
  const [events, setEvents] = useState<ActivityEvent[]>(storedSession.events);

  // Debounced persist : we want every meaningful change saved, but a
  // burst of state updates (model picker firing through 5 fields in
  // one render cycle) shouldn't trigger 5 stringify+setItem calls.
  // 400ms is invisible to the user but lets a burst settle first.
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveStoredSession({
        dataset,
        filters,
        selectedModels,
        domain,
        pickSummary,
        picksDatasetName,
        runs,
        derivedColumns,
        transformLog: Array.from(transformLog),
        events,
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [
    dataset,
    filters,
    selectedModels,
    domain,
    pickSummary,
    picksDatasetName,
    runs,
    derivedColumns,
    transformLog,
    events,
  ]);

  const logEvent = useCallback((next: Omit<ActivityEvent, "ts">) => {
    setEvents((prev) => {
      const stamped = { ...next, ts: Date.now() } as ActivityEvent;
      if (isDuplicateOfLast(prev, stamped)) return prev;
      // Cap the in-memory log so it can't grow unbounded across a long
      // session; the anchor-pinning trim keeps dataset.load / models.aiPick
      // reachable for the exporters even past the cap.
      return trimEventsPreservingAnchors([...prev, stamped], MEMORY_MAX_EVENTS);
    });
  }, []);
  const clearEvents = useCallback(() => setEvents([]), []);

  // Project / mode state hydrates from localStorage so a reload of
  // /dashboards/scelo lands the user back in the same project they were in.
  const [storedProject] = useState<StoredProjectState>(() => loadStoredProject());
  const [mode, setMode] = useState<SceloMode>(storedProject.mode);
  const [project, setProject] = useState<SceloProject | null>(storedProject.project);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({ mode, project }));
    } catch {
      // ignore — we'd rather silently lose persistence than crash the app
    }
  }, [mode, project]);

  const startProject = useCallback((name: string) => {
    const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setProject({ id, name: name.trim() || "Untitled project", createdAt: Date.now() });
    setMode("project");
  }, []);

  const endProject = useCallback(() => {
    setProject(null);
    setMode("explore");
  }, []);

  const chatMemoryPrefix = mode === "project" && project ? project.id : null;

  const value = useMemo(
    () => ({
      dataset,
      setDataset,
      filters,
      setFilters,
      selectedModels,
      setSelectedModels,
      domain,
      setDomain,
      pickSummary,
      setPickSummary,
      picksDatasetName,
      setPicksDatasetName,
      stagedDatasets,
      setStagedDatasets,
      runs,
      setRuns,
      derivedColumns,
      setDerivedColumns,
      transformLog,
      setTransformLog,
      events,
      logEvent,
      clearEvents,
      mode,
      project,
      chatMemoryPrefix,
      startProject,
      endProject,
    }),
    [
      dataset,
      filters,
      selectedModels,
      domain,
      pickSummary,
      picksDatasetName,
      stagedDatasets,
      runs,
      derivedColumns,
      transformLog,
      events,
      logEvent,
      clearEvents,
      mode,
      project,
      chatMemoryPrefix,
      startProject,
      endProject,
    ],
  );

  return <SceloContext.Provider value={value}>{children}</SceloContext.Provider>;
}

export function useScelo(): SceloState {
  const ctx = useContext(SceloContext);
  if (!ctx) throw new Error("useScelo must be used within <SceloProvider>");
  return ctx;
}
