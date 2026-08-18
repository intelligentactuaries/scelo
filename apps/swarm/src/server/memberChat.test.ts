// Member interviews: the prompt must carry the member's fixed record and
// theory, and the restated-position footer must be parsed and judged
// against that record — this is what makes the interview an audit rather
// than a chat.

import { describe, expect, test } from 'bun:test';
import type { Run, CouncilAgentResult, SocietyAgentResult } from '../shared/types';
import {
  buildMemberInterviewPrompt,
  findMember,
  judgeConsistency,
  parseRestatedPosition,
  stripRestatedFooter,
} from './memberChat';

const council: CouncilAgentResult = {
  agent: { id: 'c-actuary-intj-f', profession: 'Actuary', mbti: 'INTJ', gender: 'F' },
  rounds: [
    { round: 1, content: 'The forecast understates longevity tail risk. CONFIDENCE: 55', confidence: 55 },
    { round: 2, content: 'Peers persuaded me the buffer holds; I now lean to trust. CONFIDENCE: 68', confidence: 68 },
    {
      round: 3,
      content: '{"stance":"support","confidence":72,"key_risk":"captures the religion buffer correctly"}',
      confidence: 72,
      stance: 'support',
      keyRisk: 'captures the religion buffer correctly',
    },
  ],
  finalStance: 'support',
  finalConfidence: 72,
  keyRisk: 'captures the religion buffer correctly',
  intervention: { param: 'alphaR', direction: 'increase', magnitude: 'small', rationale: 'relational capital is under-weighted' },
};

const society: SocietyAgentResult = {
  agent: {
    id: 's-0007',
    age: 43,
    incomeBand: 'low',
    education: 'secondary',
    region: 'periurban',
    riskTolerance: 0.3,
    employment: 'informal',
    financialLiteracy: 0.35,
    culture: 'South Africa',
  },
  reaction: 'Sounds like more promises; my stokvel is what keeps us going, not forecasts.',
  sentiment: 'skeptical',
  intensity: 64,
  cluster: 2,
};

const run: Run = {
  id: 'run-test',
  scenario: 'A township savings cooperative faces a 30% drop in remittances over five years.',
  societyParams: {} as Run['societyParams'],
  providerPrefs: { councilProvider: 'auto', societyProvider: 'auto', chatProvider: 'auto' },
  createdAt: 0,
  status: 'complete',
  councilResults: [council],
  councilEdges: [],
  societyResults: [society],
  societyEdges: [],
  societySummary: {
    size: 1,
    sentimentMix: { enthusiastic: 0, supportive: 0, neutral: 0, skeptical: 1, hostile: 0 },
    averageIntensity: 64,
    clusters: [
      { cluster: 2, size: 120, description: 'low-income periurban informal workers', sentimentMix: { enthusiastic: 0, supportive: 0, neutral: 0, skeptical: 120, hostile: 0 } },
    ],
  },
};

describe('findMember', () => {
  test('resolves council and society ids, null otherwise', () => {
    expect(findMember(run, 'c-actuary-intj-f')?.kind).toBe('council');
    expect(findMember(run, 's-0007')?.kind).toBe('society');
    expect(findMember(run, 'c-nope')).toBeNull();
  });
});

