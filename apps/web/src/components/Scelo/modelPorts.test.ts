// The Tools canvas's typed pins must be honest: a pin exists only where
// something flows, every model→model pin is consumed by its runner, and the
// dataset hub offers exactly what the runners will find.

import { describe, expect, test } from "bun:test";
import { type Dataset, type Row, SAMPLE_BY_KEY, buildWorkspaceDemo } from "@scelo/core";
import { dataTypesOf, detectDataRoles } from "./dataRoles";
import { MODEL_CATALOG } from "./modelCatalog";
import {
  type DataPortType,
  MODEL_PORTS,
  PORT_TYPES,
  type PortType,
  autoWire,
  checkConnection,
  connectWire,
  consumersOf,
  dataHandleId,
  inHandleId,
  inputFeeds,
  isDataType,
  outHandleId,
  pipelineDepths,
  portsOf,
  producersOf,
  requiredProducers,
  resolveWire,
  sanitizeWires,
  unmetInputs,
} from "./modelPorts";
import { type RunResult, modelApplicability, runModel } from "./modelRunner";

// ── fixtures ───────────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Policy-level pricing data: counts, amounts and two rating factors. */
function pricingData(n = 300): Dataset {
  const r = rng(7);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const region = ["north", "south", "east", "west"][Math.floor(r() * 4)];
    const vehicle = ["car", "van", "bike"][Math.floor(r() * 3)];
    const claims = Math.floor(r() * 3);
    rows.push({
      region,
      vehicle,
      driver_age: 18 + Math.floor(r() * 60),
      claims,
      claim_amount: claims > 0 ? 500 + Math.floor(r() * 20_000) : 0,
    });
  }
  return {
    name: "pricing.csv",
    columns: ["region", "vehicle", "driver_age", "claims", "claim_amount"],
    rows,
  };
}

/** Age × year mortality experience, falling 1.5% a year. */
function mortalityData(): Dataset {
  const rows: Row[] = [];
  for (let year = 1995; year <= 2019; year++) {
    for (let age = 50; age <= 100; age++) {
      rows.push({
        year,
        age,
        qx: Math.min(0.9, 0.00005 * Math.exp(0.1 * age) * 0.985 ** (year - 1995)),
      });
    }
  }
  return { name: "hmd.csv", columns: ["year", "age", "qx"], rows };
}

const claims = () => SAMPLE_BY_KEY.get("claims")?.build() as Dataset;

const on = (...ids: string[]) => ids.map((id) => ({ id, enabled: true }));

// ── the port table ─────────────────────────────────────────────────────────

