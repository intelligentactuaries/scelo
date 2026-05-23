import type { Profession, LegalJurisdiction } from '../../shared/constants';
import type {
  Justification,
  JustificationCitation as Citation,
  JustificationFormula as Formula,
} from '../../shared/types';

export type { Justification, Citation, Formula };

// Bump when toolkit text or schema changes — invalidates cached justifications.
export const TOOLKIT_VERSION = 'tk-2026-05-21-actuary-applied-math';

export const JUSTIFICATION_TOOLKITS: Record<Profession, string> = {
  Accountant: `Canonical sources: IFRS standards (IAS 1, IAS 36, IFRS 9, IFRS 15, IFRS 16, IFRS 17 where insurance-adjacent), US GAAP (ASC 606, ASC 326, ASC 842), and reference texts: Kieso/Weygandt/Warfield "Intermediate Accounting", Penman "Financial Statement Analysis and Security Valuation", IFRS Foundation Conceptual Framework. Locator format: standard + paragraph (e.g. "IFRS 9 §5.5.17"). Formulas allowed but not required — ratios, impairment models, ECL.`,

  Actuary: `Canonical sources: SOA / IFoA / ASSA syllabus material — Bowers et al. "Actuarial Mathematics", Klugman/Panjer/Willmot "Loss Models", Dickson/Hardy/Waters "Actuarial Mathematics for Life Contingent Risks", Hull "Options, Futures, and Other Derivatives" where financial-math relevant. Standards: IFRS 17, Solvency II, SAM (South African).

FORMULA OUTPUT CONTRACT (Actuary only):
- At least ONE formula is mandatory.
- Use International Actuarial Notation. Emit ONLY these KaTeX macros for actuarial
  quantities (the renderer defines them; raw improvised LaTeX for these will render wrong):

  Interest:   \\vfac  \\rateforce  \\ratedisc  \\accum{n}
  Annuities-certain:  \\annimm{n}  \\anndue{n}  \\anncont{n}  \\accimm{n}  \\accdue{n}
  Life table: \\force{x+t}  \\survl{x}  \\deaths{x}  \\curtexp{x}  \\complexp{x}
  Probabilities:  \\px{t}{x}  \\qx{t}{x}  \\defq{t}{u}{x}
  Life annuities: \\lifeann{x}  \\lifeanndue{x}  \\templife{x}{n}
  Insurances: \\whole{x}  \\term{x}{n}  \\pureendow{x}{n}  \\endow{x}{n}
  Premiums/reserves: \\prem{x}  \\premterm{x}{n}  \\reserve{t}{x}
  Credibility: \\cred{n}{k}
  Commutation functions D_x N_x C_x M_x R_x S_x — write plainly, no macro needed.

- For interest-rate math you may use ordinary LaTeX (\\frac, ^, \\sum, \\prod, \\int,
  \\delta, v^n, etc.). The macros above are ONLY for the actuarial-specific symbols.
- The "latex" field must be a SINGLE expression with NO surrounding $ or $$.
- In the "applied" line, restate the formula in words AND plug in scenario numbers.
  Wrap every mathematical fragment in single-dollar delimiters ($…$) so the
  client renders it inline. Variable names, equations and numeric expressions
  with exponents/fractions all count as math.
- Example of a well-formed formula object:
  {
    "name": "Present value of an n-year annuity-immediate",
    "latex": "\\\\annimm{n} = \\\\frac{1 - v^{n}}{i}, \\\\quad v = \\\\frac{1}{1+i}",
    "applied": "With $i = 0.085$ and $n = 10$, PV factor = $(1 - 1.085^{-10})/0.085 = 6.561$ per unit of annual cashflow."
  }
- Another:
  {
    "name": "EPV of an n-year endowment assurance",
    "latex": "\\\\endow{x}{n} = \\\\term{x}{n} + \\\\pureendow{x}{n}",
    "applied": "$\\\\endow{x}{n}$ decomposes into $\\\\term{x}{n}$ (death benefit) plus $\\\\pureendow{x}{n}$ (survival benefit) for a life age $x$ over $n$ years."
  }
- Do NOT invent macro names. If a quantity has no macro above, build it from ordinary
  LaTeX rather than guessing a macro that doesn't exist.

Apply numbers from the scenario where they exist.`,

  Lawyer: `Canonical sources depend on jurisdiction setting.
ZA: Companies Act 71 of 2008, FAIS Act 37 of 2002, FICA Act 38 of 2001, FSR Act 9 of 2017, POPIA, JSE Listings Requirements, King IV Report on Corporate Governance, relevant Constitutional Court / SCA judgments.
US: Securities Act 1933, Exchange Act 1934, Sarbanes-Oxley, Dodd-Frank, Delaware GCL, Reg S-K / S-X, relevant SCOTUS / 2nd Cir / Del. Ch. judgments.
UK: Companies Act 2006, FSMA 2000, FCA Handbook, UK Listing Rules, Bribery Act 2010.
EU: MiFID II, MAR, GDPR, CSRD, AIFMD.
Locator format: short title + section (e.g. "Companies Act 71/2008, s 76(3)"). Case citations as standard for the jurisdiction. Formulas not expected.`,

  Finance: `Canonical sources: Brealey/Myers/Allen "Principles of Corporate Finance", Damodaran "Investment Valuation", Fabozzi "Bond Markets", Hull (derivatives). Theoretical: Modigliani-Miller, CAPM (Sharpe-Lintner-Mossin), Fama-French 3- and 5-factor, APT, Black-Scholes-Merton, DCF, EVA. Formulas expected when valuation or risk is at issue. Locator format: textbook + chapter, or paper author + year.`,

  Investor: `Canonical sources: Graham "Security Analysis" and "The Intelligent Investor", Buffett's Berkshire shareholder letters (cite year), Marks "The Most Important Thing", Klarman "Margin of Safety", Damodaran's narrative-and-numbers framework, Markowitz portfolio theory, Lynch "One Up on Wall Street". Locator format: author + work + chapter, or letter year for Buffett. Formulas optional — when used, prefer simple: margin of safety, owner earnings, ROIC vs WACC.`,

  Psychologist: `Canonical sources for financial-decision context: Kahneman "Thinking, Fast and Slow"; Tversky & Kahneman prospect theory (1979, 1992); Thaler "Misbehaving"; Shiller "Irrational Exuberance"; Cialdini "Influence"; DSM-5-TR only where clinical patterns are genuinely diagnostic of decision-maker risk. Frameworks: prospect theory, dual-process, anchoring, herding, overconfidence, loss aversion. Locator format: author + year + concept. Formulas optional (e.g. prospect-theory value function v(x) = x^α for x≥0, -λ(-x)^β for x<0).`,

  ConspiracyTheorist: `You are the structured adversarial skeptic. Canonical sources: Taleb "The Black Swan" and "Antifragile"; Mandelbrot "The (Mis)Behavior of Markets"; Kindleberger "Manias, Panics, and Crashes"; Akerlof & Shiller "Phishing for Phools"; Reinhart & Rogoff "This Time Is Different"; Stigler / public-choice on regulatory capture; principal-agent literature. Also: documented historical analogues (LTCM, Enron, Wirecard, Steinhoff, Madoff, 2008 MBS, FTX). Cite hidden-incentive structures and base-rate violations. No fringe / pseudoscience material — ever. Locator: author + work + chapter, or case name + year.`,

  SocialMediaInfluencer: `Canonical sources: platform engineering blogs (TikTok For You algorithm, Meta ranking system, X recommendation algorithm open-source release 2023); creator-economy research (Goldman Sachs creator economy reports, SignalFire creator economy index); attention/virality literature (Berger "Contagious", Thompson "Hit Makers"); retail-flow studies (Robinhood / WallStreetBets academic papers — Bradley et al. on Reddit-driven trading). Cite platform-mechanic specifics (e.g. "TikTok's FYP heat-score decays after ~48h without watch-time velocity"), engagement metric thresholds, and documented narrative cascades (GME Jan 2021, AMC, $DJT). Locator: platform doc + section, or paper author + year. Formulas optional — when used, prefer engagement rate, K-factor, decay curves.`,
};

