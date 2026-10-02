// Typed pins for the Tools canvas — the Blueprint layer.
//
// Unreal's Blueprint graphs read at a glance because every pin is typed:
// inputs on the left, outputs on the right, a pin only where something
// actually flows, pins and wires coloured by what they carry, and a wire can
// only join pins whose types agree. This module is that contract for Scelo's
// models. It is the single source of truth for:
//
//   · what each model READS — from the dataset (a claims triangle, a
//     mortality table, model points …) or from another model's result;
//   · what each model OFFERS downstream — only results some other model
//     actually consumes get an output pin;
//   · which wires are legal, which input a wire lands on, and how new
//     models are wired into what is already on the canvas.
//
// Every model→model port here is backed by a runner that consumes it (see
// the "wired pipeline" tests). The old canvas drew decorative arrows that
// fed nothing — mack → bootstrap "+ simulation", lee-carter → cbd
// "compare", glm-severity → gbm "vs nonlinear", climada → parametric — or
// degenerated: a chain-ladder-seeded Bornhuetter–Ferguson reproduces chain
// ladder exactly (prior Ĉ·F × (1 − 1/F) = Ĉ·(F − 1), the CL reserve), and
// Mack / the bootstrap refit chain ladder themselves. Those are not pins.
//
// Pure and dependency-light (catalog only) so the session provider, the
// canvas and the tests share it.

import { MODEL_CATALOG } from "./modelCatalog";
import type { ModelWire } from "./pipeline";

// ── port types ──────────────────────────────────────────────────────────────

/** Roles the DATASET can play — offered by the dataset hub's output pins. */
export type DataPortType =
  | "triangle"
  | "mortality"
  | "model-points"
  | "counts"
  | "amounts"
  | "factors"
  | "target"
  | "exposure"
  | "numeric"
  | "wmtr-params";

/** Results one model hands another. */
export type ResultPortType = "projection" | "frequency" | "gbm-model" | "scenarios";

export type PortType = DataPortType | ResultPortType;

export type PortTypeInfo = {
  /** Short noun shown beside the pin ("claims triangle"). */
  label: string;
  /** The noun as a sentence takes it ("a claims triangle", "claim counts"). */
  phrase: string;
  /** Where values of this type come from: the dataset, or a model. */
  provenance: "data" | "result";
  /** What travels on a wire of this type — pin tooltip. */
  description: string;
  /** Pin / wire colour, per theme. */
  color: { dark: string; light: string };
};