describe('council interview prompt', () => {
  const { system, recorded } = buildMemberInterviewPrompt(run, findMember(run, 'c-actuary-intj-f')!);
  test('is built on the original persona brief', () => {
    expect(system).toContain('You are agent c-actuary-intj-f');
    expect(system).toContain('female Actuary');
    expect(system).toContain('INTJ');
    expect(system).toContain('IAAI Canon');
  });
  test('carries the fixed record: every round, confidences, vote, key risk, intervention', () => {
    expect(system).toContain('Round 1 (independent view, confidence 55)');
    expect(system).toContain('understates longevity tail risk');
    expect(system).toContain('Round 2 (after the peer digest, confidence 68)');
    expect(system).toContain('Round 3 — VOTE: TRUST the forecast, confidence 72');
    expect(system).toContain('captures the religion buffer correctly');
    expect(system).toContain('increase alphaR (small)');
    expect(system).toContain('Recorded verdict: TRUST the forecast, confidence 72/100');
    // the raw vote JSON is not echoed as prose
    expect(system).not.toContain('"stance":"support"');
  });
  test("falls back to the profession's toolkit when no justification is recorded", () => {
    expect(system).toContain('TOOLKIT (Actuary)');
    expect(system).toContain('Bowers');
    expect(system).toContain('articulating it now');
  });
  test('states the consistency rules and the machine-read footer with the recorded values', () => {
    expect(system).toContain('the recorded vote stands for this run');
    expect(system).toContain('[[position: trust|72]]');
    expect(system).toContain('TRUST / DISTRUST / UNCERTAIN');
    expect(system).toContain('Never emit JSON objects');
    expect(recorded).toEqual({ label: 'support', score: 72 });
  });
});

describe('society interview prompt', () => {
  const { system, recorded } = buildMemberInterviewPrompt(run, findMember(run, 's-0007')!);
  test('is the same person, with reaction, sentiment, intensity and cluster', () => {
    expect(system).toContain('43-year-old low-income periurban informal in South Africa');
    expect(system).toContain('NOT a financial expert');
    expect(system).toContain('my stokvel is what keeps us going');
    expect(system).toContain('Sentiment: SKEPTICAL (intensity 64/100)');
    expect(system).toContain('grouped with 120 people like you');
    expect(system).toContain('[[sentiment: skeptical|64]]');
    expect(recorded).toEqual({ label: 'skeptical', score: 64 });
  });
  test('forbids expert voice', () => {
    expect(system).toContain('no jargon');
  });
});

describe('restated-position footer', () => {
  test('parses council and society footers, tolerant of case and spacing', () => {
    expect(parseRestatedPosition('I hold my view.\n[[position: trust|70]]')).toEqual({ field: 'position', label: 'support', score: 70 });
    expect(parseRestatedPosition('...\n[[ Position : Distrust | 40 ]]')).toEqual({ field: 'position', label: 'oppose', score: 40 });
    expect(parseRestatedPosition('...\n[[position: uncertain|50]]')?.label).toBe('abstain');
    expect(parseRestatedPosition('...\n[[sentiment: hostile|88]]')).toEqual({ field: 'sentiment', label: 'hostile', score: 88 });
  });
  test('missing or malformed footer → null (unverified, not drift)', () => {
    expect(parseRestatedPosition('no footer here')).toBeNull();
    expect(parseRestatedPosition('[[position: maybe|50]]')).toBeNull();
    expect(parseRestatedPosition('[[sentiment: angry|50]]')).toBeNull();
    // footer must be the LAST line
    expect(parseRestatedPosition('[[position: trust|70]]\nand then more prose')).toBeNull();
  });
  test('stripRestatedFooter removes only the footer', () => {
    expect(stripRestatedFooter('Because the buffer holds.\n\n[[position: trust|72]]')).toBe('Because the buffer holds.');
    expect(stripRestatedFooter('plain')).toBe('plain');
  });
  test('judgeConsistency compares label to the record and reports the score delta', () => {
    const rec = { label: 'support', score: 72 };
    expect(judgeConsistency('council', { field: 'position', label: 'support', score: 65 }, rec)).toMatchObject({ consistent: true, scoreDelta: -7 });
    expect(judgeConsistency('council', { field: 'position', label: 'oppose', score: 60 }, rec)).toMatchObject({ consistent: false, scoreDelta: -12 });
    expect(judgeConsistency('council', null, rec)).toMatchObject({ consistent: null, scoreDelta: null });
    expect(judgeConsistency('society', { field: 'sentiment', label: 'skeptical', score: 70 }, { label: 'skeptical', score: 64 })).toMatchObject({ consistent: true, scoreDelta: 6 });
  });
});