export interface JustificationRecord {
  agentId: string;
  runId: string;
  toolkitVersion: string;
  voteHash: string;
  generatedAt: number;
  justification: Justification;
}

export interface JustifyPromptArgs {
  scenario: string;
  profession: Profession;
  vote: { stance: string; confidence: number; keyRisk: string };
  matchedCanon: { title: string; takeaway?: string }[];
  legalJurisdiction?: LegalJurisdiction;
}

const SHARED_ADDENDUM = `You are now in JUSTIFICATION MODE. The Professor has asked you to defend your
round-3 vote using the canonical reference material of your profession. Output
strict JSON matching this schema:

{
  "framework": "<which domain framework / standard / school of thought you are applying>",
  "citations": [
    { "source": "<book, statute, paper, standard, case>", "locator": "<chapter / section / page / paragraph>", "relevance": "<one line, why it bears on this vote>" }
  ],
  "formulas": [
    { "name": "<formula name>", "latex": "<KaTeX-compatible LaTeX, no $ delimiters>", "applied": "<one line: how the numbers in this scenario plug in>" }
  ],
  "body": "<<= 220 words tying citations + formulas to your vote. No filler.>"
}

Rules:
- Output is ONE JSON object — no preamble, no code fences, no trailing text.
- Cite only material you are confident actually exists. If you are unsure, omit it.
- For your profession, follow the TOOLKIT below — do not stray into another profession's toolkit.
- If the IAAI Canon contains material that directly applies, include it as a citation with source set to the work title.
- formulas[] may be empty for professions where formulas are not the natural form of justification.
- citations[] may be empty only if you genuinely have none — say so in body.
- formulas[].latex is a JSON string value, so every backslash MUST be doubled:
  write "\\\\alpha", "\\\\frac{a}{b}", "\\\\sum_{i=1}^{n}", "\\\\overline{n}".
  A single backslash like "\\alpha" produces invalid JSON and will be rejected.`;

