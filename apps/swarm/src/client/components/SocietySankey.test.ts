import { describe, expect, test } from 'bun:test';
import type { Run, Sentiment, SocietyAgentResult } from '../../shared/types';
import { absentSentiments } from './SocietySankey';

function member(sentiment: Sentiment, cluster = 0): SocietyAgentResult {
  return {
    agent: { id: `s-${Math.random()}` } as SocietyAgentResult['agent'],
    reaction: '',
    sentiment,
    intensity: 50,
    cluster,
  };
}

function run(results: SocietyAgentResult[]): Run {
  return { societyResults: results } as unknown as Run;
}

describe('absentSentiments', () => {
  test('names the sentiments nobody expressed', () => {
    // Every run measured had at least one — on a real 200-persona run it was
    // skeptical and hostile, which ECharts then stacked on the right-hand
    // edge because a node with no links has no depth to place it by.
    const r = run([member('enthusiastic'), member('supportive'), member('neutral')]);
    expect(absentSentiments(r)).toEqual(['skeptical', 'hostile']);
  });

  test('a fully-represented run names none', () => {
    const r = run([
      member('enthusiastic'),
      member('supportive'),
      member('neutral'),
      member('skeptical'),
      member('hostile'),
    ]);
    expect(absentSentiments(r)).toEqual([]);
  });

  test('an empty society is entirely absent, not partially', () => {
    expect(absentSentiments(run([]))).toHaveLength(5);
  });

  test('order follows the scale, not encounter order', () => {
    // enthusiastic → hostile is a diverging scale; reporting it out of order
    // would read as an arbitrary list.
    const r = run([member('neutral')]);
    expect(absentSentiments(r)).toEqual(['enthusiastic', 'supportive', 'skeptical', 'hostile']);
  });
});
