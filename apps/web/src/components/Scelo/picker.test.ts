// Picker routing — locks in the deterministic heuristic for the three
// strong-signal samples (claims triangle, climate reanalysis ensemble,
// lifelib model-point file). These shapes must NOT bounce to "general"
// or get mis-routed to a sibling family. Lifelib MP is the regression
// of record: a user reported reserving models being picked on a life
// MP file, traced to the LLM picker ignoring the new `life` routing.

import { describe, expect, test } from "bun:test";
import { SAMPLE_OPTIONS_LIST, summariseDataset } from "./SoftDataWorkstation";
import { dataSignature, fetchModelPicks, heuristicPick } from "./modelPicker";
import { runModel } from "./modelRunner";

function pickFor(key: "claims" | "climate" | "dirty" | "lifelib-mp" | "wmtr-scenarios") {
  const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === key);
  if (!opt) throw new Error(`sample ${key} not in SAMPLE_OPTIONS`);
  const dataset = opt.build();
  const metas = summariseDataset(dataset);
  const sig = dataSignature(dataset, metas);
  const pick = heuristicPick(sig);
  return { dataset, pick };
}

describe("Tools picker · heuristic routing", () => {
  test("claims sample → reserving family", () => {
    const { pick } = pickFor("claims");
    expect(pick.domain).toBe("reserving");
    expect(pick.selected.map((s) => s.id)).toContain("chain-ladder");
    expect(pick.selected.length).toBeGreaterThanOrEqual(3);
  });

  test("climate sample → climate family", () => {
    const { pick } = pickFor("climate");
    expect(pick.domain).toBe("climate");
    expect(pick.selected.map((s) => s.id)).toContain("climada");
  });

  test("lifelib-mp sample → life family (BasicTerm headline)", () => {
    const { pick } = pickFor("lifelib-mp");
    expect(pick.domain).toBe("life");
    expect(pick.selected.map((s) => s.id)).toContain("basicterm-projection");
    expect(pick.selected.map((s) => s.id)).toContain("ifrs17-csm");
    expect(pick.selected.map((s) => s.id)).toContain("solvency2-life");
  });

  test("wmtr-scenarios sample → forecast family (WMTR projection + sensitivity)", () => {
    const { pick } = pickFor("wmtr-scenarios");
    expect(pick.domain).toBe("forecast");
    expect(pick.selected.map((s) => s.id)).toContain("wmtr-projection");
    expect(pick.selected.map((s) => s.id)).toContain("wmtr-sensitivity");
  });

  test("swarm-simulation rows (sim_* columns) → general / descriptive (NOT reserving)", () => {
    // Mock the shape the swarms /api/simulate endpoint returns: demographic
    // columns + sim_* outcome columns. Should route to general / descriptive
    // — NEVER to reserving (would otherwise mis-route and the runners would
    // error with "Triangle not detected" on Hard Data).
    const simDataset = {
      name: "swarm_simulation_test",
      columns: [
        "id", "age", "sex", "income_band", "education", "region", "employment",
        "comorbidities", "vaccination", "insurance_cov",
        "sim_treatment_uptake", "sim_isolation_days", "sim_spending_shift",
        "sim_infection_probability", "sim_severity_if_infected",
        "sim_mortality_probability", "sim_hospitalised",
        "sim_workdays_lost", "sim_oop_zar", "sim_insurer_claim_zar",
        "sim_rationale",
      ],
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `sim-${i}`,
        age: 30 + i * 5,
        sex: i % 2 === 0 ? "F" : "M",
        income_band: "mid",
        education: "secondary",
        region: "urban",
        employment: "employed",
        comorbidities: "",
        vaccination: "up-to-date",
        insurance_cov: 0.5,
        sim_treatment_uptake: "accepted",
        sim_isolation_days: 3,
        sim_spending_shift: "unchanged",
        sim_infection_probability: 0.15,
        sim_severity_if_infected: "mild",
        sim_mortality_probability: 0.001,
        sim_hospitalised: "no",
        sim_workdays_lost: 2,
        sim_oop_zar: 500,
        sim_insurer_claim_zar: 0,
        sim_rationale: "test",
      })),
    };
    const metas = summariseDataset(simDataset);
    const sig = dataSignature(simDataset, metas);
    expect(sig.hasSimulationOutcomes).toBe(true);
    const pick = heuristicPick(sig);
    expect(pick.domain).toBe("general");
    expect(pick.selected.map((s) => s.id)).toContain("descriptive");
    // Critical guard: must NOT route to reserving (would error on the runners).
    expect(pick.domain).not.toBe("reserving");
  });
});

