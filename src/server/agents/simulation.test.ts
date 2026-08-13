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

// ─── Clinical risk banding ────────────────────────────────────────────────
//
// Personas self-assessed `severityIfInfected` with their comorbidities merely
// listed, and answered optimistically every time: on a scenario naming the
// over-65s as worst affected, all 24 agents came back asymptomatic or mild.
// Since admissions, mortality and the severe-count are all coupled to
// severity, that made the entire health block structurally zero on every
// scenario. The band is the anchor that stops it.

import { clinicalRiskFor } from './simulation';

function agentWith(age: number, comorbidities: string[]) {
  return {
    id: 's-0',
    age,
    incomeBand: 'mid',
    education: 'secondary',
    region: 'urban',
    riskTolerance: 0.5,
    employment: 'employed',
    financialLiteracy: 0.5,
    culture: 'sa',
    health: {
      sex: 'F',
      comorbidities,
      baselineMortality: 0.01,
      vaccinationHistory: 'none',
      trustInHealthSystem: 0.5,
      healthLiteracy: 0.5,
      insuranceCoverage: 0.5,
    },
  } as never;
}

describe('clinicalRiskFor', () => {
  test('a healthy young adult is low risk', () => {
    expect(clinicalRiskFor(agentWith(28, [])).band).toBe('low');
  });

  test('the case that came back asymptomatic: 58 with hypertension + diabetes', () => {
    // Measured output before the band existed: "asymptomatic". Diabetes is a
    // high-risk factor, so this must not read as low.
    const r = clinicalRiskFor(agentWith(58, ['hypertension', 'diabetes-t2']));
    expect(['high', 'very high']).toContain(r.band);
    expect(r.because).toContain('diabetes-t2');
  });

  test('age alone escalates', () => {
    expect(clinicalRiskFor(agentWith(40, [])).band).toBe('low');
    expect(clinicalRiskFor(agentWith(70, [])).band).toBe('high');
    expect(clinicalRiskFor(agentWith(80, [])).band).toBe('high');
  });

  test('an elderly agent with serious comorbidity reaches the top band', () => {
    expect(clinicalRiskFor(agentWith(78, ['copd', 'ckd'])).band).toBe('very high');
  });

  test('the band never drops as risk is added', () => {
    const order = ['low', 'moderate', 'high', 'very high'];
    const steps = [
      clinicalRiskFor(agentWith(30, [])),
      clinicalRiskFor(agentWith(30, ['obesity'])),
      clinicalRiskFor(agentWith(30, ['obesity', 'cvd'])),
      clinicalRiskFor(agentWith(78, ['obesity', 'cvd', 'copd'])),
    ];
    for (let i = 1; i < steps.length; i++) {
      expect(order.indexOf(steps[i].band)).toBeGreaterThanOrEqual(order.indexOf(steps[i - 1].band));
    }
  });

  test('an agent with no health profile is not assumed sick', () => {
    const bare = { id: 's-1', age: 30 } as never;
    expect(clinicalRiskFor(bare).band).toBe('low');
  });
});

// ─── Severity floor ───────────────────────────────────────────────────────

import { atLeastSeverity, severityFloorFor } from './simulation';

describe('severityFloorFor', () => {
  test('each band admits a minimum course', () => {
    expect(severityFloorFor('low')).toBe('asymptomatic');
    expect(severityFloorFor('moderate')).toBe('mild');
    expect(severityFloorFor('high')).toBe('moderate');
    expect(severityFloorFor('very high')).toBe('severe');
  });

  test('an unknown band floors nothing', () => {
    expect(severityFloorFor('')).toBe('asymptomatic');
  });
});

describe('atLeastSeverity', () => {
  test('raises an under-called course to the floor', () => {
    // The measured failure: very-high-risk agent self-reporting "mild".
    expect(atLeastSeverity('mild', 'severe')).toBe('severe');
    expect(atLeastSeverity('asymptomatic', 'moderate')).toBe('moderate');
  });

  test('never lowers a worse self-report', () => {
    // The persona read the scenario; the band did not. It may go higher.
    expect(atLeastSeverity('critical', 'severe')).toBe('critical');
    expect(atLeastSeverity('severe', 'mild')).toBe('severe');
  });

  test('leaves a matching report alone', () => {
    expect(atLeastSeverity('moderate', 'moderate')).toBe('moderate');
  });
});

describe('the floor releases the couplings rather than inventing numbers', () => {
  test("a floored severe case keeps the model's OWN mortality", () => {
    // Reported mild with a real mortality figure: the coupling zeroes
    // mortality below severe, so without the floor this agent could never
    // contribute a death however high-risk they were.
    const reply = JSON.stringify({
      ...FULL,
      health: {
        infectionProbability: 0.4,
        severityIfInfected: 'mild',
        mortalityProbability: 0.03,
        hospitalised: true,
      },
    });
    const without = parseOutcome(reply);
    expect(without.outcome.health.severityIfInfected).toBe('mild');
    expect(without.outcome.health.mortalityProbability).toBe(0);
    expect(without.outcome.health.hospitalised).toBe(false);

    const withFloor = parseOutcome(reply, { severityFloor: 'severe' });
    expect(withFloor.outcome.health.severityIfInfected).toBe('severe');
    // The model's own 0.03 — not a rate this code made up.
    expect(withFloor.outcome.health.mortalityProbability).toBeCloseTo(0.03);
    expect(withFloor.outcome.health.hospitalised).toBe(true);
  });

  test('a floor does not manufacture an admission the model refused', () => {
    const reply = JSON.stringify({
      ...FULL,
      health: {
        infectionProbability: 0.4,
        severityIfInfected: 'mild',
        mortalityProbability: 0,
        hospitalised: false,
      },
    });
    const { outcome } = parseOutcome(reply, { severityFloor: 'severe' });
    expect(outcome.health.severityIfInfected).toBe('severe');
    // Severity was raised; the admission still belongs to the model.
    expect(outcome.health.hospitalised).toBe(false);
    expect(outcome.health.mortalityProbability).toBe(0);
  });

  test('a low-risk agent is untouched', () => {
    const { outcome } = parseOutcome(JSON.stringify(FULL), { severityFloor: 'asymptomatic' });
    expect(outcome.health.severityIfInfected).toBe('moderate');
  });
});
