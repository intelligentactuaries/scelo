import { describe, expect, test } from 'bun:test';
import { parseOutcome, repairJson } from './simulation';

// The shapes a small local model actually returns. Every case here was a
// "parse failed: invalid JSON" cell in the simulation table.

const FULL = {
  behaviour: {
    treatmentUptake: 'accepted',
    isolationDays: 7,
    spendingShift: 'reduced',
    rationale: "I'd take it. The clinic is a taxi ride away but it's free, and my mother is in the house.",
  },
  health: {
    infectionProbability: 0.4,
    severityIfInfected: 'moderate',
    mortalityProbability: 0.02,
    hospitalised: true,
  },
  economic: { workdaysLost: 5, outOfPocketCostZar: 300, insurerClaimZar: 0 },
};

describe('repairJson', () => {
  test('reads a clean object unchanged', () => {
    const out = repairJson(JSON.stringify(FULL));
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(FULL);
  });

  test('strips markdown fences and a chatty preamble', () => {
    const out = repairJson(`Sure! Here is the JSON:\n\`\`\`json\n${JSON.stringify(FULL)}\n\`\`\`\nHope that helps.`);
    expect(JSON.parse(out as string)).toEqual(FULL);
  });

  test('drops trailing commas, which are legal JS but not JSON', () => {
    const text = `{"behaviour":{"treatmentUptake":"accepted","isolationDays":3,},"health":{},"economic":{},}`;
    const out = repairJson(text);
    expect(() => JSON.parse(out as string)).not.toThrow();
  });

  test('recovers a reply cut off at the token ceiling', () => {
    // This is the dominant real failure: the model runs out of tokens
    // mid-object, so the closing braces never arrive.
    const full = JSON.stringify(FULL);
    const truncated = full.slice(0, full.indexOf('"health"') + 30);
    const out = repairJson(truncated);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    // Everything the model DID finish survives — the whole point of repairing
    // rather than discarding the agent.
    expect(parsed.behaviour.treatmentUptake).toBe('accepted');
    expect(parsed.behaviour.rationale).toContain('taxi ride');
  });

  test('closes an unterminated string mid-rationale', () => {
    const out = repairJson('{"behaviour":{"treatmentUptake":"declined","rationale":"I just don\'t trust');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.behaviour.treatmentUptake).toBe('declined');
  });

  test('braces inside the rationale are not mistaken for structure', () => {
    const text = '{"behaviour":{"rationale":"they said {something} about it","treatmentUptake":"unsure"}}';
    const out = repairJson(text);
    expect(JSON.parse(out as string).behaviour.rationale).toBe('they said {something} about it');
  });

  test('a reply with no object at all is refused rather than guessed at', () => {
    expect(repairJson('I am sorry, I cannot help with that.')).toBeNull();
  });
});

describe('parseOutcome', () => {
  test('a good envelope parses with no failure', () => {
    const { outcome, failure } = parseOutcome(JSON.stringify(FULL));
    expect(failure).toBeUndefined();
    expect(outcome.behaviour.treatmentUptake).toBe('accepted');
    expect(outcome.behaviour.rationale).toContain('taxi ride');
    expect(outcome.health.hospitalised).toBe(true);
  });

  test('a failure NEVER writes a diagnostic into the rationale', () => {
    // This is the whole bug: "parse failed: invalid JSON" used to land in
    // sim_rationale, where it read as something the person had said.
    const { outcome, failure } = parseOutcome('total nonsense, no json here');
    expect(failure).toBeTruthy();
    expect(outcome.behaviour.rationale).toBe('');
  });

  test('an envelope with no rationale counts as a failure, not an empty opinion', () => {
    const { failure } = parseOutcome(
      JSON.stringify({ ...FULL, behaviour: { ...FULL.behaviour, rationale: '' } }),
    );
    expect(failure).toBeTruthy();
  });

  test('an asymptomatic case cannot be hospitalised or fatal', () => {
    // The macro layer reported 136,000 expected deaths beside a
    // severe-or-critical count of zero because these were never coupled.
    const { outcome } = parseOutcome(
      JSON.stringify({
        ...FULL,
        health: {
          infectionProbability: 0.9,
          severityIfInfected: 'asymptomatic',
          mortalityProbability: 0.5,
          hospitalised: true,
        },
      }),
    );
    expect(outcome.health.mortalityProbability).toBe(0);
    expect(outcome.health.hospitalised).toBe(false);
  });

  test('a mild case likewise', () => {
    const { outcome } = parseOutcome(
      JSON.stringify({
        ...FULL,
        health: { ...FULL.health, severityIfInfected: 'mild', mortalityProbability: 0.3 },
      }),
    );
    expect(outcome.health.mortalityProbability).toBe(0);
  });

  test('a moderate case can be admitted but not die', () => {
    // Deaths are modelled as passing through severe/critical, so that the
    // macro panel can never show more deaths than severe cases.
    const { outcome } = parseOutcome(JSON.stringify(FULL));
    expect(outcome.health.severityIfInfected).toBe('moderate');
    expect(outcome.health.hospitalised).toBe(true);
    expect(outcome.health.mortalityProbability).toBe(0);
  });

  test('a severe case keeps its reported mortality', () => {
    const { outcome } = parseOutcome(
      JSON.stringify({
        ...FULL,
        health: { ...FULL.health, severityIfInfected: 'severe', mortalityProbability: 0.02 },
      }),
    );
    expect(outcome.health.mortalityProbability).toBeCloseTo(0.02);
    expect(outcome.health.hospitalised).toBe(true);
  });

  test('out-of-range numbers are clamped, not rejected', () => {
    const { outcome } = parseOutcome(
      JSON.stringify({
        ...FULL,
        health: { ...FULL.health, infectionProbability: 4.2 },
        economic: { workdaysLost: 9999, outOfPocketCostZar: -5, insurerClaimZar: 0 },
      }),
    );
    expect(outcome.health.infectionProbability).toBe(1);
    expect(outcome.economic.workdaysLost).toBe(365);
    expect(outcome.economic.outOfPocketCostZar).toBe(0);
  });

  test('a truncated reply still yields a usable agent', () => {
    const full = JSON.stringify(FULL);
    const { outcome, failure } = parseOutcome(full.slice(0, full.indexOf('"health"') - 2));
    expect(failure).toBeUndefined();
    expect(outcome.behaviour.rationale).toContain('taxi ride');
  });
});
