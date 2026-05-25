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