export const PORT_TYPES: Record<PortType, PortTypeInfo> = {
  triangle: {
    label: "claims triangle",
    phrase: "a claims triangle",
    provenance: "data",
    description: "Cumulative paid claims by origin year × development period.",
    color: { dark: "#00d68f", light: "#009669" },
  },
  mortality: {
    label: "mortality table",
    phrase: "a mortality table",
    provenance: "data",
    description: "Death rates by age (and by calendar year, to project).",
    color: { dark: "#7aa2f7", light: "#3760cc" },
  },
  "model-points": {
    label: "model points",
    phrase: "model points",
    provenance: "data",
    description: "Policy-level model points: entry age, sum assured, policy term.",
    color: { dark: "#f48fb1", light: "#b73a73" },
  },
  counts: {
    label: "claim counts",
    phrase: "claim counts",
    provenance: "data",
    description: "A claim-count column — small whole numbers per policy.",
    color: { dark: "#5dd6c8", light: "#117a72" },
  },
  amounts: {
    label: "claim amounts",
    phrase: "claim amounts",
    provenance: "data",
    description: "A monetary claim / loss column.",
    color: { dark: "#f7768e", light: "#c0405a" },
  },
  factors: {
    label: "rating factors",
    phrase: "rating factors",
    provenance: "data",
    description: "Categorical columns with 2–20 levels a GLM can rate on.",
    color: { dark: "#c3e88d", light: "#5b8a1f" },
  },
  target: {
    label: "target & features",
    phrase: "a target and features",
    provenance: "data",
    description: "A response column to predict and the columns to predict it from.",
    color: { dark: "#bb9af7", light: "#7649c7" },
  },
  exposure: {
    label: "exposure",
    phrase: "an exposure column",
    provenance: "data",
    description: "Sum insured / TIV / exposure — what a hazard can damage.",
    color: { dark: "#ffb454", light: "#ae6614" },
  },
  numeric: {
    label: "numeric columns",
    phrase: "numeric columns",
    provenance: "data",
    description: "The dataset's numeric columns.",
    color: { dark: "#a9a9a4", light: "#5c5c5a" },
  },
  "wmtr-params": {
    label: "WMTR parameters",
    phrase: "WMTR parameters",
    provenance: "data",
    description: "α_M / α_T / α_R exponents (and weights, shock, horizon) for the forecast engine.",
    color: { dark: "#73daca", light: "#0d8e7f" },
  },
  projection: {
    label: "projected mortality",
    phrase: "projected mortality",
    provenance: "result",
    description: "A fitted age × year mortality model projected forward — priced as a cohort.",
    color: { dark: "#a9c1ff", light: "#5a78c9" },
  },
  frequency: {
    label: "claim frequency",
    phrase: "a claim frequency",
    provenance: "result",
    description: "Expected claims per policy from the frequency GLM.",
    color: { dark: "#9eeae0", light: "#2e8f86" },
  },
  "gbm-model": {
    label: "fitted GBM",
    phrase: "a fitted GBM",
    provenance: "result",
    description: "The boosted trees themselves, and their exact TreeSHAP attribution.",
    color: { dark: "#d4bfff", light: "#9270d6" },
  },
  scenarios: {
    label: "rate scenarios",
    phrase: "rate scenarios",
    provenance: "result",
    description: "Stochastic interest-rate paths from the scenario generator.",
    color: { dark: "#ff6b6b", light: "#b73a3a" },
  },
};

export function isDataType(t: PortType): t is DataPortType {
  return PORT_TYPES[t].provenance === "data";
}

export function portColor(t: PortType, theme: "light" | "dark"): string {
  return PORT_TYPES[t].color[theme];
}

// ── per-model ports ─────────────────────────────────────────────────────────

export type InputPort = {
  /** Unique within its model — the handle id is `in:<id>`. */
  id: string;
  label: string;
  /** Types this pin takes; the first is its colour. Data types come from
   *  the dataset hub, result types from other models. */
  accepts: PortType[];
  required: boolean;
  /** Optional pins: what the model uses with nothing connected — shown
   *  beside the pin the way Blueprints show an unplugged pin's default. */
  fallback?: string;
  /** What the model does with it — tooltip. */
  note: string;
};

export type OutputPort = {
  /** Handle id is `out:<id>`. */
  id: string;
  label: string;
  type: ResultPortType;
  note: string;
};

export type ModelPorts = { inputs: InputPort[]; outputs: OutputPort[] };

const TRIANGLE_IN: InputPort = {
  id: "triangle",
  label: "claims triangle",
  accepts: ["triangle"],
  required: true,
  note: "Develops the triangle's paid claims to ultimate.",
};

const MODEL_POINTS_IN: InputPort = {
  id: "model-points",
  label: "model points",
  accepts: ["model-points"],
  required: true,
  note: "Projects the model-point file policy by policy.",
};

const PROJECTION_OUT: OutputPort = {
  id: "projection",
  label: "projected mortality",
  type: "projection",
  note: "The fitted model's projection — life contingencies prices a cohort on it.",
};

const WMTR_PARAMS_IN: InputPort = {
  id: "params",
  label: "parameters",
  accepts: ["wmtr-params"],
  required: false,
  fallback: "built-in defaults",
  note: "Reads α_M / α_T / α_R, weights, shock and horizon from the first row.",
};

const NUMERIC_IN: InputPort = {
  id: "numeric",
  label: "numeric columns",
  accepts: ["numeric"],
  required: true,
  note: "Summarises every numeric column.",
};

