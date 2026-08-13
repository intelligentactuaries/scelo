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
    // 'oppose', not 'support': `topRisks` is now drawn only from the agents
    // who object, because a supporter's key_risk is an endorsement.
    const s = synthesize(risks.map((r, i) => agent(i, 'oppose', r)));
    expect(s.topRisks).toHaveLength(8);
    expect(s.riskClusterCount).toBe(10);
    expect(s.riskAgentsTotal).toBe(10);
    expect(s.riskAgentsShown).toBe(8);
  });

  test('counts describe agents, not clusters, when phrasings collapse', () => {
    const s = synthesize([
      agent(1, 'oppose', 'ignores ESG constraints'),
      agent(2, 'oppose', 'ignores ESG resilience'),
      agent(3, 'oppose', 'ignores ESG growth potential'),
      agent(4, 'oppose', 'ignores religion buffer'),
    ]);
    expect(s.riskClusterCount).toBe(2);
    expect(s.riskAgentsTotal).toBe(4);
    expect(s.topRisks[0].count).toBe(3);
  });

  test('failed agents contribute no risk and no phantom cluster', () => {
    const s = synthesize([
      agent(1, 'oppose', 'ignores religion buffer'),
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

  test('a supporter\'s endorsement never lands in the risk list', () => {
    // The bug this exists to prevent: `keyRisk` means opposite things on
    // either side of the vote, and both sides draw on the same vocabulary —
    // so an unsplit clustering put "captures the tenure security" in the same
    // cluster as "ignores secure tenure", and trusting and distrusting agents
    // appeared to be reasoning identically.
    const s = synthesize([
      agent(1, 'support', 'captures the tenure security that steadies these households'),
      agent(2, 'support', 'captures secure tenure'),
      agent(3, 'oppose', 'ignores secure tenure and dependable harvests'),
      agent(4, 'oppose', 'ignores secure tenure'),
      agent(5, 'abstain', 'no data on how long tenure has held'),
    ]);
    const risks = s.topRisks.map((r) => r.risk).join(' | ');
    expect(risks).not.toContain('captures');
    const captures = (s.topCaptures ?? []).map((r) => r.risk).join(' | ');
    expect(captures).not.toContain('ignores');
    // Abstainers are stating a gap, so they belong with the objections.
    expect(s.riskAgentsTotal).toBe(3);
    expect(s.captureAgentsTotal).toBe(2);
  });

  test('the two sides are counted apart even when identically worded', () => {
    const s = synthesize([
      agent(1, 'support', 'secure tenure'),
      agent(2, 'oppose', 'secure tenure'),
    ]);
    expect(s.riskAgentsTotal).toBe(1);
    expect(s.captureAgentsTotal).toBe(1);
    expect(s.riskClusterCount).toBe(1);
    expect(s.captureClusterCount).toBe(1);
  });

  test('a unanimous council leaves the opposite list empty, not wrong', () => {
    const s = synthesize([
      agent(1, 'support', 'captures the harvest stability'),
      agent(2, 'support', 'captures secure tenure'),
    ]);
    expect(s.topRisks).toHaveLength(0);
    expect(s.riskAgentsTotal).toBe(0);
    expect((s.topCaptures ?? []).length).toBe(2);
  });

  test('an empty council yields zeroed totals rather than NaN', () => {
    const s = synthesize([]);
    expect(s.consensusScore).toBe(0);
    expect(s.riskClusterCount).toBe(0);
    expect(s.riskAgentsTotal).toBe(0);
    expect(s.riskAgentsShown).toBe(0);
    expect(s.captureAgentsTotal).toBe(0);
  });
});
