import { describe, expect, test } from 'bun:test';
import { clusterRisks, isStatedRisk, riskTokens } from './risks';

describe('riskTokens', () => {
  test('drops function words and generic analysis nouns', () => {
    expect([...riskTokens('ignores the ESG impact on the model outcome')].sort()).toEqual(['esg']);
  });

  test('drops the prompt verb template', () => {
    // Agents are asked what the forecast gets wrong, so nearly every reply
    // opens with one of these. Left in, every risk shares a token.
    for (const v of ['ignores', 'underweights', 'underestimates', 'overlooks', 'misses']) {
      expect(riskTokens(`${v} religion buffer`).has(v)).toBe(false);
    }
  });
});

describe('isStatedRisk', () => {
  test('a failure marker is not a risk the council raised', () => {
    // council.ts writes "(error)" when an agent's round-3 call dies; it used
    // to be counted and displayed as a substantive finding.
    expect(isStatedRisk('(error)')).toBe(false);
    expect(isStatedRisk('(parse failed)')).toBe(false);
    expect(isStatedRisk('n/a')).toBe(false);
    expect(isStatedRisk('')).toBe(false);
    expect(isStatedRisk(null)).toBe(false);
  });

  test('a phrase made only of stopwords is not a risk either', () => {
    expect(isStatedRisk('ignores the risk')).toBe(false);
  });

  test('a real risk is kept', () => {
    expect(isStatedRisk('ignores religion buffer')).toBe(true);
  });
});

describe('clusterRisks', () => {
  test('collapses phrasings of one worry that share no prefix', () => {
    // The exact case the prefix-keyed version could not see: four wordings
    // of "the forecast mishandles ESG", four different first-six-words.
    const clusters = clusterRisks([
      'ignores ESG constraints',
      "ignores ESG factors' impact on nominal rates and costs",
      'ignores ESG positive impact',
      'ignores ESG impact and underweights market dynamics',
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(4);
  });

  test('keeps genuinely different worries apart', () => {
    const clusters = clusterRisks([
      'ignores ESG constraints',
      'ignores ESG resilience',
      'ignores religion buffer',
      "ignores religion's stabilizing effect",
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.count).sort()).toEqual([2, 2]);
  });

  test('the label is the most-cited wording, not whichever came first', () => {
    const clusters = clusterRisks([
      'ignores ESG factors across the whole portfolio horizon',
      'ignores ESG constraints',
      'ignores ESG constraints',
    ]);
    expect(clusters[0].risk).toBe('ignores ESG constraints');
  });

  test('does not let the first cluster become a magnet', () => {
    // Widening a cluster with each joiner's tokens made every later risk
    // easier to absorb, so a 32-agent ESG run collapsed into one cluster
    // labelled "religion buffer". Matching stays against the seed.
    const clusters = clusterRisks([
      'ignores religion buffer',
      'ignores ESG constraints',
      'ignores ESG resilience',
      'ignores ESG growth potential',
      'ignores high interest rates on market stability',
    ]);
    const top = clusters[0];
    expect(top.risk).toContain('ESG');
    expect(top.count).toBe(3);
    expect(clusters.length).toBeGreaterThan(1);
  });

  test('error markers never appear as a cluster', () => {
    const clusters = clusterRisks([
      '(error)',
      '(error)',
      '(error)',
      'ignores religion buffer',
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].risk).toBe('ignores religion buffer');
    expect(clusters[0].count).toBe(1);
  });

  test('counts total the agents who stated a risk', () => {
    const risks = [
      'ignores ESG constraints',
      'ignores ESG resilience',
      'ignores religion buffer',
      '(error)',
    ];
    const total = clusterRisks(risks).reduce((n, c) => n + c.count, 0);
    expect(total).toBe(3); // the error is excluded, everyone else is counted
  });

  test('empty input yields no clusters', () => {
    expect(clusterRisks([])).toEqual([]);
  });
});