export const MODEL_PORTS: Record<string, ModelPorts> = {
  // reserving — four methods on one triangle, compared side by side in Hard.
  "chain-ladder": { inputs: [TRIANGLE_IN], outputs: [] },
  mack: { inputs: [TRIANGLE_IN], outputs: [] },
  "bornhuetter-ferguson": { inputs: [TRIANGLE_IN], outputs: [] },
  "bootstrap-ibnr": { inputs: [TRIANGLE_IN], outputs: [] },
  // mortality — fit, project, then price.
  "lee-carter": {
    inputs: [
      {
        id: "mortality",
        label: "mortality table",
        accepts: ["mortality"],
        required: true,
        note: "Fits log q(x,t) = α + β·κ(t) to the age × year table.",
      },
    ],
    outputs: [PROJECTION_OUT],
  },
  cbd: {
    inputs: [
      {
        id: "mortality",
        label: "mortality table",
        accepts: ["mortality"],
        required: true,
        note: "Fits logit q(x,t) = κ₁(t) + κ₂(t)(x − x̄) over the older ages.",
      },
    ],
    outputs: [PROJECTION_OUT],
  },
  lifecontingencies: {
    inputs: [
      {
        id: "mortality",
        label: "mortality",
        // One pin, two sources: the dataset's own life table, or a
        // projection wired in from Lee–Carter / CBD (which replaces the
        // table — a pin takes one wire).
        accepts: ["mortality", "projection"],
        required: true,
        note: "Prices the annuity, assurance and endowment on this mortality: the dataset's latest life table, or a wired projection's cohort.",
      },
    ],
    outputs: [],
  },
  // pricing — frequency × severity, and a boosted model with its explainer.
  "glm-frequency": {
    inputs: [
      {
        id: "counts",
        label: "claim counts",
        accepts: ["counts"],
        required: true,
        note: "The Poisson response.",
      },
      {
        id: "factors",
        label: "rating factors",
        accepts: ["factors"],
        required: true,
        note: "The categorical covariates the frequency is rated on.",
      },
    ],
    outputs: [
      {
        id: "frequency",
        label: "claim frequency",
        type: "frequency",
        note: "Expected claims per policy — severity multiplies it into the pure premium.",
      },
    ],
  },
  "glm-severity": {
    inputs: [
      {
        id: "amounts",
        label: "claim amounts",
        accepts: ["amounts"],
        required: true,
        note: "The Gamma response (positive amounts only).",
      },
      {
        id: "factors",
        label: "rating factors",
        accepts: ["factors"],
        required: true,
        note: "The categorical covariates the severity is rated on.",
      },
      {
        id: "frequency",
        label: "frequency",
        accepts: ["frequency"],
        required: false,
        fallback: "severity only",
        note: "Wired frequency × this severity = the pure premium.",
      },
    ],
    outputs: [],
  },
  gbm: {
    inputs: [
      {
        id: "target",
        label: "target & features",
        accepts: ["target"],
        required: true,
        note: "Boosts trees predicting the target from the features, scored on a holdout.",
      },
    ],
    outputs: [
      {
        id: "model",
        label: "fitted GBM",
        type: "gbm-model",
        note: "The fitted trees — SHAP explains exactly this model.",
      },
    ],
  },
  shap: {
    inputs: [
      {
        id: "model",
        label: "model to explain",
        accepts: ["gbm-model"],
        required: true,
        note: "Exact TreeSHAP of the wired GBM's own trees, on its holdout rows.",
      },
    ],
    outputs: [],
  },
  // climate
  climada: {
    inputs: [
      {
        id: "exposure",
        label: "exposure",
        accepts: ["exposure"],
        required: true,
        note: "The insured values a hazard footprint is laid over.",
      },
    ],
    outputs: [],
  },
  "parametric-design": {
    inputs: [
      {
        id: "losses",
        label: "losses",
        accepts: ["amounts"],
        required: true,
        note: "Sets the trigger at the 90th percentile of the loss column.",
      },
    ],
    outputs: [],
  },
  // capital
  esg: {
    inputs: [],
    outputs: [
      {
        id: "scenarios",
        label: "rate scenarios",
        type: "scenarios",
        note: "The adverse rate path — the SCR sizes an interest-rate stress from it.",
      },
    ],
  },
  "scr-standard": {
    inputs: [
      {
        id: "scenarios",
        label: "rate scenarios",
        accepts: ["scenarios"],
        required: false,
        fallback: "no rate stress",
        note: "Adds an interest-rate stress sized from the wired scenario path.",
      },
    ],
    outputs: [],
  },
  // pensions — illustrative (see the catalog's `illustrative` note).
  "db-valuation": { inputs: [], outputs: [] },
  // life · lifelib — each projects the same model-point file.
  "basicterm-projection": { inputs: [MODEL_POINTS_IN], outputs: [] },
  "cashvalue-savings": { inputs: [MODEL_POINTS_IN], outputs: [] },
  "ifrs17-csm": { inputs: [MODEL_POINTS_IN], outputs: [] },
  "solvency2-life": { inputs: [MODEL_POINTS_IN], outputs: [] },
  "nested-stochastic": { inputs: [MODEL_POINTS_IN], outputs: [] },
  "cluster-modelpoints": {
    inputs: [{ ...MODEL_POINTS_IN, note: "Compresses the model points into representatives." }],
    outputs: [],
  },
  "smithwilson-curve": { inputs: [], outputs: [] },
  "economic-curves": { inputs: [], outputs: [] },
  // forecast
  "wmtr-projection": { inputs: [WMTR_PARAMS_IN], outputs: [] },
  "wmtr-sensitivity": { inputs: [WMTR_PARAMS_IN], outputs: [] },
  // workspace
  "workspace-bottleneck": {
    inputs: [{ ...NUMERIC_IN, note: "Compresses the numeric drivers into a few nameable codes." }],
    outputs: [],
  },
  // general
  descriptive: { inputs: [NUMERIC_IN], outputs: [] },
};