export function buildJustificationSystemAddendum(args: JustifyPromptArgs): string {
  let toolkit = JUSTIFICATION_TOOLKITS[args.profession];
  if (args.profession === 'Lawyer' && args.legalJurisdiction) {
    toolkit = `Jurisdiction in effect: ${args.legalJurisdiction}. Cite only ${args.legalJurisdiction} material from the list below — do not stray into other jurisdictions unless the scenario has a cross-border element.\n\n${toolkit}`;
  }
  const canonBlock =
    args.matchedCanon.length > 0
      ? `\n\nIAAI CANON — works that match this scenario; include at least one as a citation with source set to the work title:\n${args.matchedCanon
          .map((w) => `- "${w.title}"${w.takeaway ? ` — ${w.takeaway}` : ''}`)
          .join('\n')}`
      : '';
  return `${SHARED_ADDENDUM}\n\nTOOLKIT (${args.profession}):\n${toolkit}${canonBlock}`;
}

export function buildJustificationUserPrompt(args: JustifyPromptArgs): string {
  return `Scenario:
${args.scenario}

Your round-3 vote:
stance: ${args.vote.stance}
confidence: ${args.vote.confidence}
key_risk: ${args.vote.keyRisk}

Output strict JSON only — no preamble, no code fences, no trailing commentary.`;
}

const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were', 'will',
  'would', 'should', 'could', 'their', 'they', 'them', 'these', 'those', 'into', 'over', 'under',
  'about', 'after', 'before', 'above', 'below', 'between', 'against', 'while', 'where', 'what',
  'when', 'which', 'than', 'then', 'also', 'such', 'some', 'most', 'much', 'very', 'only', 'just',
  'each', 'every', 'other', 'than', 'because', 'still', 'even', 'more', 'less', 'into',
]);

function keywords(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function matchCanonByKeywords(
  scenario: string,
  works: { title: string; abstract?: string; takeaway?: string }[],
  minOverlap = 2,
): { title: string; takeaway?: string }[] {
  const scenarioKw = keywords(scenario);
  const matches: { title: string; takeaway?: string; overlap: number }[] = [];
  for (const w of works) {
    const workText = `${w.title} ${w.abstract ?? ''} ${w.takeaway ?? ''}`;
    const workKw = keywords(workText);
    let overlap = 0;
    for (const k of workKw) if (scenarioKw.has(k)) overlap++;
    if (overlap >= minOverlap) matches.push({ title: w.title, takeaway: w.takeaway, overlap });
  }
  matches.sort((a, b) => b.overlap - a.overlap);
  return matches.slice(0, 3).map(({ title, takeaway }) => ({ title, takeaway }));
}

export function voteHash(vote: { stance: string; confidence: number; keyRisk: string }): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(JSON.stringify({ s: vote.stance, c: vote.confidence, k: vote.keyRisk }));
  return hasher.digest('hex').slice(0, 24);
}

// ─── Group aggregation ─────────────────────────────────────────────────

export interface GroupVoteEntry {
  agentId: string;
  mbti: string;
  gender: string;
  stance: string;
  confidence: number;
  keyRisk: string;
}

export interface JustifyGroupPromptArgs {
  scenario: string;
  profession: Profession;
  agents: GroupVoteEntry[];
  matchedCanon: { title: string; takeaway?: string }[];
  legalJurisdiction?: LegalJurisdiction;
}

