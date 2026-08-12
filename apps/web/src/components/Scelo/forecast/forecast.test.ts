import { describe, expect, test } from "bun:test";
import { deriveConfigFromScenario } from "./derive";
import { componentContributions, runForecast } from "./runner";
import { DEFAULT_WMTR_SINGLE_PARAMS, runSingleCommunity } from "./wmtr";

// These cover three defects that made the forecast — and the council evidence
// built from it — disagree with the simulation it was supposedly reporting.

describe("outcome classification", () => {
  test("a path that ends up is never labelled 'declined'", () => {
    let contradictions = 0;
    let checked = 0;
    for (let seed = 0; seed < 60; seed++) {
      for (const shock of ["mild", "moderate", "severe"] as const) {
        const r = runSingleCommunity({
          ...DEFAULT_WMTR_SINGLE_PARAMS,
          seed,
          shock,
          nPaths: 20,
        });
        for (const p of r.paths) {
          checked++;
          const ratio = p.wHist[p.wHist.length - 1] / p.wHist[0];
          if (p.outcome === "declined" && ratio >= 1) contradictions++;
          if (p.outcome === "grew" && ratio <= 1) contradictions++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(contradictions).toBe(0);
  });

  test("the (stability, growth] band reads as stabilized, not declined", () => {
    // A +15% end against a +20% growth bar and a ±10% stability band used to
    // fall through to "declined" — the gap between the two thresholds.
    const r = runSingleCommunity({
      ...DEFAULT_WMTR_SINGLE_PARAMS,
      seed: 3613,
      shock: "mild",
      nPaths: 200,
    });
    const upPaths = r.paths.filter((p) => p.wHist[p.wHist.length - 1] > p.wHist[0]);
    expect(upPaths.length).toBeGreaterThan(0);
    expect(upPaths.every((p) => p.outcome !== "declined")).toBe(true);
  });
});

describe("scenario cue matching", () => {
  test("does not fire on words that merely contain a cue", () => {
    // 'war' inside software/warranty/award/forward, 'normal' inside
    // normalising — each used to decide the shock environment outright.
    for (const s of [
      "A software vendor outage disrupts claims handling",
      "A motor warranty book is repriced after adverse development",
      "The tribunal award moves the reserve forward",
      "SCR ratio slips just as rates are normalising",
      "a destabilising run on deposits",
    ]) {
      expect(deriveConfigFromScenario(s).shock).toBe("moderate");
    }
  });

  test("still fires on the real cues, including stems and plurals", () => {
    for (const s of [
      "A severe pandemic collapses the local economy",
      "post-war reconstruction funding",
      "civil wars across the region",
      "a catastrophic flood",
      "successive crises hit the book",
    ]) {
      expect(deriveConfigFromScenario(s).shock).toBe("severe");
    }
    for (const s of [
      "markets remain calm and stable",
      "an orderly, benign run-off under normal conditions",
    ]) {
      expect(deriveConfigFromScenario(s).shock).toBe("mild");
    }
  });

  test("reads snake_case identifiers as the words they are made of", () => {
    // `forecastConfigFor` synthesises its scenario from a result's headline and
    // context, which quote dataset filenames verbatim. `_` is a word character
    // to a regex, so without normalising it `\breserv...\b` would miss here and
    // the run would silently fall back to the default alphas.
    const c = deriveConfigFromScenario("motor_reserving_triangle_2024 developed to ultimate");
    expect(c.alphaM).toBeCloseTo(0.55, 5);
    expect(c.alphaR).toBeCloseTo(0.15, 5);
    expect(deriveConfigFromScenario("sa_pandemic_mortality_v2").shock).toBe("severe");
  });

  test("reserving cues survive the switch to word-bounded matching", () => {
    const c = deriveConfigFromScenario("IBNR reserving on an incomplete triangle");
    expect(c.alphaM).toBeCloseTo(0.55, 5);
    expect(c.alphaR).toBeCloseTo(0.15, 5);
  });
});

describe("dominant driver", () => {
  // The measure ranks how far each component MOVED, not where it sits. An
  // earlier version ranked the log levels, which is not comparable across
  // components: M always starts at 1 so ln M is its own log change, but T is
  // a fraction of a day and R a [0,1] index, so their logs are large and
  // negative even when they never budge. That handed a flat component a big
  // negative "contribution" and named it the driver on most runs.
  test("a component that never moves contributes nothing", () => {
    const flatT = {
      ...runSingleCommunity({ ...DEFAULT_WMTR_SINGLE_PARAMS, seed: 11, nPaths: 4 }),
    };
    // Pin T flat at a level well below 1 — the case the old rule misread —
    // while M and R keep whatever the simulation gave them.
    flatT.paths = flatT.paths.map((p) => ({
      ...p,
      tHist: p.tHist.map(() => 0.4),
    }));
    const c = componentContributions(flatT);
    expect(c.T).toBe(0);
    // ...and the driver is then whichever of M / R actually moved.
    expect(["M", "R"]).toContain(
      (["M", "T", "R"] as const).reduce((best, k) =>
        Math.abs(c[k]) > Math.abs(c[best]) ? k : best,
      ),
    );
  });

  test("contributions sum exactly to the mean log change in W", () => {
    const r = runSingleCommunity({ ...DEFAULT_WMTR_SINGLE_PARAMS, seed: 7, nPaths: 50 });
    const c = componentContributions(r);
    // Cobb-Douglas differences exactly, per path, with no residual term.
    const last = r.years.length - 1;
    const meanLogChange =
      r.paths.reduce(
        (s, p) => s + Math.log(p.wHist[last]) - Math.log(p.wHist[0]),
        0,
      ) / r.paths.length;
    expect(c.M + c.T + c.R).toBeCloseTo(meanLogChange, 12);
  });

  test("the named driver is the largest absolute contribution", () => {
    for (const seed of [3613, 7, 42]) {
      for (const shock of ["mild", "moderate", "severe"] as const) {
        const cfg = { ...DEFAULT_WMTR_SINGLE_PARAMS, seed, shock };
        const c = componentContributions(runSingleCommunity(cfg));
        const expected = (["M", "T", "R"] as const).reduce((best, k) =>
          Math.abs(c[k]) > Math.abs(c[best]) ? k : best,
        );
        expect(runForecast(cfg, "forecast").driver).toBe(expected);
      }
    }
  });
});
