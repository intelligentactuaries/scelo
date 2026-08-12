import type {
  CouncilAgentResult,
  InterventionCluster,
  InterventionParam,
  RunSummary,
  Stance,
} from '../../shared/types';
import { riskKey } from '../../shared/risks';

function topRisks(results: CouncilAgentResult[], k: number): RunSummary['topRisks'] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const r of results) {
    const key = riskKey(r.keyRisk);
    if (!key) continue;
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { display: r.keyRisk, count: 1 });
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, k)
    .map((x) => ({ risk: x.display, count: x.count }));
}

export function synthesize(results: CouncilAgentResult[]): RunSummary {
  const total = results.length;
  let support = 0;
  let oppose = 0;
  let abstain = 0;
  for (const r of results) {
    if (r.finalStance === 'support') support++;
    else if (r.finalStance === 'oppose') oppose++;
    else abstain++;
  }
  const majority: Stance =
    support >= oppose && support >= abstain
      ? 'support'
      : oppose >= abstain
        ? 'oppose'
        : 'abstain';
  const majorityCount = Math.max(support, oppose, abstain);
  const consensusScore = total === 0 ? 0 : Math.round((majorityCount / total) * 100);
  const dissenting = results
    .filter((r) => r.finalStance !== majority)
    .sort((a, b) => b.finalConfidence - a.finalConfidence)
    .map((r) => r.agent.id);

  return {
    consensusScore,
    supportPct: total === 0 ? 0 : Math.round((support / total) * 100),
    opposePct: total === 0 ? 0 : Math.round((oppose / total) * 100),
    abstainPct: total === 0 ? 0 : Math.round((abstain / total) * 100),
    topRisks: topRisks(results, 8),
    dissentingAgentIds: dissenting,
    interventionClusters: clusterInterventions(results),
  };
}

function clusterInterventions(results: CouncilAgentResult[]): InterventionCluster[] {
  // Group by (param, direction, magnitude) and rank by count.
  type Key = string;
  const groups = new Map<
    Key,
    {
      param: InterventionParam;
      direction: 'increase' | 'decrease';
      magnitude: 'small' | 'large';
      agentIds: string[];
      rationales: { text: string; confidence: number }[];
    }
  >();
  for (const r of results) {
    const i = r.intervention;
    if (!i) continue;
    const k = `${i.param}|${i.direction}|${i.magnitude}`;
    if (!groups.has(k)) {
      groups.set(k, {
        param: i.param,
        direction: i.direction,
        magnitude: i.magnitude,
        agentIds: [],
        rationales: [],
      });
    }
    const g = groups.get(k)!;
    g.agentIds.push(r.agent.id);
    if (i.rationale) g.rationales.push({ text: i.rationale, confidence: r.finalConfidence });
  }
  const clusters: InterventionCluster[] = [];
  for (const g of groups.values()) {
    // Pick the highest-confidence rationale as exemplar.
    g.rationales.sort((a, b) => b.confidence - a.confidence);
    clusters.push({
      param: g.param,
      direction: g.direction,
      magnitude: g.magnitude,
      count: g.agentIds.length,
      exemplarRationale: g.rationales[0]?.text ?? '',
      agentIds: g.agentIds,
    });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}
