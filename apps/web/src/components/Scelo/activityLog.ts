// Chronological log of every meaningful action the user has taken in the
// Scelo workstation — plus the AI-initiated picks that the orchestrator
// makes on the user's behalf (model selection, etc).
//
// The log is the source of truth for the Export Screen: the Python / R /
// C++ generators walk it in order to emit reproducible scripts, and the
// "prompt" tab serialises it into a copy-pasteable LLM prompt. We log
// MAJOR actions only (one entry per user-meaningful event) — every chat
// message is NOT logged.

import type { Filter } from "./SoftDataWorkstation";
import type { ModelFamily } from "./modelCatalog";

export type Stage = "soft" | "tools" | "hard";

// Each event carries the absolute monotonic timestamp at which it fired
// (`ts`), the workstation it occurred in (`stage`), the verb (`kind`), and
// a payload tailored to that verb. Adding a new event is: extend the union
// here → add a constructor → handle it in `scriptExporter` for each language.
export type ActivityEvent =
  | {
      ts: number;
      stage: "soft";
      kind: "dataset.load";
      payload: {
        name: string;
        rows: number;
        cols: number;
        columns: string[];
        source: "import" | "sample";
      };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "dataset.clear";
      payload: Record<string, never>;
    }
  | {
      ts: number;
      stage: "soft";
      kind: "dataset.combine";
      payload: {
        name: string;
        rows: number;
        cols: number;
        truncated: boolean;
        steps: Array<{
          dataset: string;
          strategy: string;
          key?: string;
          matched: number;
          unmatched: number;
          duplicateRightKeys?: number;
          outputRows?: number;
          outputColumns?: number;
        }>;
      };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "filter.add";
      payload: { description: string; column: string; spec: Filter };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "filter.remove";
      payload: { description: string; column: string };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "filters.clearAll";
      payload: Record<string, never>;
    }
  | {
      ts: number;
      stage: "soft";
      kind: "cleaning.apply";
      payload: { opLabels: string[] };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "cleaning.reformat-dates";
      payload: { style: "iso" | "us" | "eu"; columns: string[]; changed: number };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "cleaning.column";
      // Per-column micro-clean from the column chat (e.g. "remove all
      // non-dates", "clean this column"). `action` is a short human label;
      // `affected` is the count of cells changed.
      payload: { column: string; action: string; affected: number };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "data.augment";
      // Synthetic rows appended via the soft chat ("add 1000 rows through
      // augmentation"). `method` is a short human label for how.
      payload: { added: number; method: string };
    }
  | {
      ts: number;
      stage: "soft";
      kind: "derived.add";
      payload: { name: string; formula: string };
    }
  | {
      ts: number;
      stage: "tools";
      kind: "models.aiPick";
      payload: {
        domain: ModelFamily;
        models: Array<{ id: string; rationale?: string }>;
        summary: string;
        source: "ai" | "fallback";
      };
    }
  | {
      ts: number;
      stage: "tools";
      kind: "model.toggle";
      payload: { id: string; enabled: boolean };
    }
  | {
      ts: number;
      stage: "tools";
      kind: "model.add";
      payload: { id: string };
    }
  | {
      ts: number;
      stage: "tools";
      kind: "model.remove";
      payload: { id: string };
    }
  | {
      ts: number;
      stage: "hard";
      kind: "runs.execute";
      payload: { models: string[] };
    }
  | {
      ts: number;
      stage: "hard";
      kind: "workspace.validate";
      // The global-workspace validation of a result: which readout it was taken
      // against, the effective dimension, the swap-consistency R2, and the
      // named directions. Reproducible from the exported script.
      payload: {
        modelId: string;
        readout: string;
        participationRatio: number;
        swapR2: number | null;
        directions: string[];
      };
    };

// Returns true when the new event is the same kind as the most recent
// event AND its payload is identical — used to collapse react-effect storms
// (e.g. a single user click that flips two pieces of state shouldn't log
// twice). Uses structural equality so we don't have to special-case each
// payload shape.
export function isDuplicateOfLast(events: ActivityEvent[], next: ActivityEvent): boolean {
  if (events.length === 0) return false;
  const last = events[events.length - 1];
  if (last.kind !== next.kind || last.stage !== next.stage) return false;
  try {
    return JSON.stringify(last.payload) === JSON.stringify(next.payload);
  } catch {
    return false;
  }
}

// Event kinds the script exporters cannot reconstruct from anything else:
// `dataset.load` carries the read_csv step and `models.aiPick` carries the
// model list. A blind tail-slice of a long session would drop them and the
// exported script would have no data-load step at all.
const ANCHOR_KINDS = ["dataset.load", "models.aiPick"] as const;

// Trim the log to at most `max` events, keeping the most recent entries but
// PINNING the most recent event of each anchor kind even when it falls
// outside the tail. Pinned events displace the oldest tail entries so the
// result never exceeds `max`, and chronological order is preserved (anchors
// pulled from before the tail are, by construction, older than it).
export function trimEventsPreservingAnchors(events: ActivityEvent[], max: number): ActivityEvent[] {
  if (events.length <= max) return events;
  const tail = events.slice(-max);
  const pinned: ActivityEvent[] = [];
  for (const kind of ANCHOR_KINDS) {
    if (tail.some((e) => e.kind === kind)) continue;
    for (let i = events.length - max - 1; i >= 0; i--) {
      if (events[i].kind === kind) {
        pinned.push(events[i]);
        break;
      }
    }
  }
  if (pinned.length === 0) return tail;
  pinned.sort((a, b) => a.ts - b.ts);
  return [...pinned, ...tail.slice(pinned.length)];
}

// Filter the log to events from `stage` AND all stages preceding it in the
// pipeline order soft → tools → hard. Used by the per-workstation export
// buttons so each one reproduces everything that led to the current state
// of that stage (Hard inherits Tools inherits Soft).
const STAGE_ORDER: Stage[] = ["soft", "tools", "hard"];
export function eventsThroughStage(events: ActivityEvent[], stage: Stage): ActivityEvent[] {
  const idx = STAGE_ORDER.indexOf(stage);
  const allowed = new Set(STAGE_ORDER.slice(0, idx + 1));
  return events.filter((e) => allowed.has(e.stage));
}
