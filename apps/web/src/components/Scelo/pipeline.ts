// Pipeline planning for the Tools canvas wiring. The wires between model
// nodes are not decoration: they define a DAG that (a) orders execution so
// upstream models run first and (b) tells each runner which upstream
// results to consume (chain-ladder ultimates seeding Bornhuetter-Ferguson's
// a-priori, a fitted Lee-Carter table pricing the annuity, GBM importances
// feeding SHAP, …).
//
// Kept dependency-free and pure so the plan is unit-testable.

export type ModelWire = {
  /** Upstream model id (catalog id, e.g. "chain-ladder"). */
  source: string;
  /** Downstream model id that consumes the source's result. */
  target: string;
};

export type PipelinePlan = {
  /** Execution order: every wire source runs before its targets. Models the
   *  wires don't mention keep their original selection order. */
  order: string[];
  /** target id → wired-in source ids (selection-filtered, deduped). */
  upstreamOf: Map<string, string[]>;
  /** True when the wires contain a cycle — order falls back to the
   *  selection order and the cycle's edges still appear in upstreamOf. */
  cyclic: boolean;
};

/**
 * Topologically order `modelIds` under `wires` (Kahn's algorithm). Stable:
 * among ready nodes, the original selection order wins, so an unwired mix
 * runs exactly as it always did. Wires whose endpoints aren't both in the
 * current selection are ignored. Self-wires are ignored.
 */
export function pipelinePlan(modelIds: string[], wires: ModelWire[]): PipelinePlan {
  const inSelection = new Set(modelIds);
  const upstreamOf = new Map<string, string[]>();
  const downstreamOf = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of modelIds) indegree.set(id, 0);

  const seen = new Set<string>();
  for (const w of wires) {
    if (!inSelection.has(w.source) || !inSelection.has(w.target)) continue;
    if (w.source === w.target) continue;
    const key = `${w.source}→${w.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    upstreamOf.set(w.target, [...(upstreamOf.get(w.target) ?? []), w.source]);
    downstreamOf.set(w.source, [...(downstreamOf.get(w.source) ?? []), w.target]);
    indegree.set(w.target, (indegree.get(w.target) ?? 0) + 1);
  }

  // Kahn with a selection-ordered ready list for stability.
  const order: string[] = [];
  const ready = modelIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const degrees = new Map(indegree);
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of downstreamOf.get(id) ?? []) {
      const d = (degrees.get(next) ?? 0) - 1;
      degrees.set(next, d);
      if (d === 0) {
        // Insert respecting the original selection order among waiting nodes.
        const pos = modelIds.indexOf(next);
        const at = ready.findIndex((r) => modelIds.indexOf(r) > pos);
        if (at === -1) ready.push(next);
        else ready.splice(at, 0, next);
      }
    }
  }

  const cyclic = order.length !== modelIds.length;
  return {
    order: cyclic ? [...modelIds] : order,
    upstreamOf,
    cyclic,
  };
}
