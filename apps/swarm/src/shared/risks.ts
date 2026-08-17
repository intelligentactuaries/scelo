// Clustering for council agents' stated key risks.
//
// Two agents rarely phrase the same worry identically, so counting raw
// strings reports every risk as "cited once".
//
// The first attempt normalised each risk to its first six significant words
// and grouped on that. It barely clustered: agents vary their WORDING, not
// their opening. On a real 32-agent run it produced 30 clusters, 28 of them
// size 1 —
//
//   "ignores ESG constraints"
//   "ignores ESG factors' impact on nominal rates and costs"
//   "ignores ESG positive impact"
//   "ignores ESG impact and underweights market dynamics"
//
// — four keys for one risk, because a prefix match can only ever collapse
// agents who happened to start the same way.
//
// So: compare CONTENT WORDS instead. Two risks join when their token sets
// overlap by at least half of the smaller set, which is the right measure
// for short phrases (Jaccard punishes a long phrasing for being long: the
// first and second lines above score 0.25 under Jaccard and 0.5 under
// overlap). Generic analysis nouns are dropped first so nothing merges on
// "impact" or "risk" alone.
//
// Shared because it is used on both sides of the wire: the server builds
// `summary.topRisks` with it and the client re-clusters the same field per
// stance to explain a verdict. Two implementations would drift, and a
// stance explanation that groups risks differently from the summary beside
// it is worse than no explanation.

/** Words that carry no discriminating signal in a risk statement. Function
 *  words, plus the analysis nouns that appear in nearly every phrasing —
 *  without dropping these, "ignores ESG impact" and "ignores religion
 *  impact" would merge on the strength of "impact" alone. */
const STOP = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'could', 'do', 'does', 'for', 'from', 'has', 'have', 'if', 'in', 'into',
  'is', 'it', 'its', 'may', 'might', 'not', 'of', 'on', 'or', 'over', 's',
  'should', 'that', 'the', 'their', 'them', 'there', 'these', 'this', 'to',
  'too', 'under', 'up', 'was', 'we', 'were', 'which', 'while', 'will',
  'with', 'would',
  // generic to this domain — true of almost every stated risk
  'assumption', 'assumptions', 'case', 'cases', 'effect', 'effects',
  'factor', 'factors', 'forecast', 'forecasts', 'impact', 'impacts',
  'issue', 'issues', 'model', 'models', 'outcome', 'outcomes', 'risk',
  'risks', 'scenario', 'scenarios',
  // the prompt's own verb template. Agents answer "what does the forecast
  // get wrong?", so nearly every reply opens with one of these — on a real
  // run "ignores" appeared in 31 of 32 risks. Left in, it is a token every
  // risk shares, and everything collapses into whichever cluster happens to
  // be seeded first.
  'discounts', 'fails', 'ignores', 'ignoring', 'misses', 'missing',
  'neglects', 'omits', 'overlooks', 'overstates', 'underestimated',
  'underestimates', 'understates', 'underweights',
]);

/** Overlap needed to call two risks the same worry: half the smaller set. */
const MERGE_THRESHOLD = 0.5;

/** Failure markers the council runner writes when an agent's round-3 call
 *  dies. They are plumbing, not a risk the council raised, and counting them
 *  put "(error)" in the readback as though it were a substantive finding. */
const NON_RISK = new Set(['error', 'parse failed', 'none', 'n/a', 'na', 'unknown']);

/** Content words of a risk statement, lowercased and de-duplicated. */
export function riskTokens(risk: string | undefined | null): Set<string> {
  const words = (risk || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return new Set(words);
}

/** True when a stated risk is a real risk rather than a failure marker. */
export function isStatedRisk(risk: string | undefined | null): boolean {
  const t = (risk || '').trim().toLowerCase().replace(/^[("']+|[)"'.]+$/g, '');
  if (!t) return false;
  if (NON_RISK.has(t)) return false;
  return riskTokens(risk).size > 0;
}

/** |A ∩ B| / min(|A|, |B|) — the overlap coefficient. */
function overlap(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const w of smaller) if (larger.has(w)) shared++;
  return shared / smaller.size;
}

export interface RiskCluster {
  /** The phrasing shown to the user: the most-cited wording in the cluster,
   *  shortest wins a tie (it reads best in a list). */
  risk: string;
  /** Agents whose stated risk landed in this cluster. */
  count: number;
}

/**
 * Group stated risks into clusters, most-cited first.
 *
 * Greedy single-pass agglomeration against each cluster's accumulated token
 * set: order-dependent in principle, stable in practice because the caller
 * always feeds results in council order. Failure markers are dropped.
 */
export function clusterRisks(risks: Array<string | undefined | null>): RiskCluster[] {
  const clusters: Array<{ tokens: Set<string>; phrasings: Map<string, number> }> = [];

  for (const raw of risks) {
    if (!isStatedRisk(raw)) continue;
    const text = (raw as string).trim();
    const tokens = riskTokens(text);

    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const score = overlap(tokens, clusters[i].tokens);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best >= 0 && bestScore >= MERGE_THRESHOLD) {
      // Matched against the SEED's tokens, and the seed is not widened with
      // the joiner's words. Widening looked like it would help chained
      // phrasings find each other; what it actually did was turn the first
      // cluster into a magnet — every extra token made the next risk easier
      // to absorb, so a 32-agent run about ESG collapsed into one cluster
      // labelled "ignores religion buffer". Under-merging is recoverable
      // (the count is still right, the panel just lists two lines); a magnet
      // silently mislabels the council's dominant concern.
      clusters[best].phrasings.set(text, (clusters[best].phrasings.get(text) ?? 0) + 1);
    } else {
      clusters.push({ tokens, phrasings: new Map([[text, 1]]) });
    }
  }

  return clusters
    .map((c) => {
      let risk = '';
      let bestN = -1;
      for (const [text, n] of c.phrasings) {
        if (n > bestN || (n === bestN && text.length < risk.length)) {
          risk = text;
          bestN = n;
        }
      }
      let count = 0;
      for (const n of c.phrasings.values()) count += n;
      return { risk, count };
    })
    .sort((a, b) => b.count - a.count || a.risk.localeCompare(b.risk));
}
