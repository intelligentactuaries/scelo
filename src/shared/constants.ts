export const MBTI_TYPES = [
  'INTJ', 'INTP', 'ENTJ', 'ENTP',
  'INFJ', 'INFP', 'ENFJ', 'ENFP',
  'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
  'ISTP', 'ISFP', 'ESTP', 'ESFP',
] as const;

export type MBTIType = typeof MBTI_TYPES[number];

export const MBTI_SUMMARIES: Record<MBTIType, string> = {
  INTJ: 'strategic long-horizon systems thinker; decisive once a model converges',
  INTP: 'analytical first-principles reasoner; probes assumptions before conclusions',
  ENTJ: 'directive executor; optimises for outcomes and accountability',
  ENTP: 'lateral generator of alternatives; stress-tests by challenge',
  INFJ: 'pattern-reader of human systems; weighs second-order social effects',
  INFP: 'values-anchored evaluator; flags ethical and stakeholder dissonance',
  ENFJ: 'coalition-builder; reads how a decision will be received and lived with',
  ENFP: 'opportunity scout; surfaces upside and unconventional framings',
  ISTJ: 'rule-of-record auditor; insists on precedent, documentation, compliance',
  ISFJ: 'continuity guardian; protects existing commitments and obligations',
  ESTJ: 'operational realist; insists on execution detail and chain of command',
  ESFJ: 'consensus harmoniser; weighs morale, trust, and team coherence',
  ISTP: 'pragmatic mechanic; reasons from how the thing actually breaks',
  ISFP: 'situational craftsperson; weighs lived consequences over abstractions',
  ESTP: 'action-biased opportunist; weights speed and concrete payoff',
  ESFP: 'in-the-room realist; weighs immediate human reaction and signal',
};

export const PROFESSIONS = [
  'Finance',
  'Investor',
  'Accountant',
  'Actuary',
  'Psychologist',
  'ConspiracyTheorist',
  'Lawyer',
  'SocialMediaInfluencer',
] as const;

export type Profession = typeof PROFESSIONS[number];

export const GENDERS = ['F', 'M'] as const;
export type Gender = typeof GENDERS[number];

export const COUNCIL_SIZE = PROFESSIONS.length * MBTI_TYPES.length * GENDERS.length; // 256
export const SOCIETY_SIZE = 1000;

export const LEGAL_JURISDICTIONS = ['ZA', 'US', 'UK', 'EU'] as const;
export type LegalJurisdiction = typeof LEGAL_JURISDICTIONS[number];
export const DEFAULT_LEGAL_JURISDICTION: LegalJurisdiction = 'ZA';

// Hex constants used inside ECharts options (which can't resolve CSS vars).
// Must stay in sync with the --bg/--fg/etc tokens in src/client/styles.css.
export const COLORS = {
  bg: '#ffffff',
  bg2: '#fafafa',
  fg: '#111111',
  muted: '#888888',
  grid: '#ececec',
  border: '#d0d0d0',
  consensus: '#2ea36b',
  dissent: '#c47a00',
  adversarial: '#d23a3a',
  accent: '#d23a3a',
} as const;

export const PROFESSION_PALETTE: Record<Profession, string> = {
  Finance: '#4a9eff',
  Investor: '#00ff9d',
  Accountant: '#e4e4e4',
  Actuary: '#b388ff',
  Psychologist: '#ffb000',
  ConspiracyTheorist: '#ff3b3b',
  Lawyer: '#c084fc',
  SocialMediaInfluencer: '#f472b6',
};
