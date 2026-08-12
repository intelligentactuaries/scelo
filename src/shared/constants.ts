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
// Mirrored from --bg / --fg / etc in src/client/styles.css for BOTH the
// light and dark palettes — chart components call `colorsForTheme(resolved)`
// and pass the result into ECharts options so axis labels, tooltips, and
// stroked elements all flip on a theme switch.
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeColors {
  bg: string;
  bg2: string;
  fg: string;
  fgMute: string;
  muted: string;
  grid: string;
  border: string;
  consensus: string;
  dissent: string;
  adversarial: string;
  accent: string;
  // WMTR components chart — categorical trio for M / T / R lines. Keep the
  // M, T, R assignment fixed, never cycled.
  //
  // These must stay clear of OUTCOME_COLOR (shared/wmtr.ts), which is a
  // RESERVED status ramp: grew=green, stabilized=blue, declined=amber,
  // collapsed=red. The forecast canvas puts the components chart directly
  // beside the outcome distribution, so a component line sharing a hue
  // family with an outcome bar reads as the same encoding — the trio used
  // to be blue/amber/green against that exact ramp, which collided on all
  // three (worst cross pair dE 7.2 dark, 9.6 light — under the dE 15
  // normal-vision floor at which readers can still tell two colors apart).
  //
  // The replacement trio is olive / steel / plum-rose: hue-clear of the
  // ramp, and spanning the blue-yellow axis that CVD preserves (a
  // teal/violet/rose set reads as more distinct to normal vision but
  // collapses to dE 1.4-5.6 under protan/deuteranopia).
  //
  // Validated per mode against that mode's surface with the categorical
  // six checks, all-pairs:
  //   light  worst adjacent CVD dE 9.4 · normal 17.5 · vs status ramp 17.5
  //   dark   worst adjacent CVD dE 9.3 · normal 18.2 · vs status ramp 15.5
  // Re-run the check before touching these, and re-check both against
  // OUTCOME_COLOR — the two palettes are only safe as a pair.
  chartM: string;
  chartT: string;
  chartR: string;
  // Society sentiment diverging scale — poles reuse consensus/dissent/
  // adversarial; these two fill the in-between steps. Validated CVD-safe
  // in scale order (enthusiastic, supportive, neutral, skeptical, hostile)
  // against each mode's surface. The neutral midpoint is deliberately
  // low-chroma (diverging scales take a gray midpoint).
  sentSupportive: string;
  sentNeutral: string;
  // Tooltip styling — ECharts inlines these on the tooltip element.
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
}

const LIGHT: ThemeColors = {
  bg: '#E8E4D8',
  bg2: '#F2EEE2',
  fg: '#181715',
  fgMute: '#5E5A52',
  muted: '#8C8476',
  grid: 'rgba(24, 23, 21, 0.10)',
  border: '#CDC7B8',
  consensus: '#309061',
  dissent: '#C87D32',
  adversarial: '#B73A3A',
  accent: '#309061',
  chartM: '#06658E', // steel   L 0.48 C 0.10 H 235
  chartT: '#6C6610', // olive   L 0.50 C 0.10 H 105
  chartR: '#7C3855', // plum    L 0.44 C 0.10 H 355
  sentSupportive: '#6BC393',
  sentNeutral: '#5E5A52',
  tooltipBg: 'rgba(242, 238, 226, 0.95)',
  tooltipBorder: '#CDC7B8',
  tooltipText: '#181715',
};

const DARK: ThemeColors = {
  bg: '#1B1815',
  bg2: '#221E1A',
  fg: '#F1ECDF',
  fgMute: '#AAA294',
  muted: '#746C60',
  grid: 'rgba(241, 236, 223, 0.12)',
  border: '#423A31',
  consensus: '#82D7AF',
  dissent: '#EBB46E',
  adversarial: '#E66E6E',
  accent: '#82D7AF',
  chartM: '#186E97', // steel   L 0.51 C 0.10 H 235
  chartT: '#6F6915', // olive   L 0.51 C 0.10 H 105
  chartR: '#CE7499', // rose    L 0.67 C 0.12 H 355
  sentSupportive: '#3F9976',
  sentNeutral: '#6A6357',
  tooltipBg: 'rgba(34, 30, 26, 0.95)',
  tooltipBorder: '#423A31',
  tooltipText: '#F1ECDF',
};

export function colorsForTheme(theme: ResolvedTheme): ThemeColors {
  return theme === 'dark' ? DARK : LIGHT;
}

/** Back-compat shim. Defaults to light. New code should call
 *  `colorsForTheme(resolved)` from `useTheme().resolved`. */
export const COLORS: ThemeColors = LIGHT;

export const PROFESSION_PALETTE: Record<Profession, string> = {
  Finance: '#4a9eff',
  Investor: '#00ff9d',
  Accountant: '#22d3ee',
  Actuary: '#b388ff',
  Psychologist: '#ffb000',
  ConspiracyTheorist: '#ff3b3b',
  Lawyer: '#a3e635',
  SocialMediaInfluencer: '#f472b6',
};

/** Light-theme profession hues. The dark palette above is neon-bright and
 *  washes out on the cream surface (same failure the society cluster palette
 *  fixed with its light overrides). Same hue identities, darkened; validated
 *  CVD-safe adjacent-pairwise in PROFESSIONS order on #E8E4D8 — worst pair
 *  deutan ΔE 12.7, normal ≥15.4. Always pick via professionColor(). */
export const PROFESSION_PALETTE_LIGHT: Record<Profession, string> = {
  Finance: '#274F9E',
  Investor: '#0A8A57',
  Accountant: '#2596BE',
  Actuary: '#7A52D6',
  Psychologist: '#C4860A',
  ConspiracyTheorist: '#992121',
  Lawyer: '#7E8C00',
  SocialMediaInfluencer: '#C74E90',
};

export function professionColor(p: Profession, dark: boolean): string {
  return (dark ? PROFESSION_PALETTE : PROFESSION_PALETTE_LIGHT)[p];
}
