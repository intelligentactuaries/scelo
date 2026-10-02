import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Dataset } from "@scelo/core";
import * as React from "react";
import {
  type HistoryEntry,
  type SelectedModel,
  SceloProvider,
  WIRES_VERSION,
  cameIntoPlay,
  migrateWires,
  restoreColumnsFromSnapshot,
  sliceDatasetForPersist,
  trimHistory,
  useScelo,
} from "./sceloContext";

try {
  GlobalRegistrator.register();
} catch {
  // already registered by a sibling test file in this bun process
}

// Imported AFTER GlobalRegistrator.register() so react-dom sees the
// happy-dom document (the provider tests at the bottom mount it).
const { act, cleanup, render } = await import("@testing-library/react");

// ── fixtures ─────────────────────────────────────────────────────────────

function makeDataset(rowCount: number): Dataset {
  return {
    name: "claims.csv",
    columns: ["id", "sum_insurd"],
    rows: Array.from({ length: rowCount }, (_, i) => ({ id: i, sum_insurd: i * 100 })),
  };
}

describe("sliceDatasetForPersist", () => {
  test("dataset under the cap passes through untouched (same object)", () => {
    const dataset = makeDataset(100);
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out).toBe(dataset);
    expect(out.sampled).toBeUndefined();
    expect(out.sourceTotalRows).toBeUndefined();
  });

  test("dataset over the cap is sliced AND stamped with honest provenance", () => {
    const dataset = makeDataset(12_000);
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out.rows).toHaveLength(5000);
    expect(out.rows[0]).toEqual({ id: 0, sum_insurd: 0 });
    expect(out.sampled).toBe(true);
    // Full in-memory count at save time — the banner's denominator.
    expect(out.sourceTotalRows).toBe(12_000);
    // The live dataset is never mutated.
    expect(dataset.rows).toHaveLength(12_000);
  });

  test("an import-sampled dataset keeps the source file's true total", () => {
    // 2M-row file imported under the 250k row cap, then persisted at 5k:
    // sourceTotalRows must stay 2,000,000, not shrink to 250,000.
    const dataset = {
      ...makeDataset(250_000),
      sampled: true,
      sourceTotalRows: 2_000_000,
    };
    const out = sliceDatasetForPersist(dataset, 5000);
    expect(out.rows).toHaveLength(5000);
    expect(out.sampled).toBe(true);
    expect(out.sourceTotalRows).toBe(2_000_000);
  });

  test("a zero cap (quota last resort) keeps the stamp with no rows", () => {
    const dataset = makeDataset(9000);
    const out = sliceDatasetForPersist(dataset, 0);
    expect(out.rows).toHaveLength(0);
    expect(out.sampled).toBe(true);
    expect(out.sourceTotalRows).toBe(9000);
  });

  test("provenance fields survive the JSON round-trip used by persistence", () => {
    const out = sliceDatasetForPersist(makeDataset(6000), 5000);
    const revived = JSON.parse(JSON.stringify(out)) as typeof out;
    expect(revived.sampled).toBe(true);
    expect(revived.sourceTotalRows).toBe(6000);
    expect(revived.rows).toHaveLength(5000);
  });
});

