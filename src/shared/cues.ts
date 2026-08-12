// Word-bounded cue matching over free-text scenarios.
//
// Shared because two surfaces read the same scenario text and must agree:
// the server derives the simulator config from it, and the client picks the
// vocabulary it explains the result in. A second copy would let the two drift
// — the forecast could be configured as a pandemic and narrated as a pension.
//
// Matching is WORD-BOUNDED, not substring. A plain `includes()` fired a cue on
// any accidental letter sequence: "software", "warranty", "award" and
// "forward" all contain `war`; "normalising" contains `normal`. That made the
// simulation a function of spelling coincidences rather than of what the
// scenario actually says.
//
// A plain cue matches a whole word plus an optional plural "s"; a cue ending
// in "*" is a stem and matches any continuation, which is how "catastroph*"
// still covers catastrophe/catastrophic.

const CUE_RE = new Map<string, RegExp>();

function cueMatcher(cue: string): RegExp {
  let re = CUE_RE.get(cue);
  if (!re) {
    const stem = cue.endsWith('*');
    const body = (stem ? cue.slice(0, -1) : cue).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(stem ? `\\b${body}` : `\\b${body}s?\\b`, 'i');
    CUE_RE.set(cue, re);
  }
  return re;
}

/** True when any cue matches the text at a word boundary. */
export function matchesCue(text: string, cues: string[]): boolean {
  // Underscores are word characters to a regex, so `\binsurance\b` does NOT
  // match inside `group_insurance_data` — and scenarios synthesised from a
  // Scelo result quote dataset filenames verbatim, where snake_case is the
  // norm. Treat `_` as a separator so an identifier reads as the words it is
  // made of.
  const normalised = text.replace(/_/g, ' ');
  return cues.some((c) => cueMatcher(c).test(normalised));
}
