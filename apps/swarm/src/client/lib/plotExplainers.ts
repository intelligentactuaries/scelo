// Plain-language explainers for every plot title in the app.
//
// Hovering a chart's title pops the same glass bubble the forecast panels
// use (`.explained-title` in styles.css) with a short reading of THIS run's
// picture: what the marks mean, how to read them, and the one or two numbers
// that anchor the story. Register: an actuary who writes clearly for a board
// — short sentences, everyday words, concrete figures, no jargon.
//
// Every function reads the live Run, so the numbers in the bubble are the
// numbers on the canvas — never boilerplate that could drift from the data.

import type { Run } from '../../shared/types';

const pct = (n: number | undefined) => `${Math.round(n ?? 0)}%`;

/** Council Reactions — the adviser network. */
export function explainCouncilGraph(run: Run): string {
  const n = run.councilResults.length;
  const profs = new Set(run.councilResults.map((r) => r.agent.profession)).size;
  const s = run.summary;
  const verdictLine = s
    ? ` Bottom line here: ${pct(s.opposePct)} of the council distrusts the forecast, ${pct(s.supportPct)} trusts it, ${pct(s.abstainPct)} is undecided.`
    : '';
  return (
    `Each circle is one adviser — ${n} in total, seated in ${profs} profession groups. ` +
    `A bigger circle means that adviser is more confident in their own verdict (0–100). ` +
    `The ring colour is the verdict itself: green trusts the forecast, red distrusts it, amber is undecided. ` +
    `Lines join advisers whose written reasons overlap — the thicker the line, the closer their thinking.` +
    verdictLine
  );
}

/** Council readback Sankey — profession → verdict → confidence. */
export function explainCouncilSankey(run: Run): string {
  const n = run.councilResults.length;
  const s = run.summary;
  const split = s
    ? ` Across all ${n} advisers: ${pct(s.supportPct)} trust · ${pct(s.opposePct)} distrust · ${pct(s.abstainPct)} undecided.`
    : '';
  return (
    `Read it left to right. Each profession's band flows into its verdict on the forecast (trust or distrust), ` +
    `then into how sure those advisers are (the confidence bands on the right). ` +
    `A thicker band simply means more advisers took that path — so a profession whose band splits is divided internally.` +
    split
  );
}

/** Society Pulse — the citizen scatter with cluster hulls. */
export function explainSocietyGraph(run: Run): string {
  const soc = run.societySummary;
  const size = soc?.size ?? run.societyResults.length;
  const k = soc?.clusters.length ?? 0;
  const warm = soc
    ? (soc.sentimentMix.enthusiastic ?? 0) + (soc.sentimentMix.supportive ?? 0)
    : 0;
  const warmPct = soc && soc.size > 0 ? Math.round((warm / soc.size) * 100) : 0;
  const tail = soc
    ? ` Here ${warmPct}% react warmly, and the average strength of feeling is ${Math.round(soc.averageIntensity)}/100.`
    : '';
  return (
    `Each dot is one simulated citizen — ${size} in this sample${k ? `, grouped into ${k} circles of look-alike neighbours (similar age, income, education, work)` : ''}. ` +
    `The dot's colour is their reaction to the forecast, from enthusiastic (green) through neutral (grey) to hostile (red); ` +
    `a bigger dot feels it more strongly (0–100). Hover any dot to read that person's own words.` +
    tail
  );
}

/** Society Sankey — cluster → sentiment → intensity. */
export function explainSocietySankey(run: Run): string {
  const soc = run.societySummary;
  if (!soc) {
    return (
      `Read it left to right. Each cluster of citizens flows into how they feel about the forecast, ` +
      `then into how strongly they feel it. Thicker bands = more people.`
    );
  }
  const entries = Object.entries(soc.sentimentMix).filter(([, v]) => (v ?? 0) > 0);
  entries.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const top = entries[0];
  const topLine =
    top && soc.size > 0
      ? ` The single biggest feeling is ${top[0]} — ${Math.round(((top[1] ?? 0) / soc.size) * 100)}% of the ${soc.size} sampled.`
      : '';
  return (
    `Read it left to right. Each cluster of citizens flows into how they feel about the forecast, ` +
    `then into how strongly they feel it (intensity, 0–100). Thicker bands = more people; ` +
    `average intensity across the sample is ${Math.round(soc.averageIntensity)}/100.` +
    topLine
  );
}

/** Readback — the trust half-donut. */
export function explainSynthesisTrust(run: Run): string {
  const s = run.summary;
  const n = run.councilResults.length;
  if (!s) return `The council's verdict at a glance: green trusts the forecast, red distrusts, grey is undecided.`;
  return (
    `The council's verdict at a glance: of ${n} advisers, ${pct(s.supportPct)} trust the forecast (green), ` +
    `${pct(s.opposePct)} distrust it (red) and ${pct(s.abstainPct)} are undecided (grey). ` +
    `Consensus ${s.consensusScore}/100 just means ${s.consensusScore}% sit with the majority view — ` +
    `the higher it is, the less argument there was.`
  );
}

/** Readback — the trust-by-profession table. */
export function explainSynthesisByProfession(run: Run): string {
  const by = new Map<string, { sup: number; opp: number; abs: number }>();
  for (const r of run.councilResults) {
    const c = by.get(r.agent.profession) ?? { sup: 0, opp: 0, abs: 0 };
    if (r.finalStance === 'support') c.sup++;
    else if (r.finalStance === 'oppose') c.opp++;
    else c.abs++;
    by.set(r.agent.profession, c);
  }
  let sceptic: string | null = null;
  let bestShare = -1;
  for (const [p, c] of by) {
    const total = c.sup + c.opp + c.abs;
    const share = total > 0 ? c.opp / total : 0;
    if (share > bestShare) {
      bestShare = share;
      sceptic = p;
    }
  }
  const scepticLine =
    sceptic && bestShare > 0
      ? ` The most sceptical group here is ${sceptic} (${Math.round(bestShare * 100)}% distrust).`
      : '';
  return (
    `One row per profession: how many of its advisers trust, distrust, or can't decide on the forecast. ` +
    `A row split across columns means that profession disagrees with itself — those advisers' notes are usually ` +
    `the most useful reading.` +
    scepticLine
  );
}