describe("trimHistory (undo retention)", () => {
  const entry = (label: string, rowCount: number): HistoryEntry => ({
    label,
    dataset: makeDataset(rowCount),
    filters: [],
    derived: {},
    scope: { kind: "table" },
  });

  test("keeps everything when well under both caps", () => {
    const stack = [entry("a", 10), entry("b", 10), entry("c", 10)];
    expect(trimHistory(stack).map((e) => e.label)).toEqual(["a", "b", "c"]);
  });

  test("caps depth, dropping the OLDEST first", () => {
    const stack = Array.from({ length: 20 }, (_, i) => entry(`s${i}`, 1));
    const out = trimHistory(stack);
    expect(out).toHaveLength(12);
    // The newest must survive — it's the one undo reaches first.
    expect(out[out.length - 1].label).toBe("s19");
    expect(out[0].label).toBe("s8");
  });

  test("row budget evicts further on big datasets", () => {
    // 4 × 400k rows = 1.6M, over the 1M budget → oldest dropped until under.
    const stack = Array.from({ length: 4 }, (_, i) => entry(`big${i}`, 400_000));
    const out = trimHistory(stack);
    expect(out.length).toBeLessThan(4);
    expect(out[out.length - 1].label).toBe("big3");
  });

  test("always keeps at least one entry, however large", () => {
    // A single dataset far over the budget must still be undoable — otherwise
    // undo would silently do nothing precisely when the data is most costly
    // to rebuild.
    const out = trimHistory([entry("huge", 5_000_000)]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("huge");
  });

  test("a null dataset (the 'clear' step) counts as zero rows", () => {
    const stack: HistoryEntry[] = [
      { label: "clear dataset", dataset: null, filters: [], derived: {}, scope: { kind: "table" } },
      entry("x", 10),
    ];
    expect(trimHistory(stack)).toHaveLength(2);
  });
});

describe("restoreColumnsFromSnapshot (column-scoped undo)", () => {
  const snapshot: Dataset = {
    name: "t.csv",
    columns: ["a", "b", "c"],
    rows: [
      { a: 1, b: "x", c: 10 },
      { a: 2, b: "y", c: 20 },
    ],
  };

  test("restores only the touched column's values, keeps the rest current", () => {
    // Snapshot → op uppercased `b` → later (untracked) tweak bumped `c`.
    const current: Dataset = {
      name: "t.csv",
      columns: ["a", "b", "c"],
      rows: [
        { a: 1, b: "X", c: 11 },
        { a: 2, b: "Y", c: 21 },
      ],
    };
    const out = restoreColumnsFromSnapshot(current, snapshot, ["b"]);
    // b reverted…
    expect(out.rows.map((r) => r.b)).toEqual(["x", "y"]);
    // …while c keeps its CURRENT values — a column undo must not time-travel
    // the rest of the grid.
    expect(out.rows.map((r) => r.c)).toEqual([11, 21]);
    expect(out.columns).toEqual(["a", "b", "c"]);
  });

  test("removes a column the step added (derived-column undo)", () => {
    const current: Dataset = {
      name: "t.csv",
      columns: ["a", "b", "c", "d"],
      rows: [
        { a: 1, b: "x", c: 10, d: 100 },
        { a: 2, b: "y", c: 20, d: 200 },
      ],
    };
    const out = restoreColumnsFromSnapshot(current, snapshot, ["d"]);
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.rows[0]).toEqual({ a: 1, b: "x", c: 10 });
  });

  test("re-inserts a dropped column at its old position, with its values", () => {
    const current: Dataset = {
      name: "t.csv",
      columns: ["a", "c"],
      rows: [
        { a: 1, c: 10 },
        { a: 2, c: 20 },
      ],
    };
    const out = restoreColumnsFromSnapshot(current, snapshot, ["b"]);
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.rows.map((r) => r.b)).toEqual(["x", "y"]);
  });

  test("undoes a rename when both names are in scope", () => {
    // `b` was renamed to `b_new`: snapshot has b, current has b_new.
    const current: Dataset = {
      name: "t.csv",
      columns: ["a", "b_new", "c"],
      rows: [
        { a: 1, b_new: "x", c: 10 },
        { a: 2, b_new: "y", c: 20 },
      ],
    };
    const out = restoreColumnsFromSnapshot(current, snapshot, ["b", "b_new"]);
    expect(out.columns).toEqual(["a", "b", "c"]);
    expect(out.rows.map((r) => r.b)).toEqual(["x", "y"]);
    expect("b_new" in out.rows[0]).toBe(false);
  });
});

// ── wiring: which models get default wires ─────────────────────────────────

const pick = (id: string, enabled: boolean): SelectedModel => ({ id, enabled, source: "ai" });

