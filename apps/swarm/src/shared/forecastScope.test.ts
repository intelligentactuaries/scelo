import { describe, expect, test } from 'bun:test';
import { SCENARIO_PRESETS } from '../client/components/ScenarioPanel';
import { forecastAppliesTo, voteSubject, wantsForecast } from './forecastScope';

const preset = (label: string) => {
  const p = SCENARIO_PRESETS.find((x) => x.label === label);
  if (!p) throw new Error(`no preset ${label}`);
  return p.value;
};

describe('forecastAppliesTo', () => {
  test('the community presets get a forecast', () => {
    expect(forecastAppliesTo(preset('Rural village · Mozambique drought'))).toBe(true);
    expect(forecastAppliesTo(preset('Farming village · steady growth'))).toBe(true);
    expect(forecastAppliesTo(preset('City district · generational collapse'))).toBe(true);
  });

  test('the finance presets do not: the engine has no community to simulate', () => {
    expect(forecastAppliesTo(preset('Pension fund · EM REIT'))).toBe(false);
    expect(forecastAppliesTo(preset('Life insurer · CSM release'))).toBe(false);
    expect(forecastAppliesTo(preset('Sovereign fund · transition'))).toBe(false);
  });

  test('results Scelo sends from the Hard stage do not', () => {
    // Verbatim from runs that came back 100% distrust.
    expect(
      forecastAppliesTo(
        'Bootstrap (IBNR) (reserving) result on dataset `claims_sample (synthetic)`: IBNR mean = 1,554,027. Bundled-CPython numpy reserving engine (bootstrap) across 7 origins produced IBNR = 1,554,027 with a p5–p95 band of 1,083,307 – 2,103,617.',
      ),
    ).toBe(false);
    expect(
      forecastAppliesTo(
        'GBM (LightGBM) (pricing) result on dataset `messy_intake (dirty demo)`: R² (holdout) · age = -0.798. In-browser gradient-boosted trees (100 × depth 3, 8 features) predict `age` with holdout R² -0.798 on 10 held-out rows.',
      ),
    ).toBe(false);
  });

  test('a place word inside finance does not open it', () => {
    expect(forecastAppliesTo('A City of London insurer weighs a longevity swap on its annuity book.')).toBe(false);
    expect(forecastAppliesTo('An urban office REIT refinances at 2.1x leverage.')).toBe(false);
  });

  test('a community with money in it still gets a forecast', () => {
    expect(
      forecastAppliesTo('A fishing village community pools its savings into a fund after two bad seasons.'),
    ).toBe(true);
  });
});

test('voteSubject names what the council voted on', () => {
  expect(voteSubject({ wmtr: {} })).toBe('the forecast');
  expect(voteSubject({})).toBe('the scenario');
});

describe('wantsForecast', () => {
  const reit = preset('Pension fund · EM REIT');
  const village = preset('Rural village · Mozambique drought');
  test('left unset, the scenario decides', () => {
    expect(wantsForecast({ scenario: village })).toBe(true);
    expect(wantsForecast({ scenario: reit })).toBe(false);
  });
  test('an explicit wmtrEnabled wins either way', () => {
    expect(wantsForecast({ scenario: reit, wmtrEnabled: true })).toBe(true);
    expect(wantsForecast({ scenario: village, wmtrEnabled: false })).toBe(false);
  });
  test('an intervention re-run keeps its forecast', () => {
    expect(wantsForecast({ scenario: reit, wmtrOverrides: { shock: 'severe' } })).toBe(true);
  });
});
