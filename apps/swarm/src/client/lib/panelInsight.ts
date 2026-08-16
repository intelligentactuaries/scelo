// Contextual readings of the four forecast panels, for the person the
// forecast is *for* rather than the person who built it.
//
// Each function answers "what does this plot say about THIS run" — not what
// the chart type is. They are computed from the run's own numbers rather than
// written by a model, for the same reasons the stance explanation is: a hover
// has to be there the instant the pointer arrives, and a description invented
// after the fact can confidently describe a shape the chart does not have.
//
// Vocabulary comes from `forecastVoice`, so the three capitals are named in
// the scenario's own terms — "the assets held against the liabilities" rather
// than "M". The modelling words the panels are built on (log points,
// Cobb-Douglas, elasticities, paths, W) answer a question nobody reading a
// forecast asked, so they are kept out; the numbers stay.
//
// Everything here is read-only over the payload the canvas already holds, so
// no request, no cache, and it works on runs simulated before these existed.

import type { RunWmtr } from '../../shared/types';
import { driverContributions, type Outcome } from '../../shared/wmtr';
import { outcomeMixByYear } from '../components/WmtrStrip';
import { voiceFor } from './forecastVoice';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A log contribution as the plain percentage effect it had. */
const asPct = (logPoints: number) => Math.round(Math.abs(Math.exp(logPoints) - 1) * 100);

/** How each ending would be described to someone reading the scenario. */
const PLAIN: Record<Outcome, string> = {
  grew: 'clearly better off',
  stabilized: 'about where it started',
  declined: 'worse off',
  collapsed: 'in collapse',
};

/** "What moved W" — which lever carried the move, in the scenario's terms. */
export function explainDriverBridge(w: RunWmtr, scenario: string): string {
  const v = voiceFor(scenario);
  const c = driverContributions(w.result);
  const parts = [
    { name: v.M, v: c.M },
    { name: v.T, v: c.T },
    { name: v.R, v: c.R },
  ];
  const ranked = [...parts].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const helped = c.net >= 0;
  // A component pulling against the overall move is the more useful thing to
  // say about it than its rank — it is what is currently holding the line.
  const against = parts.filter((p) => p.v !== 0 && Math.sign(p.v) !== Math.sign(c.net));
  const withMove = ranked.filter((p) => !against.includes(p));

  return [
    `Over ${w.config.horizon} years ${v.subject} ended up about ${asPct(c.net)}% ${helped ? 'higher' : 'lower'} than it started.`,
    `Most of that came from ${ranked[0].name} — on its own it moved things about ${asPct(ranked[0].v)}% ${ranked[0].v >= 0 ? 'up' : 'down'}.`,
    withMove.length > 1
      ? `${cap(withMove[1].name)} ${withMove[1].v >= 0 ? 'added' : 'took away'} roughly ${asPct(withMove[1].v)}% more.`
      : '',
    against.length
      ? `${cap(against.map((a) => a.name).join(' and '))} pushed the other way and cushioned the ${helped ? 'gain' : 'fall'}.`
      : 'All three pushed the same way.',
    `Together these three account for the whole change — nothing else is at work. The longest bar is where a change would do the most.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** "W(M,T,R) components" — the three things being tracked, and how each moved. */
export function explainComponents(w: RunWmtr, scenario: string): string {
  const v = voiceFor(scenario);
  const r = w.result;
  const last = r.years.length - 1;
  const move = (a: number[], name: string) => {
    const from = a[0] ?? 0;
    const to = a[last] ?? 0;
    if (from <= 0) return `${name} barely moved`;
    const chg = Math.round((to / from - 1) * 100);
    if (chg === 0) return `${name} barely moved`;
    return `${name} ${chg > 0 ? 'up' : 'down'} ${Math.abs(chg)}%`;
  };
  return [
    `The three things the forecast tracks, averaged over ${w.config.nPaths} runs of this scenario:`,
    `${cap(move(r.meanM, v.M))}, ${move(r.meanT, v.T)}, and ${move(r.meanR, v.R)}.`,
    'These are measured on different scales, so compare how far each line moved rather than which one sits highest.',
    'The panel next to this one turns those movements into a like-for-like comparison.',
  ].join(' ');
}

/** "Outcome distribution" — where the runs ended up. */
export function explainOutcomeGauge(w: RunWmtr, scenario: string): string {
  const v = voiceFor(scenario);
  const f = w.result.outcomeFractions;
  const n = w.config.nPaths;
  const ranked = (Object.entries(f) as [Outcome, number][])
    .filter(([, x]) => x > 0)
    .sort((a, b) => b[1] - a[1]);
  const [top, runner] = ranked;
  const gap = runner ? (top[1] - runner[1]) * 100 : 100;

  return [
    `We played this scenario out ${n} times.`,
    `In ${Math.round(top[1] * n)} of them (${pct(top[1])}), ${v.subject} ended up ${PLAIN[top[0]]}.`,
    runner
      ? `The next most common ending was ${PLAIN[runner[0]]}, in ${pct(runner[1])}.${
          gap <= 10
            ? ' Those two are close enough that a different roll of the dice could swap them — treat the headline as "could go either way".'
            : ''
        }`
      : 'No other ending happened at all.',
    'The biggest group is always the outer ring. Click a ring to see which council members disagreed with that ending.',
  ].join(' ');
}

/** "Outcome mix over time" — when it turned. */
export function explainOutcomeMix(w: RunWmtr, scenario: string): string {
  const v = voiceFor(scenario);
  const r = w.result;
  const mix = outcomeMixByYear(r);
  const last = r.years.length - 1;
  const healthy = (i: number) => (mix.grew[i] ?? 0) + (mix.stabilized[i] ?? 0);

  // The year the healthy share passes below half is the readable answer to
  // "when did this turn", and it is what the final result cannot show.
  let crossed = -1;
  for (let i = 0; i <= last; i++) {
    if (healthy(i) < 0.5) {
      crossed = i;
      break;
    }
  }
  const firstCollapse = mix.collapsed.findIndex((x) => x > 0);

  return [
    `Every run starts in the same place, then they fan out as ${v.setbacks} land differently in each one.`,
    `By year ${r.years[last]}, ${pct(healthy(last))} of runs still had ${v.subject} holding up or better.`,
    crossed > 0
      ? `The turning point was year ${r.years[crossed]} — that is when more than half had slipped.`
      : crossed === 0
        ? 'More than half had already slipped at the start.'
        : 'More than half were still holding up the whole way through.',
    firstCollapse > 0
      ? `The first run to fall past the point of no return did so at year ${r.years[firstCollapse]}.`
      : 'No run ever fell past the point of no return.',
    'This is the same split as the panel beside it, shown at every year instead of only at the end.',
  ].join(' ');
}
