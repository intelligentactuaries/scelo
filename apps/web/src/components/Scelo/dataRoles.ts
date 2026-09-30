// What the dataset can feed — the dataset hub's output pins on the Tools
// canvas. Each role is detected with the SAME detector the runners use
// (modelRunner / mortality / lifelib), so a pin on the hub is a promise the
// Hard stage keeps: if the hub offers "claims triangle", chain ladder will
// find one. The evidence line names the columns, so the actuary can see
// what each model will read before anything runs.

import type { Dataset } from "@scelo/core";
import { GBM_MIN_ROWS } from "./gbm";
import { hasModelPoints, parseModelPoints } from "./lifelibBasicTerm";
import type { DataPortType } from "./modelPorts";
import {
  detectCategoricalCovariates,
  detectFrequencyTarget,
  detectModelFeatures,
  detectModelTarget,
  detectMonetaryColumn,
  findExposureColumn,
  triangleShape,
} from "./modelRunner";
import { detectMortalityTable } from "./mortality";
import { numericColumns } from "./workspace";

export type DataRole = {
  type: DataPortType;
  /** The columns the role reads. */
  columns: string[];
  /** Short evidence beside the pin ("7 origins × 7 dev periods"). */
  evidence: string;
  /** When the role rests on a stand-in (a loss column posing as exposure). */
  caveat?: string;
};

const ROLE_CACHE = new WeakMap<Dataset, DataRole[]>();

function listCols(cols: string[], max = 3): string {
  return cols.length <= max
    ? cols.join(", ")
    : `${cols.slice(0, max).join(", ")} +${cols.length - max}`;
}

/** Every role the dataset can play, most specific first. Cached per dataset
 *  object (the detectors scan rows). */
export function detectDataRoles(dataset: Dataset): DataRole[] {
  const hit = ROLE_CACHE.get(dataset);
  if (hit) return hit;
  const roles: DataRole[] = [];

  const tri = triangleShape(dataset);
  if (tri) {
    roles.push({
      type: "triangle",
      columns: tri.columns,
      evidence: `${tri.origins} origins × ${tri.devs} dev periods`,
    });
  }

  const mort = detectMortalityTable(dataset);
  if ("table" in mort) {
    const t = mort.table;
    const span = `ages ${t.ages[0]}–${t.ages[t.ages.length - 1]}`;
    roles.push({
      type: "mortality",
      columns: [t.columns.age, ...(t.columns.year ? [t.columns.year] : []), t.columns.rate],
      evidence: t.columns.year
        ? `${t.years.length} years × ${t.ages.length} ages`
        : `life table, ${span}`,
    });
  }

  if (hasModelPoints(dataset)) {
    const mp = parseModelPoints(dataset);
    const used = Object.values(mp.recognisedColumns).filter((c): c is string => !!c);
    roles.push({
      type: "model-points",
      columns: used,
      evidence: `${mp.points.length.toLocaleString()} policies`,
    });
  }

  const lower = new Map(dataset.columns.map((c) => [c.toLowerCase(), c] as const));
  const alphas = ["alpha_m", "alpha_t", "alpha_r"].map(
    (a) => lower.get(a) ?? lower.get(a.replace("_", "")),
  );
  if (alphas.every(Boolean)) {
    roles.push({
      type: "wmtr-params",
      columns: alphas as string[],
      evidence: `${dataset.rows.length} scenario row${dataset.rows.length === 1 ? "" : "s"}`,
    });
  }

  const factors = detectCategoricalCovariates(dataset);
  const counts = detectFrequencyTarget(dataset);
  if (counts) roles.push({ type: "counts", columns: [counts], evidence: counts });
  const money = detectMonetaryColumn(dataset);
  if (money) roles.push({ type: "amounts", columns: [money], evidence: money });
  if (factors.length > 0) {
    roles.push({ type: "factors", columns: factors, evidence: listCols(factors) });
  }

  const target = dataset.rows.length >= GBM_MIN_ROWS ? detectModelTarget(dataset) : null;
  const features = target ? detectModelFeatures(dataset, target) : [];
  if (target && features.length > 0) {
    roles.push({
      type: "target",
      columns: [target.column, ...features.map((f) => f.name)],
      evidence: `${target.column} ← ${features.length} feature${features.length === 1 ? "" : "s"}`,
      ...(target.claimsOutcome || target.reason === "named target"
        ? {}
        : { caveat: `\`${target.column}\` is the target because it is the ${target.reason}` }),
    });
  }

  const exposure = findExposureColumn(dataset);
  if (exposure) {
    roles.push({
      type: "exposure",
      columns: [exposure],
      evidence: exposure,
      ...(exposure.toLowerCase() === "paid"
        ? { caveat: "`paid` (a loss column) stands in for exposure — no sum insured / TIV column" }
        : {}),
    });
  }

  const numeric = numericColumns(dataset);
  if (numeric.length > 0) {
    roles.push({
      type: "numeric",
      columns: numeric,
      evidence: `${numeric.length} column${numeric.length === 1 ? "" : "s"}`,
    });
  }

  ROLE_CACHE.set(dataset, roles);
  return roles;
}

export function dataTypesOf(roles: DataRole[]): Set<DataPortType> {
  return new Set(roles.map((r) => r.type));
}
