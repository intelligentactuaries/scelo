// Age banding, shared server↔client.
//
// The macro roll-up bands agents to report workdays lost by age; the client
// dashboard bands the same agents to chart the cohort. Two copies of the cut
// points would drift, and a chart whose bands disagree with the table beside
// it is worse than no chart — so the cuts live here and both sides import.

/** Band labels in display order. A band with no agents still belongs on an
 *  axis: an empty 65-74 is a fact about the cohort, not a reason to omit the
 *  column and silently reflow every other one. */
export const AGE_BANDS = [
  '0-14',
  '15-24',
  '25-34',
  '35-44',
  '45-54',
  '55-64',
  '65-74',
  '75+',
] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBandLabel(age: number): AgeBand {
  if (age < 15) return '0-14';
  if (age < 25) return '15-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  if (age < 65) return '55-64';
  if (age < 75) return '65-74';
  return '75+';
}
