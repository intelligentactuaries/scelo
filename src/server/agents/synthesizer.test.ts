import { describe, expect, test } from 'bun:test';
import type { CouncilAgentResult, Stance } from '../../shared/types';
import { synthesize } from './synthesizer';

function agent(i: number, stance: Stance, keyRisk: string, confidence = 70): CouncilAgentResult {
  return {
    agent: {
      id: `a-${i}`,
      profession: 'Actuary',
      mbti: 'INTJ',
      gender: 'F',
    } as CouncilAgentResult['agent'],
    rounds: [],
    finalStance: stance,
    finalConfidence: confidence,
    keyRisk,
  };
}

describe('synthesize · risk totals', () => {
  test('reports the full cluster count, not just the slice it shows', () => {
    // Ten distinct worries; the panel lists eight. Without these counts the
    // readback presented the eight as the council's complete set.
    const risks = [
      'liquidity squeeze in year two',
      'mortality basis is stale',
      'lapse assumption ignores affordability',
      'currency mismatch on the liability side',
      'reinsurance counterparty concentration',
      'expense inflation understated',
      'regulatory capital add-on',
      'data quality in the claims triangle',
      'longevity trend extrapolated too far',
      'catastrophe cover exhausts at one event',
    ];
    const s = synthesize(risks.map((r, i) => agent(i, 'support', r)));
    expect(s.topRisks).toHaveLength(8);
    expect(s.riskClusterCount).toBe(10);
    expect(s.riskAgentsTotal).toBe(10);
    expect(s.riskAgentsShown).toBe(8);
  });

  test('counts describe agents, not clusters, when phrasings collapse', () => {
    const s = synthesize([
      agent(1, 'support', 'ignores ESG constraints'),
      agent(2, 'support', 'ignores ESG resilience'),
      agent(3, 'support', 'ignores ESG growth potential'),
      agent(4, 'oppose', 'ignores religion buffer'),
    ]);
    expect(s.riskClusterCount).toBe(2);
    expect(s.riskAgentsTotal).toBe(4);
    expect(s.topRisks[0].count).toBe(3);
  });

  test('failed agents contribute no risk and no phantom cluster', () => {
    const s = synthesize([
      agent(1, 'support', 'ignores religion buffer'),
      agent(2, 'abstain', '(error)'),
      agent(3, 'abstain', '(error)'),
    ]);
    expect(s.riskClusterCount).toBe(1);
    expect(s.riskAgentsTotal).toBe(1);
    expect(s.topRisks.map((r) => r.risk)).not.toContain('(error)');
  });

  test('dissenters stay sorted by confidence, as the panel label claims', () => {
    const s = synthesize([
      agent(1, 'support', 'a risk about lapses', 90),
      agent(2, 'support', 'a risk about lapses', 90),
      agent(3, 'oppose', 'a risk about expenses', 40),
      agent(4, 'oppose', 'a risk about mortality', 80),
    ]);
    expect(s.dissentingAgentIds).toEqual(['a-4', 'a-3']);
  });

  test('an empty council yields zeroed totals rather than NaN', () => {
    const s = synthesize([]);
    expect(s.consensusScore).toBe(0);
    expect(s.riskClusterCount).toBe(0);
    expect(s.riskAgentsTotal).toBe(0);
    expect(s.riskAgentsShown).toBe(0);
  });
});
