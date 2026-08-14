// One-line summaries per surface, for the rail's resting and selected states.
//
// Every line is read off the run that is actually loaded. Nothing here
// invents copy: the forecast lines come from `panelInsight`, the same text
// the expanded panels show, so the summary and the panel it opens can never
// tell different stories. Where a surface has not produced anything yet the
// line says so rather than filling the slot with a placeholder — an empty
// state is information.

import type { Run } from '../../shared/types';
import { clusterRisks } from '../../shared/risks';
import {
  explainComponents,
  explainDriverBridge,
  explainOutcomeGauge,
} from './panelInsight';
import type { TabId } from '../components/ViewTabs';

/** First sentence only — the panels carry the full paragraph. */
function lead(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const stop = t.search(/[.;](\s|$)/);
  return stop > 0 ? t.slice(0, stop) : t;
}

function pct(n: number | undefined): string {
  return `${Math.round(n ?? 0)}%`;
}

export function summariesFor(
  tab: TabId,
  run: Run | null,
  extras: { canonWorks?: number; simRows?: number; simDone?: boolean; busy?: boolean } = {},
): string[] {
  const s = run?.summary;
  const w = run?.wmtr;

  switch (tab) {
    case 'forecast':
      if (!run || !w) return [extras.busy ? 'forecast running…' : 'no forecast yet'];
      return [
        lead(explainOutcomeGauge(w, run.scenario)),
        lead(explainDriverBridge(w, run.scenario)),
        lead(explainComponents(w, run.scenario)),
      ];

    case 'council': {
      if (!run || !s) return [extras.busy ? 'the council is deliberating…' : 'council has not reported'];
      const top = clusterRisks(run.councilResults.map((r) => r.keyRisk))[0];
      return [
        `${pct(s.supportPct)} trust the forecast · ${run.councilResults.length} agents`,
        `${s.dissentingAgentIds.length} dissent from the majority`,
        top ? `most-cited risk: ${top.risk} (${top.count})` : 'no risks stated',
      ];
    }

    case 'society': {
      const soc = run?.societySummary;
      if (!soc) return [extras.busy ? 'the society reacts once the council finishes…' : 'society has not reacted'];
      const warm =
        (soc.sentimentMix.enthusiastic ?? 0) + (soc.sentimentMix.supportive ?? 0);
      return [
        `${pct((warm / Math.max(1, soc.size)) * 100)} broadly accept · ${soc.size} sampled`,
        `average intensity ${Math.round(soc.averageIntensity)}`,
        `${soc.clusters.length} distinct clusters`,
      ];
    }

    case 'synthesis': {
      if (!s) return [extras.busy ? 'readback lands when the run completes…' : 'no readback yet'];
      const hidden = Math.max(0, (s.riskClusterCount ?? s.topRisks.length) - s.topRisks.length);
      return [
        `consensus ${s.consensusScore}/100`,
        `${s.topRisks.length} risk clusters shown${hidden > 0 ? ` · ${hidden} more` : ''}`,
        `${s.dissentingAgentIds.length} dissenters, by confidence`,
      ];
    }

    case 'simulation':
      if (!extras.simDone) return ['no simulation run yet'];
      return [
        `${extras.simRows ?? 0} agents simulated`,
        'macro impact scaled to the population',
        'per-agent dataset ready for Soft Data',
      ];

    case 'canon':
      return [
        extras.canonWorks
          ? `${extras.canonWorks} works in the corpus`
          : 'no works in the corpus yet',
        'cited verbatim into every agent prompt',
        'add, import or prune the context',
      ];

    default:
      return [];
  }
}
