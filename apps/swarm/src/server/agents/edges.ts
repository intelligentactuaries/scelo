import type { CouncilAgentResult, GraphEdge } from '../../shared/types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'from', 'into', 'about', 'over',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'they', 'them', 'their',
  'my', 'our', 'your', 'his', 'her', 'has', 'have', 'had', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'cannot', 'not', 'no',
  'so', 'if', 'than', 'then', 'because', 'while', 'also', 'just', 'very', 'more', 'most',
  'some', 'any', 'all', 'such', 'only', 'own', 'same', 'too', 'each', 'other', 'which',
  'who', 'what', 'when', 'where', 'why', 'how', 'one', 'two', 'three', 'four', 'five',
  'round', 'view', 'confidence', 'agent', 'peer', 'peers', 'response', 'scenario',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = text.toLowerCase().replace(/confidence\s*[:=]\s*\d+/gi, ' ');
  for (const raw of cleaned.split(/[^a-z0-9]+/)) {
    const t = raw.trim();
    if (t.length < 4) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface EdgeOpts {
  perNode?: number;        // top-K kept per node (default 4)
  threshold?: number;      // minimum combined score to keep (default 0.18)
  stanceWeight?: number;   // how strongly stance-match dominates (default 0.5)
}

export function computeCouncilEdges(
  results: CouncilAgentResult[],
  opts: EdgeOpts = {},
): GraphEdge[] {
  const perNode = opts.perNode ?? 4;
  const threshold = opts.threshold ?? 0.18;
  const stanceWeight = opts.stanceWeight ?? 0.5;
  if (results.length < 2) return [];

  const tokens = results.map((r) => tokenize(r.rounds[1]?.content ?? ''));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  for (let i = 0; i < results.length; i++) {
    const candidates: { j: number; score: number }[] = [];
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      const stanceMatch = results[i].finalStance === results[j].finalStance ? 1 : 0;
      const tokSim = jaccard(tokens[i], tokens[j]);
      const score = stanceWeight * stanceMatch + (1 - stanceWeight) * tokSim;
      if (score >= threshold) candidates.push({ j, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, perNode)) {
      const a = results[i].agent.id;
      const b = results[c.j].agent.id;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ source: a, target: b, value: Math.round(c.score * 1000) / 1000 });
    }
  }
  return edges;
}
