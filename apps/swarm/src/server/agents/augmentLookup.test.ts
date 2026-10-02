import { describe, expect, test } from 'bun:test';
import type { SimulationAgentResult, SocietyAgent } from '../../shared/types';
import { augmentRows, buildAugmentLookup, rowTraits } from './augmentLookup';
import { sampleSAPopulation } from './saPopulation';

/** An answered agent whose isolation days echo its age, so a row's median
 *  says which agents it was matched to. */
function answered(agent: SocietyAgent): SimulationAgentResult {
  return {
    agent,
    raw: '',
    outcome: {
      behaviour: {
        treatmentUptake: 'accepted',
        isolationDays: agent.age,
        spendingShift: 'unchanged',
        rationale: 'I would take it.',
      },
      health: {
        infectionProbability: 0.2,
        severityIfInfected: 'mild',
        mortalityProbability: 0,
        hospitalised: false,
      },
      economic: { workdaysLost: 0, outOfPocketCostZar: 0, insurerClaimZar: 0 },
    },
  };
}

const cohort = sampleSAPopulation({ size: 120, seed: 5, ageWeighting: 'age-balanced' }).map(
  answered,
);
const lookup = buildAugmentLookup(cohort);

describe('rowTraits', () => {
  test('reads age, sex and comorbidity case-insensitively', () => {
    expect(rowTraits({ Age: 47, SEX: 'Male', Comorbidities: 'copd' })).toEqual({
      age: 47,
      sex: 'M',
      hasComorbidity: true,
    });
    expect(rowTraits({ age_at_entry: '62', gender: 'female', comorbidities: '' })).toEqual({
      age: 62,
      sex: 'F',
      hasComorbidity: false,
    });
  });

  test('a row with no such columns states nothing — no default person', () => {
    expect(rowTraits({ entity: 'rural village', w_s: 0.3 })).toEqual({
      age: null,
      sex: null,
      hasComorbidity: null,
    });
  });

  test('blank, unreadable and coded values are unstated rather than guessed', () => {
    expect(rowTraits({ age: '', sex: '' }).age).toBeNull();
    expect(rowTraits({ age: '45-54' }).age).toBeNull();
    expect(rowTraits({ sex: 'unknown' }).sex).toBeNull();
    expect(rowTraits({ sex: '2' }).sex).toBeNull();
    expect(rowTraits({ sex: 'Woman' }).sex).toBe('F');
  });
});

describe('buildAugmentLookup', () => {
  test('a row that states nothing gets the whole cohort, labelled as such', () => {
    const out = lookup(rowTraits({ entity: 'term life book' }));
    expect(out?.sim_bucket_match).toBe('cohort');
    expect(out?.sim_bucket_n).toBe(cohort.length);
  });

  test('a fully stated row matches its own decade, sex and comorbidity', () => {
    const agent = cohort[0].agent;
    const sex = agent.sex ?? agent.health?.sex ?? 'F';
    const hasCom = !!agent.health && agent.health.comorbidities.length > 0;
    const out = lookup({ age: agent.age, sex, hasComorbidity: hasCom });
    expect(out?.sim_bucket_match).toBe('age10+sex+comorbidity');
    // Every agent in the bucket shares the row's decade.
    const decade = Math.floor(agent.age / 10) * 10;
    expect(Math.floor((out?.sim_isolation_days_median ?? -1) / 10) * 10).toBe(decade);
  });

  test('an unstated trait widens the match instead of being assumed', () => {
    expect(lookup({ age: 47, sex: 'M', hasComorbidity: null })?.sim_bucket_match).toBe(
      'age10+sex',
    );
    expect(lookup({ age: 47, sex: null, hasComorbidity: true })?.sim_bucket_match).toBe('age10');
    const bySex = lookup({ age: null, sex: 'F', hasComorbidity: null });
    expect(bySex?.sim_bucket_match).toBe('sex');
    expect(bySex?.sim_bucket_n).toBeLessThan(cohort.length);
  });

  test('with no answers at all there is nothing to add', () => {
    expect(buildAugmentLookup([])(rowTraits({ age: 40, sex: 'F' }))).toBeNull();
  });
});

describe('augmentRows', () => {
  test('lists the columns this pass added and fills every row', () => {
    const { rows, columns } = augmentRows([{ entity: 'a' }, { entity: 'b', age: 70 }], cohort);
    expect(columns).toHaveLength(12);
    expect(columns.every((c) => c.startsWith('sim_'))).toBe(true);
    for (const row of rows) for (const c of columns) expect(row[c]).not.toBeUndefined();
  });

  test('a re-run that got no answers adds nothing — old sim_* columns are not reported as new', () => {
    const before = [{ entity: 'a', sim_bucket_match: 'cohort', sim_bucket_n: 40 }];
    const { rows, columns } = augmentRows(before, []);
    expect(columns).toEqual([]);
    expect(rows).toEqual(before);
  });

  test('a re-run that did get answers overwrites the earlier values', () => {
    const before = [{ entity: 'a', sim_bucket_match: 'stale', sim_bucket_n: 1 }];
    const { rows } = augmentRows(before, cohort);
    expect(rows[0].sim_bucket_match).toBe('cohort');
    expect(rows[0].sim_bucket_n).toBe(cohort.length);
  });
});
