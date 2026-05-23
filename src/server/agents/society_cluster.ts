import type { GraphEdge, SocietyAgentResult } from '../../shared/types';

const INCOME_INDEX: Record<string, number> = {
  low: 0,
  'lower-mid': 0.25,
  mid: 0.5,
  'upper-mid': 0.75,
  high: 1,
};
const EDU_INDEX: Record<string, number> = {
  primary: 0,
  secondary: 0.33,
  tertiary: 0.66,
  postgrad: 1,
};
const REGION_INDEX: Record<string, number> = { urban: 0, periurban: 0.5, rural: 1 };
const EMP_INDEX: Record<string, number> = {
  employed: 0.2,
  'self-employed': 0.4,
  informal: 0.6,
  unemployed: 0.8,
  student: 0.1,
  retired: 0.9,
};

function vectorOf(r: SocietyAgentResult): number[] {
  const a = r.agent;
  return [
    (a.age - 16) / (85 - 16),
    INCOME_INDEX[a.incomeBand] ?? 0.5,
    EDU_INDEX[a.education] ?? 0.5,
    REGION_INDEX[a.region] ?? 0.5,
    a.riskTolerance,
    a.financialLiteracy,
    EMP_INDEX[a.employment] ?? 0.5,
  ];
}

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface KMeansResult {
  assignments: number[]; // index into clusters per agent
  centroids: number[][];
}

export function kmeans(vectors: number[][], k: number, opts: { maxIter?: number; seed?: number } = {}): KMeansResult {
  const maxIter = opts.maxIter ?? 30;
  const rng = mulberry32(opts.seed ?? 0x5EED);
  if (vectors.length === 0) return { assignments: [], centroids: [] };
  const n = vectors.length;
  const dim = vectors[0].length;

  // k-means++ init
  const centroids: number[][] = [];
  centroids.push(vectors[Math.floor(rng() * n)].slice());
  while (centroids.length < k) {
    const dists = vectors.map((v) => {
      let best = Infinity;
      for (const c of centroids) {
        const d = dist2(v, c);
        if (d < best) best = d;
      }
      return best;
    });
    const total = dists.reduce((s, x) => s + x, 0) || 1;
    const r = rng() * total;
    let acc = 0;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      acc += dists[i];
      if (acc >= r) {
        chosen = i;
        break;
      }
    }
    centroids.push(vectors[chosen].slice());
  }

  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = dist2(vectors[i], centroids[0]);
      for (let c = 1; c < k; c++) {
        const d = dist2(vectors[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        moved++;
      }
    }
    // recompute
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += vectors[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
    if (moved === 0) break;
  }
  return { assignments, centroids };
}

export interface ClusterResult {
  results: SocietyAgentResult[];
  centroids: number[][];
  edges: GraphEdge[];
  vectors: number[][];
}

export function clusterSociety(
  results: SocietyAgentResult[],
  k = 6,
  opts: { edgesPerNode?: number; seed?: number } = {},
): ClusterResult {
  const vectors = results.map(vectorOf);
  const km = kmeans(vectors, k, { seed: opts.seed });
  for (let i = 0; i < results.length; i++) results[i].cluster = km.assignments[i];

  // edges: for each agent, top-N nearest WITHIN cluster
  const perNode = opts.edgesPerNode ?? 2;
  const byCluster = new Map<number, number[]>();
  for (let i = 0; i < results.length; i++) {
    const c = km.assignments[i];
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c)!.push(i);
  }

  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const [, members] of byCluster) {
    for (const i of members) {
      const candidates: { j: number; d: number }[] = [];
      for (const j of members) {
        if (i === j) continue;
        candidates.push({ j, d: dist2(vectors[i], vectors[j]) });
      }
      candidates.sort((a, b) => a.d - b.d);
      for (const c of candidates.slice(0, perNode)) {
        const a = results[i].agent.id;
        const b = results[c.j].agent.id;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: a, target: b, value: 1 - Math.min(1, c.d) });
      }
    }
  }

  return { results, centroids: km.centroids, edges, vectors };
}

export function describeCluster(results: SocietyAgentResult[], cluster: number): string {
  const members = results.filter((r) => r.cluster === cluster);
  if (!members.length) return `cluster ${cluster}: empty`;
  const avgAge = Math.round(members.reduce((s, m) => s + m.agent.age, 0) / members.length);
  const counts = (key: 'incomeBand' | 'education' | 'region' | 'employment') => {
    const c = new Map<string, number>();
    for (const m of members) {
      const v = m.agent[key] as string;
      c.set(v, (c.get(v) ?? 0) + 1);
    }
    const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : '?';
  };
  return `age≈${avgAge} · ${counts('incomeBand')} · ${counts('education')} · ${counts('region')} · ${counts('employment')}`;
}
