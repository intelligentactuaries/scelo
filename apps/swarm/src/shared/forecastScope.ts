// Which scenarios the W(M,T,R) forecast can speak to.
//
// The engine simulates a community: people, and the money, time and
// relationships that carry them. A scenario without one (a fund's allocation,
// an insurer's capital decision, a reserving estimate or a pricing model's
// fit sent over from Scelo) gives deriveConfigFromScenario no cue to read, so
// it fell back to the default community and every such scenario got the same
// forecast: about 55% stabilized, 45% declined, none collapsed, over 30
// years. The council, asked whether it trusted that forecast "for this
// community", rejected it every time (100% distrust, run after run) and said
// why: "not a community", "the split reflects default priors". Those runs now
// skip the forecast and the council judges the scenario itself.
//
// Deterministic, like the config it gates: community cues are weighed against
// finance and modelling cues, because the words overlap ("City of London",
// "community bank", "urban office REIT"). The forecast runs when community
// cues outnumber the rest.

import { matchesCue } from './cues';

/** Places people live, the people themselves, and the livelihoods the engine models. */
export const COMMUNITY_CUES = [
  'community',
  'communities',
  'village*',
  'town',
  'township*',
  'city',
  'cities',
  'district*',
  'neighbourhood*',
  'neighborhood*',
  'settlement*',
  'suburb*',
  'slum*',
  'metropol*',
  'megacit*',
  'downtown',
  'rural',
  'urban',
  'household*',
  'families',
  'extended family',
  'kinship',
  'multigenerational',
  'inhabitant*',
  'resident*',
  'citizen*',
  'tribe*',
  'tribal',
  'clan*',
  'populace',
  'subsistence',
  'agrarian',
  'farming',
  'farmer*',
  'grower*',
  'pastoral*',
  'harvest*',
  'crop*',
  'livelihood*',
  'congregation*',
];

/** Subjects the engine does not model: capital, liabilities, and fitted models. */
export const NON_COMMUNITY_CUES = [
  'fund',
  'portfolio*',
  'REIT*',
  'IRR',
  'leverage*',
  'liabilit*',
  'solvency',
  'IFRS*',
  'SCR',
  'insurer*',
  'insurance',
  'reinsur*',
  'annuit*',
  'pension*',
  'IBNR',
  'reserving',
  'premium*',
  'underwrit*',
  'actuar*',
  'dividend*',
  'bond',
  'yield*',
  'valuation*',
  'equity',
  'equities',
  'investor*',
  'investment*',
  'hedg*',
  'derivative*',
  'balance sheet',
  'dataset*',
  'holdout',
  'regression',
  'GLM',
  'GBM',
  'SHAP',
];

function countCues(text: string, cues: string[]): number {
  return cues.filter((c) => matchesCue(text, [c])).length;
}

/** True when the scenario describes a community the forecast can simulate. */
export function forecastAppliesTo(scenario: string): boolean {
  const community = countCues(scenario, COMMUNITY_CUES);
  return community > 0 && community > countCues(scenario, NON_COMMUNITY_CUES);
}

/**
 * Whether a run gets the forecast. An explicit wmtrEnabled wins; otherwise the
 * scenario decides, and an intervention re-run (overrides for a forecast its
 * parent already had) keeps it.
 */
export function wantsForecast(args: {
  scenario: string;
  wmtrEnabled?: boolean;
  wmtrOverrides?: unknown;
}): boolean {
  if (args.wmtrEnabled !== undefined) return args.wmtrEnabled;
  return args.wmtrOverrides !== undefined || forecastAppliesTo(args.scenario);
}

export type VoteSubject = 'the forecast' | 'the scenario';

/** What the council's trust vote is about: the forecast when one was simulated, else the scenario as stated. */
export function subjectFor(hasForecast: boolean): VoteSubject {
  return hasForecast ? 'the forecast' : 'the scenario';
}

/** {@link subjectFor} for a run. */
export function voteSubject(run: { wmtr?: unknown }): VoteSubject {
  return subjectFor(!!run.wmtr);
}