describe("cameIntoPlay", () => {
  test("models new to the canvas come into play, switched on or off", () => {
    expect(cameIntoPlay(new Map(), [pick("gbm", true), pick("shap", false)])).toEqual(
      new Set(["gbm", "shap"]),
    );
  });

  test("a model switched on comes into play; one already on does not", () => {
    const before = new Map([
      ["gbm", false],
      ["shap", true],
    ]);
    expect(cameIntoPlay(before, [pick("gbm", true), pick("shap", true)])).toEqual(new Set(["gbm"]));
  });

  test("switching a model off is not coming into play", () => {
    expect(cameIntoPlay(new Map([["gbm", true]]), [pick("gbm", false)])).toEqual(new Set());
  });
});

describe("migrateWires", () => {
  const models = ["glm-frequency", "glm-severity", "gbm", "shap"].map((id) => pick(id, true));

  test("a version-2 canvas gets its empty required inputs plugged, nothing more", () => {
    expect(migrateWires({ selectedModels: models, modelWires: [], wiresVersion: 2 })).toEqual([
      { source: "gbm", target: "shap" },
    ]);
  });

  test("a current canvas is taken exactly as saved", () => {
    expect(
      migrateWires({ selectedModels: models, modelWires: [], wiresVersion: WIRES_VERSION }),
    ).toEqual([]);
  });

  test("a pre-typed canvas gets today's full default wiring", () => {
    expect(migrateWires({ selectedModels: models, modelWires: [] })).toEqual([
      { source: "glm-frequency", target: "glm-severity" },
      { source: "gbm", target: "shap" },
    ]);
  });
});

describe("SceloProvider wiring", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  /** Mount the provider with a probe that keeps the latest context. */
  function mount() {
    const captured: { ctx?: ReturnType<typeof useScelo> } = {};
    function Probe() {
      captured.ctx = useScelo();
      return null;
    }
    render(React.createElement(SceloProvider, null, React.createElement(Probe)));
    return () => captured.ctx as ReturnType<typeof useScelo>;
  }

  test("a re-pick that switches GBM on wires it to the SHAP waiting on it", async () => {
    const ctx = mount();
    // The pick for a dataset GBM can't learn from: both arrive switched off.
    await act(async () => {
      ctx().setSelectedModels([pick("descriptive", true), pick("gbm", false), pick("shap", false)]);
    });
    expect(ctx().modelWires).toEqual([]);
    // New data, new pick: the same two, now switched on.
    await act(async () => {
      ctx().setSelectedModels([
        pick("workspace-bottleneck", true),
        pick("descriptive", true),
        pick("gbm", true),
        pick("shap", true),
      ]);
    });
    expect(ctx().modelWires).toEqual([{ source: "gbm", target: "shap" }]);
  });

  test("switching GBM on with its toggle wires it too", async () => {
    const ctx = mount();
    await act(async () => {
      ctx().setSelectedModels([pick("gbm", false), pick("shap", true)]);
    });
    expect(ctx().modelWires).toEqual([]);
    await act(async () => {
      ctx().setSelectedModels((prev) => prev.map((m) => ({ ...m, enabled: true })));
    });
    expect(ctx().modelWires).toEqual([{ source: "gbm", target: "shap" }]);
  });

  test("a wire the actuary unplugged stays unplugged as the stack changes", async () => {
    const ctx = mount();
    await act(async () => {
      ctx().setSelectedModels([pick("gbm", true), pick("shap", true)]);
    });
    expect(ctx().modelWires).toEqual([{ source: "gbm", target: "shap" }]);
    await act(async () => {
      ctx().setModelWires([]);
    });
    await act(async () => {
      ctx().setSelectedModels((prev) => [...prev, pick("descriptive", true)]);
    });
    expect(ctx().modelWires).toEqual([]);
  });

  test("a fresh pick wires its models whole, even ones already on the canvas", async () => {
    const ctx = mount();
    await act(async () => {
      ctx().setSelectedModels([pick("gbm", true), pick("shap", true)]);
    });
    // e.g. a canvas left unwired by the earlier arrivals-only wiring
    await act(async () => {
      ctx().setModelWires([]);
    });
    await act(async () => {
      ctx().adoptPick([pick("gbm", true), pick("shap", true)]);
    });
    expect(ctx().modelWires).toEqual([{ source: "gbm", target: "shap" }]);
  });
});