describe("Picked runners produce non-error results on their target sample", () => {
  test("reserving picks on claims sample all complete with non-zero IBNR", () => {
    const { dataset, pick } = pickFor("claims");
    for (const s of pick.selected) {
      const r = runModel(s.id, dataset);
      expect(r.status).toBe("done");
      // Each reserving model emits its own headline label, but on a real
      // triangle the value should be positive. This catches the prior
      // bug where buildTriangle's wrong latestCalPeriod inference made
      // every reserving model report 0.
      expect(r.headline.value).toBeGreaterThan(0);
    }
  });

  test("life picks on lifelib-mp sample all complete with non-zero headlines", () => {
    const { dataset, pick } = pickFor("lifelib-mp");
    for (const s of pick.selected) {
      const r = runModel(s.id, dataset);
      expect(r.status).toBe("done");
      // BasicTerm can produce a negative PV (loss-making book) — the
      // assertion is that the value is finite and non-zero, not that
      // it's positive. The other life models produce naturally
      // positive headlines (CSM, SCR, K).
      expect(Number.isFinite(r.headline.value)).toBe(true);
      expect(Math.abs(r.headline.value)).toBeGreaterThan(0);
    }
  });

  test("forecast picks on wmtr-scenarios sample all complete with finite outputs", () => {
    const { dataset, pick } = pickFor("wmtr-scenarios");
    for (const s of pick.selected) {
      const r = runModel(s.id, dataset);
      expect(r.status).toBe("done");
      expect(Number.isFinite(r.headline.value)).toBe(true);
      // wmtr-projection: headline is "Survival @ horizon" ∈ [0, 1].
      // wmtr-sensitivity: headline is "Collapse-Δ (severe − mild)" ∈ [-1, 1].
      expect(r.headline.value).toBeLessThanOrEqual(1);
      expect(r.headline.value).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("fetchModelPicks short-circuits on strong signatures (no LLM call)", () => {
  // A controller we never abort + a never-resolving orchestrator → if
  // fetchModelPicks calls the LLM these tests would hang. They pass
  // because the strong-signal short-circuit returns synchronously.
  const neverAbort = new AbortController().signal;

  test("lifelib-mp short-circuits to life family without touching LLM", async () => {
    const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === "lifelib-mp");
    if (!opt) throw new Error("lifelib-mp sample missing");
    const dataset = opt.build();
    const metas = summariseDataset(dataset);
    const res = await fetchModelPicks({
      dataset,
      metas,
      variant: 0,
      previousIds: [],
      signal: neverAbort,
    });
    expect(res.domain).toBe("life");
    expect(res.selected.map((s) => s.id)).toContain("basicterm-projection");
  });

  test("claims short-circuits to reserving family without touching LLM", async () => {
    const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === "claims");
    if (!opt) throw new Error("claims sample missing");
    const dataset = opt.build();
    const metas = summariseDataset(dataset);
    const res = await fetchModelPicks({
      dataset,
      metas,
      variant: 0,
      previousIds: [],
      signal: neverAbort,
    });
    expect(res.domain).toBe("reserving");
  });

  test("climate short-circuits to climate family without touching LLM", async () => {
    const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === "climate");
    if (!opt) throw new Error("climate sample missing");
    const dataset = opt.build();
    const metas = summariseDataset(dataset);
    const res = await fetchModelPicks({
      dataset,
      metas,
      variant: 0,
      previousIds: [],
      signal: neverAbort,
    });
    expect(res.domain).toBe("climate");
  });
});
