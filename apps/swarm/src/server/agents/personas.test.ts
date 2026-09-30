import { describe, expect, test } from 'bun:test';
import type { CouncilAgent } from '../../shared/types';
import { buildSystemPrompt } from './personas';

const agent: CouncilAgent = { id: 'c-actuary-intj-f', profession: 'Actuary', mbti: 'INTJ', gender: 'F' };

describe('buildSystemPrompt', () => {
  test('with a forecast, the council interrogates the forecast', () => {
    const s = buildSystemPrompt(agent, '', { wmtrEvidence: '## Simulator Evidence (W(M,T,R) Nanoeconomics)\n…' });
    expect(s).toContain('interrogate a W(M, T, R) Nanoeconomics FORECAST');
    expect(s).toContain('Deliberation protocol (forecast interrogation)');
    expect(s).toContain('recommended_intervention');
  });

  test('without one, it assesses the scenario and is never told a forecast exists', () => {
    const s = buildSystemPrompt(agent, '');
    expect(s).toContain('assess a SCENARIO as it is stated');
    expect(s).toContain('Deliberation protocol (scenario assessment)');
    expect(s).toContain('you TRUST it: on what is given');
    // distrust needs a flaw in what is stated; missing detail is uncertainty
    expect(s).toContain('Missing detail is a reason for this, not for distrust');
    expect(s).not.toContain('interrogate a W(M, T, R)');
    expect(s).not.toContain('recommended_intervention');
  });
});
