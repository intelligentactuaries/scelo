import { describe, expect, test } from 'bun:test';
import { stanceContradictsRisk } from './council';

// `key_risk` carries opposite meanings on either side of the vote: a
// supporter names what the forecast gets RIGHT, an opposer what it misses.
// On a measured run every single supporter answered with a criticism anyway,
// so the two groups appeared to be reasoning identically. This is the check
// that catches it.

describe('stanceContradictsRisk', () => {
  test('a supporter stating an objection is a contradiction', () => {
    for (const risk of [
      'ignores secure tenure and dependable harvests',
      'misses inherent stability',
      'overweights religion (R) given stable harvests',
      'underestimates the family buffer',
      'overemphasizes religion in village growers',
      'fails to account for tenure security',
      'neglects the spatial component',
      'omits the harvest cycle',
    ]) {
      expect(stanceContradictsRisk('support', risk)).toBe(true);
    }
  });

  test('a supporter naming a strength is coherent', () => {
    for (const risk of [
      'captures the tenure security that steadies these households',
      'reflects the dependable harvest cycle',
      'weights family cohesion about right',
      'gets the stability of secure tenure right',
    ]) {
      expect(stanceContradictsRisk('support', risk)).toBe(false);
    }
  });

  test('an objection is exactly what oppose and abstain are for', () => {
    // The check must never fire on the side where a criticism is correct —
    // rewriting those would be inventing agreement.
    expect(stanceContradictsRisk('oppose', 'ignores secure tenure')).toBe(false);
    expect(stanceContradictsRisk('abstain', 'no evidence on how long tenure held')).toBe(false);
    expect(stanceContradictsRisk('abstain', 'ignores the harvest record')).toBe(false);
  });

  test('a missing or empty risk is not a contradiction', () => {
    expect(stanceContradictsRisk('support', '')).toBe(false);
    expect(stanceContradictsRisk('support', undefined as unknown as string)).toBe(false);
  });

  test('substrings do not trip it', () => {
    // "dismissal" contains "miss"; a word-boundary match must not fire on it.
    expect(stanceContradictsRisk('support', 'captures the dismissal risk correctly')).toBe(false);
  });
});