const NO_PORTS: ModelPorts = { inputs: [], outputs: [] };

export function portsOf(modelId: string): ModelPorts {
  return MODEL_PORTS[modelId] ?? NO_PORTS;
}

/** Input ports that take a model result (as opposed to dataset-only pins). */
function resultInputs(modelId: string): InputPort[] {
  return portsOf(modelId).inputs.filter((p) => p.accepts.some((t) => !isDataType(t)));
}

// ── React Flow node / handle ids ────────────────────────────────────────────

export const HUB_NODE_ID = "hub";
export const modelNodeId = (modelId: string) => `model-${modelId}`;
export const inHandleId = (portId: string) => `in:${portId}`;
export const outHandleId = (portId: string) => `out:${portId}`;
export const dataHandleId = (type: DataPortType) => `data:${type}`;

export function modelIdOfNode(nodeId: string): string | null {
  return nodeId.startsWith("model-") ? nodeId.slice("model-".length) : null;
}

export type ParsedHandle =
  | { kind: "in"; port: string }
  | { kind: "out"; port: string }
  | { kind: "data"; type: DataPortType };

export function parseHandleId(handle: string | null | undefined): ParsedHandle | null {
  if (!handle) return null;
  const i = handle.indexOf(":");
  if (i < 0) return null;
  const kind = handle.slice(0, i);
  const rest = handle.slice(i + 1);
  if (kind === "in" || kind === "out") return { kind, port: rest };
  if (kind === "data" && rest in PORT_TYPES && isDataType(rest as PortType)) {
    return { kind: "data", type: rest as DataPortType };
  }
  return null;
}

// ── wires ───────────────────────────────────────────────────────────────────

/** The (output, input) pair a model→model wire joins, or null when the two
 *  models have no compatible pins — such a wire carries nothing. */
export function resolveWire(
  sourceId: string,
  targetId: string,
): { output: OutputPort; input: InputPort } | null {
  if (sourceId === targetId) return null;
  const inputs = portsOf(targetId).inputs;
  for (const output of portsOf(sourceId).outputs) {
    const input = inputs.find((p) => p.accepts.includes(output.type));
    if (input) return { output, input };
  }
  return null;
}

