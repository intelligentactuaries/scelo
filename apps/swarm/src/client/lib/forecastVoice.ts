// Plain-language vocabulary for explaining a W(M,T,R) forecast.
//
// The simulator is domain-agnostic: it projects three capitals forward under
// random shocks. What changes per scenario is what M, T and R *mean to the
// reader*. A solvency question narrated in terms of "money, time and
// relationships" reads as though the model wasn't listening; the same numbers
// described as "capital, time to run off the book, and the support around it"
// read as an answer to the question that was actually asked.
//
// This is a presentation layer only — it never changes a number, just the
// words wrapped around it. A wrong guess costs slightly generic phrasing, not
// a wrong result, which is why a cue heuristic is acceptable here (unlike the
// simulator config, where the same heuristic decides the shock environment).

import { matchesCue } from '../../shared/cues';

export interface ForecastVoice {
  /** What the simulated quantity is, in this scenario's terms. */
  subject: string;
  /** What M / T / R mean here, in words a non-modeller would use. */
  M: string;
  T: string;
  R: string;
  /** What "a shock" is in this domain — plural, lower case. */
  setbacks: string;
}

const GENERIC: ForecastVoice = {
  subject: 'the overall position',
  M: 'the money and assets behind it',
  T: 'the time and effort available',
  R: 'the relationships and support around it',
  setbacks: 'setbacks',
};

// Ordered: the first match wins, so the most specific domains come first.
const VOICES: { cues: string[]; voice: ForecastVoice }[] = [
  {
    // Pension-SPECIFIC cues only. "annuity", "longevity" and "retiree" are
    // shared vocabulary — a life insurer buying an annuity book uses all
    // three — so keying the scheme voice on them mislabels insurer scenarios
    // as pension schemes. A real scheme scenario names the scheme.
    cues: ['pension', 'scheme', 'sponsor', 'covenant', 'trustee', 'db plan'],
    voice: {
      subject: "the scheme's funding position",
      M: 'the assets held against the liabilities',
      T: 'how long the liabilities take to run off',
      R: 'sponsor covenant and member confidence',
      setbacks: 'longevity, rate and covenant shocks',
    },
  },
  {
    cues: [
      'insurer',
      'insurance',
      'solvency',
      'reserv*',
      'underwrit*',
      'premium',
      'ifrs 17',
      'csm',
      'reinsur*',
      'claim',
      'annuity',
      'longevity',
    ],
    voice: {
      subject: "the book's financial position",
      M: 'capital and reserves',
      T: 'time left to earn the risk out',
      R: 'reinsurance, distribution and regulator confidence',
      setbacks: 'claims, market and regulatory shocks',
    },
  },
  {
    cues: ['virus', 'pandemic', 'epidemic', 'infection', 'vaccine', 'antiviral', 'clinic', 'hospital'],
    voice: {
      subject: "the population's wellbeing",
      M: 'income and material resources',
      T: 'healthy, productive time',
      R: 'family, community and access to care',
      setbacks: 'outbreaks and health shocks',
    },
  },
  {
    cues: ['village', 'rural', 'subsistence', 'agrarian', 'farming', 'household', 'community'],
    voice: {
      subject: "the community's standing",
      M: 'land, livestock and savings',
      T: 'working time available',
      R: 'family, faith and neighbourhood ties',
      setbacks: 'droughts, downturns and disruptions',
    },
  },
];

/** Pick the vocabulary that best fits a scenario. Falls back to plain terms. */
export function voiceFor(scenario: string): ForecastVoice {
  for (const { cues, voice } of VOICES) {
    if (matchesCue(scenario, cues)) return voice;
  }
  return GENERIC;
}