describe("port table", () => {
  test("every catalog model has ports, and nothing else does", () => {
    expect(Object.keys(MODEL_PORTS).sort()).toEqual(MODEL_CATALOG.map((m) => m.id).sort());
  });

  test("no dead pins: every output is consumed, every result input has a producer", () => {
    for (const [id, ports] of Object.entries(MODEL_PORTS)) {
      for (const out of ports.outputs) {
        expect({ id, out: out.id, consumers: consumersOf(out.type).length > 0 }).toEqual({
          id,
          out: out.id,
          consumers: true,
        });
      }
      for (const input of ports.inputs) {
        for (const t of input.accepts) {
          if (isDataType(t)) continue;
          expect({ id, input: input.id, t, producers: producersOf(t).length > 0 }).toEqual({
            id,
            input: input.id,
            t,
            producers: true,
          });
        }
      }
    }
  });

  test("optional pins say what happens unplugged; required pins don't", () => {
    for (const ports of Object.values(MODEL_PORTS)) {
      for (const p of ports.inputs) {
        if (p.required) expect(p.fallback).toBeUndefined();
        else expect(p.fallback?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("every port type is used somewhere", () => {
    const used = new Set<PortType>();
    for (const ports of Object.values(MODEL_PORTS)) {
      for (const p of ports.inputs) for (const t of p.accepts) used.add(t);
      for (const p of ports.outputs) used.add(p.type);
    }
    expect([...used].sort()).toEqual((Object.keys(PORT_TYPES) as PortType[]).sort());
  });
});

describe("resolveWire · only wires that carry something", () => {
  test("the real flows", () => {
    expect(resolveWire("lee-carter", "lifecontingencies")?.input.id).toBe("mortality");
    expect(resolveWire("cbd", "lifecontingencies")?.input.id).toBe("mortality");
    expect(resolveWire("glm-frequency", "glm-severity")?.input.id).toBe("frequency");
    expect(resolveWire("gbm", "shap")?.input.id).toBe("model");
    expect(resolveWire("esg", "scr-standard")?.input.id).toBe("scenarios");
  });

  test("the old canvas's decorative and degenerate arrows are not wires", () => {
    for (const [a, b] of [
      ["chain-ladder", "mack"], // Mack refits chain ladder itself
      ["chain-ladder", "bornhuetter-ferguson"], // a CL prior collapses BF onto CL
      ["mack", "bootstrap-ibnr"], // fed nothing
      ["lee-carter", "cbd"], // "compare" — not a flow
      ["glm-severity", "gbm"], // "vs nonlinear" — not a flow
      ["climada", "parametric-design"], // fed nothing
      ["shap", "gbm"], // backwards
      ["gbm", "gbm"],
    ]) {
      expect(resolveWire(a, b)).toBeNull();
    }
  });

  test("every resolvable pair is consumed by the target's runner", () => {
    const pricing = pricingData();
    const table = mortalityData();
    const datasetFor = (id: string) =>
      ["lee-carter", "cbd", "lifecontingencies"].includes(id) ? table : pricing;
    for (const source of MODEL_CATALOG) {
      for (const target of MODEL_CATALOG) {
        if (!resolveWire(source.id, target.id)) continue;
        const ds = datasetFor(target.id);
        const up = runModel(source.id, ds);
        expect({ pair: `${source.id}→${target.id}`, upstream: up.status }).toEqual({
          pair: `${source.id}→${target.id}`,
          upstream: "done",
        });
        const res = runModel(target.id, ds, new Map<string, RunResult>([[source.id, up]]));
        expect({
          pair: `${source.id}→${target.id}`,
          consumed: res.wiredFrom?.some((w) => w.id === source.id) ?? false,
        }).toEqual({ pair: `${source.id}→${target.id}`, consumed: true });
      }
    }
  });
});

describe("sanitizeWires · migrating the old canvas", () => {
  test("the old default arrows reduce to the ones that carry something", () => {
    const oldDefaults = [
      { source: "chain-ladder", target: "mack" },
      { source: "chain-ladder", target: "bornhuetter-ferguson" },
      { source: "mack", target: "bootstrap-ibnr" },
      { source: "lee-carter", target: "cbd" },
      { source: "lee-carter", target: "lifecontingencies" },
      { source: "cbd", target: "lifecontingencies" },
      { source: "glm-frequency", target: "glm-severity" },
      { source: "glm-severity", target: "gbm" },
      { source: "gbm", target: "shap" },
      { source: "climada", target: "parametric-design" },
      { source: "esg", target: "scr-standard" },
    ];
    expect(sanitizeWires(oldDefaults)).toEqual([
      // One wire per pin: Lee–Carter came first, so CBD's is dropped.
      { source: "lee-carter", target: "lifecontingencies" },
      { source: "glm-frequency", target: "glm-severity" },
      { source: "gbm", target: "shap" },
      { source: "esg", target: "scr-standard" },
    ]);
  });

  test("drops wires to models no longer on the canvas, duplicates and junk", () => {
    const wires = [
      { source: "gbm", target: "shap" },
      { source: "gbm", target: "shap" },
      { source: "esg", target: "scr-standard" },
      { source: 3, target: null } as unknown as { source: string; target: string },
    ];
    expect(sanitizeWires(wires, ["gbm", "shap"])).toEqual([{ source: "gbm", target: "shap" }]);
  });
});

describe("connectWire · a pin takes one wire", () => {
  test("plugging CBD into the annuity unplugs Lee–Carter", () => {
    const wires = [{ source: "lee-carter", target: "lifecontingencies" }];
    expect(connectWire(wires, "cbd", "lifecontingencies")).toEqual([
      { source: "cbd", target: "lifecontingencies" },
    ]);
  });

  test("an incompatible wire is refused (unchanged)", () => {
    const wires = [{ source: "gbm", target: "shap" }];
    expect(connectWire(wires, "chain-ladder", "shap")).toBe(wires);
  });
});

describe("autoWire · new models arrive plugged in", () => {
  test("per family, only the real flows", () => {
    const all = (ids: string[]) => autoWire(on(...ids), [], new Set(ids));
    expect(all(["chain-ladder", "mack", "bornhuetter-ferguson", "bootstrap-ibnr"])).toEqual([]);
    expect(all(["lee-carter", "cbd", "lifecontingencies"])).toEqual([
      { source: "lee-carter", target: "lifecontingencies" },
    ]);
    expect(all(["glm-frequency", "glm-severity", "gbm", "shap"])).toEqual([
      { source: "glm-frequency", target: "glm-severity" },
      { source: "gbm", target: "shap" },
    ]);
    expect(all(["scr-standard", "esg"])).toEqual([{ source: "esg", target: "scr-standard" }]);
  });

  test("a switched-off producer is not plugged in", () => {
    const models = [
      { id: "lee-carter", enabled: false },
      { id: "cbd", enabled: true },
      { id: "lifecontingencies", enabled: true },
    ];
    expect(autoWire(models, [], new Set(models.map((m) => m.id)))).toEqual([
      { source: "cbd", target: "lifecontingencies" },
    ]);
  });

  test("a pin the actuary left unplugged stays unplugged when something unrelated joins", () => {
    // GBM + SHAP present, the GBM → SHAP wire removed by hand; descriptive joins.
    expect(autoWire(on("gbm", "shap", "descriptive"), [], new Set(["descriptive"]))).toEqual([]);
    // …but a NEW producer does fill a free pin.
    expect(autoWire(on("shap", "gbm"), [], new Set(["gbm"]))).toEqual([
      { source: "gbm", target: "shap" },
    ]);
  });

  test("an occupied pin is left alone", () => {
    const wires = [{ source: "cbd", target: "lifecontingencies" }];
    expect(
      autoWire(on("cbd", "lifecontingencies", "lee-carter"), wires, new Set(["lee-carter"])),
    ).toBe(wires);
  });

  test("requiredOnly fills just the inputs a model can't run without", () => {
    // Severity's frequency pin is optional (it prices severity alone without
    // it); SHAP's model pin is required.
    const ids = ["glm-frequency", "glm-severity", "gbm", "shap"];
    expect(autoWire(on(...ids), [], new Set(ids), { requiredOnly: true })).toEqual([
      { source: "gbm", target: "shap" },
    ]);
  });
});

describe("checkConnection · drag rules", () => {
  const conn = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
    source,
    sourceHandle,
    target,
    targetHandle,
  });

  test("compatible output → input makes a wire", () => {
    expect(
      checkConnection(
        conn("model-gbm", outHandleId("model"), "model-shap", inHandleId("model")),
        [],
      ),
    ).toEqual({ ok: true, action: { kind: "wire", source: "gbm", target: "shap" } });
  });

  test("a type mismatch is refused with the reason", () => {
    const r = checkConnection(
      conn(
        "model-glm-frequency",
        outHandleId("frequency"),
        "model-lifecontingencies",
        inHandleId("mortality"),
      ),
      [],
    );
    expect(r).toEqual({
      ok: false,
      reason:
        "claim frequency can't feed mortality — it takes a mortality table or projected mortality",
    });
  });

  test("the dataset re-plugs a pin a model occupies; elsewhere it is already plugged", () => {
    const wires = [{ source: "lee-carter", target: "lifecontingencies" }];
    expect(
      checkConnection(
        conn("hub", dataHandleId("mortality"), "model-lifecontingencies", inHandleId("mortality")),
        wires,
      ),
    ).toEqual({
      ok: true,
      action: { kind: "data", target: "lifecontingencies", portId: "mortality" },
    });
    expect(
      checkConnection(
        conn("hub", dataHandleId("mortality"), "model-lee-carter", inHandleId("mortality")),
        wires,
      ),
    ).toEqual({ ok: true, action: { kind: "none" } });
    const bad = checkConnection(
      conn("hub", dataHandleId("triangle"), "model-lee-carter", inHandleId("mortality")),
      wires,
    );
    expect(bad.ok).toBe(false);
  });

  test("inputs can't feed inputs; a model can't feed itself", () => {
    expect(
      checkConnection(
        conn("model-gbm", inHandleId("target"), "model-shap", inHandleId("model")),
        [],
      ).ok,
    ).toBe(false);
    expect(
      checkConnection(
        conn("model-gbm", outHandleId("model"), "model-gbm", inHandleId("target")),
        [],
      ).ok,
    ).toBe(false);
  });
});

describe("inputFeeds · what each pin is plugged into", () => {
  const mortality = new Set(["mortality" as const]);

  test("the annuity: table from the data, or the wired projection", () => {
    expect(inputFeeds("lifecontingencies", on("lifecontingencies"), [], mortality)[0].feed).toEqual(
      {
        kind: "data",
        type: "mortality",
      },
    );
    const wires = [{ source: "lee-carter", target: "lifecontingencies" }];
    expect(
      inputFeeds("lifecontingencies", on("lee-carter", "lifecontingencies"), wires, mortality)[0]
        .feed,
    ).toEqual({ kind: "wire", from: "lee-carter", live: true, fallback: null });
    // Lee–Carter switched off: the pin falls back to the table.
    const offLc = [
      { id: "lee-carter", enabled: false },
      { id: "lifecontingencies", enabled: true },
    ];
    expect(inputFeeds("lifecontingencies", offLc, wires, mortality)[0].feed).toEqual({
      kind: "wire",
      from: "lee-carter",
      live: false,
      fallback: { kind: "data", type: "mortality" },
    });
  });

  test("unmet: SHAP with no GBM, a triangle model on data without one", () => {
    expect(unmetInputs("shap", on("shap"), [], new Set()).map((p) => p.id)).toEqual(["model"]);
    expect(
      unmetInputs("shap", on("shap", "gbm"), [{ source: "gbm", target: "shap" }], new Set()),
    ).toEqual([]);
    expect(unmetInputs("chain-ladder", on("chain-ladder"), [], new Set(["numeric"])).length).toBe(
      1,
    );
    // An optional pin is never unmet — it has a default.
    expect(unmetInputs("scr-standard", on("scr-standard"), [], new Set())).toEqual([]);
  });

  test("requiredProducers pulls GBM in with SHAP, nothing else needs a model", () => {
    for (const m of MODEL_CATALOG) {
      expect({ id: m.id, need: requiredProducers(m.id) }).toEqual({
        id: m.id,
        need: m.id === "shap" ? ["gbm"] : [],
      });
    }
  });
});

describe("pipelineDepths · left-to-right columns", () => {
  test("producers before consumers", () => {
    const d = pipelineDepths(
      ["lifecontingencies", "lee-carter", "cbd", "descriptive"],
      [{ source: "lee-carter", target: "lifecontingencies" }],
    );
    expect(Object.fromEntries(d)).toEqual({
      lifecontingencies: 1,
      "lee-carter": 0,
      cbd: 0,
      descriptive: 0,
    });
  });
});

// ── the dataset hub's pins ─────────────────────────────────────────────────

describe("detectDataRoles · what the dataset offers", () => {
  const types = (ds: Dataset) => detectDataRoles(ds).map((r) => r.type);

  test("claims sample: a triangle first, then what else it can feed", () => {
    const roles = detectDataRoles(claims());
    expect(roles[0]).toMatchObject({ type: "triangle", evidence: "7 origins × 7 dev periods" });
    expect(types(claims())).toContain("amounts");
    expect(types(claims())).toContain("factors");
    expect(types(claims())).not.toContain("mortality");
    // `paid` standing in for exposure is said out loud.
    expect(roles.find((r) => r.type === "exposure")?.caveat).toContain("stands in for exposure");
  });

  test("mortality experience, model points, WMTR parameters, pricing", () => {
    expect(detectDataRoles(mortalityData())[0]).toMatchObject({
      type: "mortality",
      evidence: "25 years × 51 ages",
    });
    expect(types(SAMPLE_BY_KEY.get("lifelib-mp")?.build() as Dataset)).toContain("model-points");
    expect(types(SAMPLE_BY_KEY.get("wmtr-scenarios")?.build() as Dataset)).toContain("wmtr-params");
    const p = types(pricingData());
    const expected: DataPortType[] = ["counts", "amounts", "factors", "target", "numeric"];
    for (const t of expected) expect(p).toContain(t);
  });

  test("the workspace demo has no mortality table, whatever its column names suggest", () => {
    const t = types(buildWorkspaceDemo());
    expect(t).not.toContain("mortality");
    expect(t).toContain("target");
    expect(t).toContain("numeric");
  });

  test("the hub never withholds a pin a runnable model needs — and vice versa", () => {
    const datasets = [
      claims(),
      pricingData(),
      mortalityData(),
      buildWorkspaceDemo(),
      SAMPLE_BY_KEY.get("lifelib-mp")?.build() as Dataset,
      SAMPLE_BY_KEY.get("climate")?.build() as Dataset,
      SAMPLE_BY_KEY.get("wmtr-scenarios")?.build() as Dataset,
    ];
    for (const ds of datasets) {
      const offered = dataTypesOf(detectDataRoles(ds));
      for (const m of MODEL_CATALOG) {
        const dataPins = portsOf(m.id).inputs.filter(
          (p) => p.required && p.accepts.every(isDataType),
        );
        if (dataPins.length === 0) continue;
        const pinsMet = dataPins.every((p) => p.accepts.some((t) => offered.has(t as never)));
        const runnable = modelApplicability(m.id, ds).ok;
        // Runnable ⇒ every required data pin is on the hub. (A met pin can
        // still be not applicable: Lee–Carter needs 3+ years of the table.)
        if (runnable)
          expect({ ds: ds.name, model: m.id, pinsMet }).toEqual({
            ds: ds.name,
            model: m.id,
            pinsMet: true,
          });
        if (!pinsMet)
          expect({ ds: ds.name, model: m.id, runnable }).toEqual({
            ds: ds.name,
            model: m.id,
            runnable: false,
          });
      }
    }
  });
});