/** Would adding source → target close a loop? */
export function createsCycle(wires: ModelWire[], sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  // Is `sourceId` reachable downstream of `targetId`?
  const next = new Map<string, string[]>();
  for (const w of wires) next.set(w.source, [...(next.get(w.source) ?? []), w.target]);
  const stack = [targetId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === sourceId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

/**
 * Keep only wires that carry something: typed (a compatible output → input
 * pair exists), deduplicated, acyclic, one wire per input pin (the first
 * wins — a pin takes one wire, like a Blueprint data input) and, when
 * `presentIds` is given, between models still on the canvas. Used to migrate
 * sessions saved under the old decorative-arrow canvas.
 */
export function sanitizeWires(wires: ModelWire[], presentIds?: Iterable<string>): ModelWire[] {
  const present = presentIds ? new Set(presentIds) : null;
  const out: ModelWire[] = [];
  const taken = new Set<string>(); // `${target}|${inputPortId}`
  const seen = new Set<string>();
  for (const w of wires) {
    if (!w || typeof w.source !== "string" || typeof w.target !== "string") continue;
    if (present && (!present.has(w.source) || !present.has(w.target))) continue;
    const pair = resolveWire(w.source, w.target);
    if (!pair) continue;
    const key = `${w.source}→${w.target}`;
    if (seen.has(key)) continue;
    const slot = `${w.target}|${pair.input.id}`;
    if (taken.has(slot)) continue;
    if (createsCycle(out, w.source, w.target)) continue;
    seen.add(key);
    taken.add(slot);
    out.push({ source: w.source, target: w.target });
  }
  return out;
}

/** The wire currently plugged into `targetId`'s input `portId`, if any. */
export function wireInto(
  wires: ModelWire[],
  targetId: string,
  portId: string,
): ModelWire | undefined {
  return wires.find(
    (w) => w.target === targetId && resolveWire(w.source, w.target)?.input.id === portId,
  );
}

/**
 * Plug source → target. A pin takes one wire, so whatever was plugged into
 * the same input is replaced (dragging CBD onto life contingencies'
 * mortality pin unplugs Lee–Carter). Invalid or cyclic wires leave `wires`
 * unchanged.
 */
export function connectWire(wires: ModelWire[], sourceId: string, targetId: string): ModelWire[] {
  const pair = resolveWire(sourceId, targetId);
  if (!pair) return wires;
  const others = wires.filter(
    (w) => !(w.target === targetId && resolveWire(w.source, w.target)?.input.id === pair.input.id),
  );
  if (createsCycle(others, sourceId, targetId)) return wires;
  return [...others, { source: sourceId, target: targetId }];
}

export function disconnectWire(
  wires: ModelWire[],
  sourceId: string,
  targetId: string,
): ModelWire[] {
  const next = wires.filter((w) => !(w.source === sourceId && w.target === targetId));
  return next.length === wires.length ? wires : next;
}

/**
 * Default wiring for models that just joined the canvas: every free input
 * that takes a model result is plugged into the first ENABLED model (in
 * catalog order — Lee–Carter before CBD) that produces it, when either end
 * is new. Existing wires — including ones the actuary drew or deliberately
 * left unplugged on models already present — are never touched.
 * `requiredOnly` fills required inputs alone: a model with one empty can't
 * run, while an optional input left free falls back to the data or a
 * default, which may be what the actuary chose.
 */
export function autoWire(
  models: ReadonlyArray<{ id: string; enabled: boolean }>,
  wires: ModelWire[],
  added: ReadonlySet<string>,
  { requiredOnly = false }: { requiredOnly?: boolean } = {},
): ModelWire[] {
  if (added.size === 0) return wires;
  const present = new Set(models.map((m) => m.id));
  const enabled = new Set(models.filter((m) => m.enabled).map((m) => m.id));
  const producers = MODEL_CATALOG.filter((m) => enabled.has(m.id)).map((m) => m.id);
  let next = wires;
  for (const m of models) {
    for (const input of resultInputs(m.id)) {
      if (requiredOnly && !input.required) continue;
      if (wireInto(next, m.id, input.id)) continue;
      const source = producers.find(
        (p) =>
          p !== m.id &&
          present.has(p) &&
          (added.has(m.id) || added.has(p)) &&
          resolveWire(p, m.id)?.input.id === input.id,
      );
      if (source && !createsCycle(next, source, m.id)) {
        next = [...next, { source, target: m.id }];
      }
    }
  }
  return next;
}

// ── what feeds each input ───────────────────────────────────────────────────

export type InputFeed =
  /** A model wire. `live` is false when the source is switched off — the
   *  pin then falls back (see `fallback`). */
  | { kind: "wire"; from: string; live: boolean; fallback: InputFeed | null }
  /** The dataset hub's pin of this type. */
  | { kind: "data"; type: DataPortType }
  /** Optional pin, nothing plugged in: the model's own default. */
  | { kind: "default"; text: string }
  /** Required pin with no source anywhere — the model cannot run. */
  | { kind: "missing" };

function unwiredFeed(port: InputPort, dataTypes: ReadonlySet<DataPortType>): InputFeed {
  const data = port.accepts.find((t): t is DataPortType => isDataType(t) && dataTypes.has(t));
  if (data) return { kind: "data", type: data };
  if (!port.required) return { kind: "default", text: port.fallback ?? "default" };
  return { kind: "missing" };
}

/** Where each of `modelId`'s inputs gets its data on the current canvas. */
export function inputFeeds(
  modelId: string,
  models: ReadonlyArray<{ id: string; enabled: boolean }>,
  wires: ModelWire[],
  dataTypes: ReadonlySet<DataPortType>,
): Array<{ port: InputPort; feed: InputFeed }> {
  const enabled = new Set(models.filter((m) => m.enabled).map((m) => m.id));
  const present = new Set(models.map((m) => m.id));
  return portsOf(modelId).inputs.map((port) => {
    const w = wireInto(wires, modelId, port.id);
    if (w && present.has(w.source)) {
      const live = enabled.has(w.source);
      return {
        port,
        feed: {
          kind: "wire",
          from: w.source,
          live,
          fallback: live ? null : unwiredFeed(port, dataTypes),
        },
      };
    }
    return { port, feed: unwiredFeed(port, dataTypes) };
  });
}

/** Required inputs nothing can feed right now (no data role, no live wire). */
export function unmetInputs(
  modelId: string,
  models: ReadonlyArray<{ id: string; enabled: boolean }>,
  wires: ModelWire[],
  dataTypes: ReadonlySet<DataPortType>,
): InputPort[] {
  return inputFeeds(modelId, models, wires, dataTypes)
    .filter(
      ({ feed }) =>
        feed.kind === "missing" || (feed.kind === "wire" && feed.fallback?.kind === "missing"),
    )
    .map(({ port }) => port);
}

// ── catalog queries (menus, pickers) ───────────────────────────────────────

/** Catalog models with an input that takes `type`. */
export function consumersOf(type: PortType): Array<{ modelId: string; port: InputPort }> {
  const out: Array<{ modelId: string; port: InputPort }> = [];
  for (const m of MODEL_CATALOG) {
    const port = portsOf(m.id).inputs.find((p) => p.accepts.includes(type));
    if (port) out.push({ modelId: m.id, port });
  }
  return out;
}

/** Catalog models with an output of `type`. */
export function producersOf(type: PortType): Array<{ modelId: string; port: OutputPort }> {
  const out: Array<{ modelId: string; port: OutputPort }> = [];
  for (const m of MODEL_CATALOG) {
    const port = portsOf(m.id).outputs.find((p) => p.type === type);
    if (port) out.push({ modelId: m.id, port });
  }
  return out;
}

/** The first catalog model that can satisfy a required result input of
 *  `modelId` (SHAP → GBM). Used to pull a dependency in with the model. */
export function requiredProducers(modelId: string): string[] {
  const out: string[] = [];
  for (const port of portsOf(modelId).inputs) {
    if (!port.required || port.accepts.some(isDataType)) continue;
    const producer = port.accepts.flatMap((t) => producersOf(t))[0];
    if (producer) out.push(producer.modelId);
  }
  return out;
}

/** "a mortality table or projected mortality" — for refusal reasons. */
export function describeAccepts(types: PortType[]): string {
  const phrases = types.map((t) => PORT_TYPES[t].phrase);
  if (phrases.length <= 1) return phrases[0] ?? "nothing";
  return `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
}

// ── connection checks (drag-to-connect) ─────────────────────────────────────

export type ConnectionCheck =
  | { ok: true; action: { kind: "wire"; source: string; target: string } }
  /** Plug the dataset back into a pin (unplugs the model wired there). */
  | { ok: true; action: { kind: "data"; target: string; portId: string } }
  /** Already connected exactly so — nothing to do. */
  | { ok: true; action: { kind: "none" } }
  | { ok: false; reason: string };

/**
 * Can this drag become a wire? Mirrors Blueprint rules: an output (right) to
 * an input (left), types must agree, no loops. Reasons are phrased for the
 * tooltip on the dragged wire.
 */
export function checkConnection(
  conn: {
    source: string | null;
    sourceHandle: string | null;
    target: string | null;
    targetHandle: string | null;
  },
  wires: ModelWire[],
): ConnectionCheck {
  const src = parseHandleId(conn.sourceHandle);
  const dst = parseHandleId(conn.targetHandle);
  if (!conn.source || !conn.target || !src || !dst) {
    return { ok: false, reason: "connect an output (right) to an input (left)" };
  }
  if (dst.kind !== "in" || (src.kind !== "out" && src.kind !== "data")) {
    return { ok: false, reason: "connect an output (right) to an input (left)" };
  }
  const targetId = modelIdOfNode(conn.target);
  if (!targetId) return { ok: false, reason: "the dataset only has outputs" };
  const input = portsOf(targetId).inputs.find((p) => p.id === dst.port);
  if (!input) return { ok: false, reason: "unknown input" };

  if (src.kind === "data") {
    if (conn.source !== HUB_NODE_ID) return { ok: false, reason: "unknown output" };
    if (!input.accepts.includes(src.type)) {
      return {
        ok: false,
        reason: `${PORT_TYPES[src.type].label} can't feed ${input.label} — it takes ${describeAccepts(input.accepts)}`,
      };
    }
    return wireInto(wires, targetId, input.id)
      ? { ok: true, action: { kind: "data", target: targetId, portId: input.id } }
      : { ok: true, action: { kind: "none" } };
  }

  const sourceId = modelIdOfNode(conn.source);
  if (!sourceId) return { ok: false, reason: "unknown output" };
  if (sourceId === targetId) return { ok: false, reason: "a model can't feed itself" };
  const output = portsOf(sourceId).outputs.find((p) => p.id === src.port);
  if (!output) return { ok: false, reason: "unknown output" };
  if (!input.accepts.includes(output.type)) {
    return {
      ok: false,
      reason: `${output.label} can't feed ${input.label} — it takes ${describeAccepts(input.accepts)}`,
    };
  }
  if (wires.some((w) => w.source === sourceId && w.target === targetId)) {
    return { ok: true, action: { kind: "none" } };
  }
  const others = wires.filter(
    (w) => !(w.target === targetId && resolveWire(w.source, w.target)?.input.id === input.id),
  );
  if (createsCycle(others, sourceId, targetId)) {
    return { ok: false, reason: "that wire would close a loop" };
  }
  return { ok: true, action: { kind: "wire", source: sourceId, target: targetId } };
}

// ── layout ─────────────────────────────────────────────────────────────────

/** Column per model for a left-to-right layout: 0 = fed by the dataset
 *  alone; otherwise one past its deepest wired source. Cycles (never
 *  produced by connectWire) fall back to 0. */
export function pipelineDepths(ids: string[], wires: ModelWire[]): Map<string, number> {
  const present = new Set(ids);
  const sourcesOf = new Map<string, string[]>();
  for (const w of wires) {
    if (!present.has(w.source) || !present.has(w.target)) continue;
    sourcesOf.set(w.target, [...(sourcesOf.get(w.target) ?? []), w.source]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const s of sourcesOf.get(id) ?? []) d = Math.max(d, visit(s) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) visit(id);
  return depth;
}
