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
        "id",
        "age",
        "sex",
        "income_band",
        "education",
        "region",
        "employment",
        "comorbidities",
        "vaccination",
        "insurance_cov",
        "sim_treatment_uptake",
        "sim_isolation_days",
        "sim_spending_shift",
        "sim_infection_probability",
        "sim_severity_if_infected",
        "sim_mortality_probability",
        "sim_hospitalised",
        "sim_workdays_lost",
        "sim_oop_zar",
        "sim_insurer_claim_zar",
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

  test("regenerating a strong-signal pick rotates a same-family alternate (still no LLM)", async () => {
    const opt = SAMPLE_OPTIONS_LIST().find((o) => o.key === "lifelib-mp");
    if (!opt) throw new Error("lifelib-mp sample missing");
    const dataset = opt.build();
    const metas = summariseDataset(dataset);
    const base = await fetchModelPicks({
      dataset,
      metas,
      variant: 0,
      previousIds: [],
      signal: neverAbort,
    });
    const regen = await fetchModelPicks({
      dataset,
      metas,
      variant: 1,
      previousIds: base.selected.map((s) => s.id),
      signal: neverAbort,
    });
    // Same family, same pick count — but a different mix, so regenerate
    // isn't a silent no-op even on the deterministic short-circuit path.
    expect(regen.domain).toBe("life");
    expect(regen.selected.length).toBe(base.selected.length);
    expect(regen.selected.map((s) => s.id)).not.toEqual(base.selected.map((s) => s.id));
  });
});

// The regression of record for pricing: the REAL 2M-row motor-insurance
// header (321.6 MB hackathon CSV) deterministically routed to climate —
// `province` tripped hasGeographic, `past_claims` missed the anchored
// claims regex, and the geographic-only branch preceded any pricing check.
describe("Tools picker · real motor rating book (hackathon header)", () => {
  // All 25 columns, verbatim — including the `sum_insurd` misspelling.
  const MOTOR_COLUMNS = [
    "id",
    "acq_chan",
    "airbags",
    "car_year",
    "dist_trvld",
    "empl_type",
    "financed",
    "gear_type",
    "hp",
    "car_make",
    "marital_st",
    "night_drv",
    "no_gears",
    "past_claims",
    "past_ins",
    "province",
    "carcolour",
    "sum_insurd",
    "tar_weight",
    "gender",
    "new_used",
    "excess",
    "policy_start_date",
    "dob",
    "lic_date",
  ];

  function motorDataset() {
    return {
      name: "hackathon_train_data",
      columns: MOTOR_COLUMNS,
      rows: Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        acq_chan: i % 2 === 0 ? "Broker" : "Direct",
        // airbags / no_gears mix numbers with the literal "6+" in the raw file
        airbags: i % 6 === 0 ? "6+" : 2 + (i % 3),
        car_year: 2010 + (i % 12),
        dist_trvld: 8000 + i * 950,
        empl_type: ["Salaried", "Self-employed", "Unemployed"][i % 3],
        financed: i % 2 === 0 ? "Y" : "N",
        gear_type: i % 2 === 0 ? "Manual" : "Automatic",
        hp: 55 + (i % 7) * 10,
        car_make: ["Toyota", "VW", "Ford", "BMW"][i % 4],
        // ~10% of the real column carries the "Seperated" typo — keep one in
        marital_st: ["Married", "Single", "Seperated"][i % 3],
        night_drv: i % 2 === 0 ? "Y" : "N",
        no_gears: i % 6 === 0 ? "6+" : 4 + (i % 2),
        past_claims: i % 4,
        past_ins: i % 5 === 0 ? "NULL" : "InsurerA",
        province: ["GP", "WC", "KZN", "LIM"][i % 4],
        carcolour: ["white", "silver", "blue"][i % 3],
        sum_insurd: 120_000 + i * 15_000,
        tar_weight: 1100 + (i % 5) * 60,
        gender: i % 2 === 0 ? "F" : "M",
        new_used: i % 3 === 0 ? "New" : "Used",
        excess: 3500 + (i % 4) * 500,
        policy_start_date: `2023-0${(i % 9) + 1}-15`,
        dob: `19${70 + (i % 25)}-06-0${(i % 9) + 1}`,
        lic_date: `20${String(i % 20).padStart(2, "0")}-03-12`,
      })),
    };
  }

  test("signature registers the pricing signals (and NOT the life / monetary ones)", () => {
    const dataset = motorDataset();
    const sig = dataSignature(dataset, summariseDataset(dataset));
    expect(sig.hasClaimsCount).toBe(true); // past_claims
    expect(sig.hasSumInsured).toBe(true); // sum_insurd misspelling
    expect(sig.hasExcess).toBe(true);
    expect(sig.hasGeographic).toBe(true); // province — but must NOT win routing
    expect(sig.hasDateColumn).toBe(true); // policy_start_date / dob / lic_date
    expect(sig.hasClaimsAmount).toBe(false); // past_claims is a COUNT
    expect(sig.hasPaid).toBe(false);
    expect(sig.hasSumAssured).toBe(false); // sum_insurd must not read as life
    expect(sig.numCategorical).toBeGreaterThanOrEqual(3);
  });

  test("routes to pricing (glm-frequency + gbm + shap), never climate, no severity", () => {
    const dataset = motorDataset();
    const sig = dataSignature(dataset, summariseDataset(dataset));
    const pick = heuristicPick(sig);
    expect(pick.domain).toBe("pricing");
    const ids = pick.selected.map((s) => s.id);
    expect(ids).toContain("glm-frequency");
    expect(ids).toContain("gbm");
    expect(ids).toContain("shap");
    // No monetary claims column → severity must NOT be picked.
    expect(ids).not.toContain("glm-severity");
    // The original bug: province routed the whole book to climate.
    expect(ids).not.toContain("climada");
    expect(ids).not.toContain("parametric-design");
  });
});

