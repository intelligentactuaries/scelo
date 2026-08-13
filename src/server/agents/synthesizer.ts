import type {
  CouncilAgentResult,
  InterventionCluster,
  InterventionParam,
  RunSummary,
  Stance,
} from '../../shared/types';
import { clusterRisks } from '../../shared/risks';

/** How many clusters the readback lists before deferring to the council tab. */
const TOP_RISK_LIMIT = 8;

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

  // `keyRisk` means opposite things depending on the vote: a supporter names
  // what the forecast gets RIGHT, an opposer what it misses. Clustering all
  // of them together merged those two into one list — and because both groups
  // draw on the same vocabulary (on a measured run, 17 of 27 content words
  // were shared), a supporter's "captures the tenure security" landed in the
  // same cluster as an opposer's "ignores secure tenure". That is what made
  // trusting and distrusting agents look like they were reasoning
  // identically. They are counted apart now and never merged.
  const critical = results.filter((r) => r.finalStance !== 'support');
  const affirming = results.filter((r) => r.finalStance === 'support');

  const allRisks = clusterRisks(critical.map((r) => r.keyRisk));
  const topRisks = allRisks.slice(0, TOP_RISK_LIMIT);
  let riskAgentsTotal = 0;
  for (const c of allRisks) riskAgentsTotal += c.count;
  let riskAgentsShown = 0;
  for (const c of topRisks) riskAgentsShown += c.count;

  const allCaptures = clusterRisks(affirming.map((r) => r.keyRisk));
  const topCaptures = allCaptures.slice(0, TOP_RISK_LIMIT);
  let captureAgentsTotal = 0;
  for (const c of allCaptures) captureAgentsTotal += c.count;
  let captureAgentsShown = 0;
  for (const c of topCaptures) captureAgentsShown += c.count;

  return {
    consensusScore,
    supportPct: total === 0 ? 0 : Math.round((support / total) * 100),
    opposePct: total === 0 ? 0 : Math.round((oppose / total) * 100),
    abstainPct: total === 0 ? 0 : Math.round((abstain / total) * 100),
    topRisks,
    riskClusterCount: allRisks.length,
    riskAgentsShown,
    riskAgentsTotal,
    topCaptures,
    captureClusterCount: allCaptures.length,
    captureAgentsShown,
    captureAgentsTotal,
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