function dominantStance(agents: GroupVoteEntry[]): {
  stance: string;
  count: number;
  total: number;
  byStance: Record<string, { count: number; avgConf: number }>;
} {
  const acc: Record<string, { count: number; sumConf: number }> = {};
  for (const a of agents) {
    if (!acc[a.stance]) acc[a.stance] = { count: 0, sumConf: 0 };
    acc[a.stance].count++;
    acc[a.stance].sumConf += a.confidence;
  }
  let dom = '';
  let max = -1;
  const byStance: Record<string, { count: number; avgConf: number }> = {};
  for (const [s, { count, sumConf }] of Object.entries(acc)) {
    byStance[s] = { count, avgConf: Math.round(sumConf / count) };
    if (count > max) {
      max = count;
      dom = s;
    }
  }
  return { stance: dom, count: max, total: agents.length, byStance };
}

const GROUP_SHARED_ADDENDUM = `You are now in JUSTIFICATION MODE — AGGREGATED.

The Professor has asked you to defend the COLLECTIVE round-3 position of an
entire profession group on this council. You speak as the synthesised voice
of every {Profession} agent that voted. Output strict JSON in the same schema
as an individual justification:

{
  "framework": "<the dominant framework the group is applying>",
  "citations": [
    { "source": "<book, statute, paper, standard, case>", "locator": "<chapter / section / page / paragraph>", "relevance": "<one line>" }
  ],
  "formulas": [
    { "name": "<formula name>", "latex": "<KaTeX-compatible LaTeX>", "applied": "<one line>" }
  ],
  "body": "<<= 320 words. Aggregate body MUST cover three things: (1) how strongly the group agrees, citing the vote distribution; (2) the dominant rationale in profession-specific terms; (3) where dissenters diverged and what they prioritised differently. Plain prose, no bullet lists.>"
}

Rules (same as individual mode, with one addition):
- Output is ONE JSON object — no preamble, no code fences, no trailing text.
- Cite only material you are confident actually exists.
- Stay strictly inside the TOOLKIT below — do not borrow another profession's canon.
- formulas[].latex is a JSON string value, so every backslash MUST be doubled:
  write "\\\\alpha", "\\\\frac{a}{b}", "\\\\sum_{i=1}^{n}", "\\\\overline{n}".
  A single backslash like "\\alpha" produces invalid JSON and will be rejected.
- citations[] may be empty only if you genuinely have none — say so in body.
- This is an AGGREGATE: do not impersonate any one agent. Speak in the
  plural ("we", "the {Profession}s") or in the institutional voice ("the
  {Profession} position is…"). Do not quote individual agent ids.`;

export function buildGroupSystemAddendum(args: JustifyGroupPromptArgs): string {
  const dom = dominantStance(args.agents);
  const distribution = Object.entries(dom.byStance)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([s, { count, avgConf }]) => `${s}=${count} (avg conf ${avgConf})`)
    .join(', ');
  const voteLines = args.agents
    .map(
      (a) =>
        `  - ${a.agentId} [${a.mbti}/${a.gender}] → ${a.stance} ${a.confidence}: ${a.keyRisk}`,
    )
    .join('\n');

  let toolkit = JUSTIFICATION_TOOLKITS[args.profession];
  if (args.profession === 'Lawyer' && args.legalJurisdiction) {
    toolkit = `Jurisdiction in effect: ${args.legalJurisdiction}. Cite only ${args.legalJurisdiction} material from the list below — do not stray into other jurisdictions unless the scenario has a cross-border element.\n\n${toolkit}`;
  }

  const canonBlock =
    args.matchedCanon.length > 0
      ? `\n\nIAAI CANON — works that match this scenario; include at least one as a citation with source set to the work title:\n${args.matchedCanon
          .map((w) => `- "${w.title}"${w.takeaway ? ` — ${w.takeaway}` : ''}`)
          .join('\n')}`
      : '';

  const head = GROUP_SHARED_ADDENDUM.replace(/\{Profession\}/g, args.profession);

  return `${head}

GROUP — ${args.profession} (n=${dom.total})
Vote distribution: ${distribution}
Dominant stance: ${dom.stance} (${dom.count} of ${dom.total})

Individual votes:
${voteLines}

TOOLKIT (${args.profession}):
${toolkit}${canonBlock}`;
}

export function buildGroupUserPrompt(args: { scenario: string; profession: Profession }): string {
  return `Scenario:
${args.scenario}

Provide the aggregated ${args.profession}-group justification. Output strict JSON only — no preamble, no code fences, no trailing commentary.`;
}

export function groupVoteHash(agents: GroupVoteEntry[]): string {
  const hasher = new Bun.CryptoHasher('sha256');
  // sort by agentId so order changes don't perturb the hash
  const stable = [...agents]
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((a) => ({ a: a.agentId, s: a.stance, c: a.confidence, k: a.keyRisk }));
  hasher.update(JSON.stringify(stable));
  return hasher.digest('hex').slice(0, 24);
}

export function groupAgentId(profession: Profession): string {
  return `group:${profession}`;
}