describe("Tools picker · geographic branch only fires on hazard/exposure-shaped schemas", () => {
  test("narrow geo + exposure schema still routes to climate", () => {
    const dataset = {
      name: "provincial_exposure",
      columns: ["province", "site_lat", "site_lon", "exposure"],
      rows: Array.from({ length: 10 }, (_, i) => ({
        province: ["GP", "WC", "KZN"][i % 3],
        site_lat: -33 + i * 0.5,
        site_lon: 18 + i * 0.5,
        exposure: 1000 + i * 250,
      })),
    };
    const sig = dataSignature(dataset, summariseDataset(dataset));
    const pick = heuristicPick(sig);
    expect(pick.domain).toBe("climate");
    expect(pick.selected.map((s) => s.id)).toContain("climada");
  });

  test("geo code buried in a wide covariate table falls through (NOT climate)", () => {
    // Ten columns, no weather / exposure / pricing signals — the province
    // column alone must not drag the dataset into the climate family.
    const dataset = {
      name: "wide_covariates",
      columns: [
        "quote_ref",
        "province",
        "channel",
        "colour",
        "segment",
        "score_a",
        "score_b",
        "score_c",
        "score_d",
        "score_e",
      ],
      rows: Array.from({ length: 10 }, (_, i) => ({
        quote_ref: `Q${i}`,
        province: ["GP", "WC", "KZN"][i % 3],
        channel: i % 2 === 0 ? "web" : "call",
        colour: ["red", "blue"][i % 2],
        segment: ["a", "b", "c"][i % 3],
        score_a: i,
        score_b: i * 2,
        score_c: i * 3,
        score_d: i * 4,
        score_e: i * 5,
      })),
    };
    const sig = dataSignature(dataset, summariseDataset(dataset));
    expect(sig.hasGeographic).toBe(true);
    const pick = heuristicPick(sig);
    expect(pick.domain).not.toBe("climate");
    expect(pick.domain).toBe("general");
  });
});

describe("heuristicPick · deterministic variant rotation (offline regenerate)", () => {
  // Reuse the wide motor shape — its pricing family has exactly one
  // unpicked alternate (glm-severity), so rotation is fully predictable.
  const dataset = {
    name: "rotation_probe",
    columns: ["policy_ref", "past_claims", "province", "car_make", "gender", "sum_insurd"],
    rows: Array.from({ length: 8 }, (_, i) => ({
      policy_ref: `P${i}`,
      past_claims: i % 3,
      province: ["GP", "WC"][i % 2],
      car_make: ["Toyota", "VW", "Ford"][i % 3],
      gender: i % 2 === 0 ? "F" : "M",
      sum_insurd: 100_000 + i * 10_000,
    })),
  };
  const sig = dataSignature(dataset, summariseDataset(dataset));

  test("variant 0 is the canonical pick; variant > 0 swaps exactly one same-family alternate", () => {
    const base = heuristicPick(sig);
    expect(base.domain).toBe("pricing");
    const v1 = heuristicPick(sig, 1);
    expect(v1.domain).toBe("pricing");
    expect(v1.selected.length).toBe(base.selected.length);
    expect(v1.selected.map((s) => s.id)).not.toEqual(base.selected.map((s) => s.id));
    // pricing's only unpicked alternate is glm-severity — it rotates in.
    expect(v1.selected.map((s) => s.id)).toContain("glm-severity");
    // Deterministic: the same variant always yields the same mix.
    expect(heuristicPick(sig, 1)).toEqual(v1);
    // Successive variants cycle to a different swap.
    expect(heuristicPick(sig, 2).selected.map((s) => s.id)).not.toEqual(
      v1.selected.map((s) => s.id),
    );
  });

  test("rotation is a no-op when the family has no unpicked alternates (claims triangle)", () => {
    const { dataset: claims, pick } = pickFor("claims");
    const claimsSig = dataSignature(claims, summariseDataset(claims));
    // All four reserving models are already picked — nothing to rotate in.
    const rotated = heuristicPick(claimsSig, 5);
    expect(rotated.selected.map((s) => s.id)).toEqual(pick.selected.map((s) => s.id));
  });
});
