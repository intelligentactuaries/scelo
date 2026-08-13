import { router } from '../llm/router';
import { runCouncil } from './council';
import { synthesize } from './synthesizer';
import type { CouncilAgentResult } from '../../shared/types';

const SCENARIO = `A South African pension fund is considering allocating 8% of its portfolio
to a single emerging-markets infrastructure REIT focused on toll roads across
sub-Saharan Africa. The REIT has a 14% historical IRR but only a 4-year track
record, leverage of 2.1x, and 60% of its revenue is dollar-denominated against
rand-denominated liabilities. The fund must hold the position for 7 years (lock-up).`;

const args = process.argv.slice(2);
const subsetArg = args.find((a) => a.startsWith('--subset='));
const subset = subsetArg ? parseInt(subsetArg.split('=')[1], 10) : 12;
const fresh = args.includes('--fresh');

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function bar(pct: number, width = 24): string {
  const filled = Math.round((pct / 100) * width);
  return '['.padEnd(filled + 1, '#').padEnd(width + 1, '-') + ']';
}

function pickSample(results: CouncilAgentResult[]): CouncilAgentResult[] {
  if (!results.length) return [];
  const supports = results
    .filter((r) => r.finalStance === 'support')
    .sort((a, b) => b.finalConfidence - a.finalConfidence);
  const opposes = results
    .filter((r) => r.finalStance === 'oppose')
    .sort((a, b) => b.finalConfidence - a.finalConfidence);
  const conspiracy = results
    .filter((r) => r.agent.profession === 'ConspiracyTheorist')
    .sort((a, b) => b.finalConfidence - a.finalConfidence);
  const out: CouncilAgentResult[] = [];
  if (supports[0]) out.push(supports[0]);
  if (opposes[0]) out.push(opposes[0]);
  if (conspiracy[0] && !out.includes(conspiracy[0])) out.push(conspiracy[0]);
  return out;
}

async function main() {
  await router.init();
  const info = router.info();
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  SWARM COUNCIL — phase 3 test run`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  subset: ${subset} agents`);
  console.log(`  fresh:  ${fresh}`);
  console.log(`  ollama: ${info.ollamaSelected ?? '(none)'} (${info.ollamaModels.length} available)`);
  console.log(`  cloud:  ${Object.entries(info.configured).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none)'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('SCENARIO:');
  console.log(SCENARIO.trim().replace(/^/gm, '  '));
  console.log();

  const t0 = performance.now();

  const lastReport = new Map<number, number>();
  const results = await runCouncil(SCENARIO, {
    subset,
    fresh,
    onProgress: (e) => {
      if (e.type === 'round_start') {
        console.log(`\n--- round ${e.round} (${e.total} agents) ---`);
      } else if (e.type === 'agent_done') {
        const pct = Math.round((e.done / e.total) * 100);
        const prev = lastReport.get(e.round) ?? -1;
        if (pct >= prev + 10 || e.done === e.total) {
          lastReport.set(e.round, pct);
          process.stdout.write(`  r${e.round} ${bar(pct)} ${e.done}/${e.total} (${pct}%)\r`);
        }
      } else if (e.type === 'round_done') {
        console.log(`  r${e.round} ${bar(100)} done in ${fmtMs(e.elapsedMs)}                          `);
      } else if (e.type === 'error') {
        console.log(`  ! r${e.round} ${e.agentId} :: ${e.message}`);
      }
    },
  });

  const totalMs = Math.round(performance.now() - t0);

  // ---- synthesis ----
  const summary = synthesize(results);
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  SYNTHESIS (${results.length} agents, ${fmtMs(totalMs)} total)`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  support: ${summary.supportPct}%  oppose: ${summary.opposePct}%  abstain: ${summary.abstainPct}%`);
  console.log(`  consensus score: ${summary.consensusScore}/100`);
  console.log(`  dissenting agents: ${summary.dissentingAgentIds.length}`);
  console.log('\n  top risks (clustered):');
  for (const r of summary.topRisks) {
    console.log(`    ${String(r.count).padStart(3)} × ${r.risk}`);
  }

  // ---- by profession ----
  const byProf = new Map<string, { sup: number; opp: number; abs: number }>();
  for (const r of results) {
    const k = r.agent.profession;
    const cur = byProf.get(k) ?? { sup: 0, opp: 0, abs: 0 };
    if (r.finalStance === 'support') cur.sup++;
    else if (r.finalStance === 'oppose') cur.opp++;
    else cur.abs++;
    byProf.set(k, cur);
  }
  console.log('\n  by profession:');
  for (const [prof, c] of byProf) {
    console.log(`    ${prof.padEnd(20)}  s=${c.sup}  o=${c.opp}  a=${c.abs}`);
  }

  // ---- sample agents ----
  console.log('\n  sample agents (round-3 raw):');
  for (const r of pickSample(results)) {
    console.log(`\n    [${r.agent.id}] stance=${r.finalStance} conf=${r.finalConfidence}`);
    console.log(`      risk: ${r.keyRisk}`);
    const r1Preview = r.rounds[0].content.replace(/\s+/g, ' ').slice(0, 220);
    console.log(`      r1: ${r1Preview}${r.rounds[0].content.length > 220 ? '...' : ''}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  done in ${fmtMs(totalMs)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
