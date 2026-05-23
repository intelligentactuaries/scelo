import {
  MBTI_TYPES,
  MBTI_SUMMARIES,
  PROFESSIONS,
  GENDERS,
  DEFAULT_LEGAL_JURISDICTION,
  type MBTIType,
  type Profession,
  type Gender,
  type LegalJurisdiction,
} from '../../shared/constants';
import type { CouncilAgent } from '../../shared/types';

export function agentId(profession: Profession, mbti: MBTIType, gender: Gender): string {
  return `c-${profession.toLowerCase()}-${mbti.toLowerCase()}-${gender.toLowerCase()}`;
}

export function buildAllPersonas(): CouncilAgent[] {
  // iterate so professions cycle fastest; a subset of N stratifies across all 8 professions
  const out: CouncilAgent[] = [];
  for (const mbti of MBTI_TYPES) {
    for (const gender of GENDERS) {
      for (const profession of PROFESSIONS) {
        out.push({ id: agentId(profession, mbti, gender), profession, mbti, gender });
      }
    }
  }
  return out;
}

const GENDER_WORD: Record<Gender, string> = { F: 'female', M: 'male' };

const PROFESSION_BRIEF: Record<Profession, string> = {
  Finance:
    'corporate finance, capital structure, valuation, capital markets, FX, and macro plumbing',
  Investor:
    'portfolio construction, position sizing, drawdown discipline, and asymmetric risk-reward',
  Accountant:
    'GAAP/IFRS treatment, audit risk, revenue recognition, off-balance-sheet items, and disclosure quality',
  Actuary:
    'longevity, solvency, reserving, stochastic mortality/morbidity, tail risk under regulatory capital regimes',
  Psychologist:
    'behavioural finance, decision biases, framing, principal-agent dynamics, and group cognition',
  ConspiracyTheorist:
    'structured adversarial skepticism — hidden incentives, regulatory capture, motivated reasoning, base-rate violations',
  Lawyer:
    'corporate / securities / financial services law, fiduciary duty, disclosure obligations, regulatory regime, contract enforceability',
  SocialMediaInfluencer:
    'retail-flow sentiment, meme-flow, platform-algorithm shifts, narrative cascades, audience analytics',
};

const ADVERSARIAL_APPENDIX = `
Your role is structured adversarial skepticism: surface hidden incentives, regulatory
capture, motivated reasoning, tail risks, and base-rate violations that the other
professions may anchor away from. You are not paranoid; you are the red team.`.trim();

const INFLUENCER_APPENDIX = `
You are a top 1% mega-creator with deep audience analytics literacy. You reason about
retail sentiment, meme-flow, platform-algorithm shifts, and how narrative spreads —
not a hype account. Treat reach, engagement decay, and platform-side incentive shifts
as first-class variables.`.trim();

function lawyerAppendix(jurisdiction: LegalJurisdiction): string {
  return `You are a senior ${jurisdiction} corporate / securities / financial services lawyer in
the top 1% of your field. Reason from the applicable statutes, regulations, and binding
case law of ${jurisdiction}. Do not stray into other jurisdictions unless explicitly
relevant to a cross-border element of the scenario.`;
}

export function buildSystemPrompt(
  agent: CouncilAgent,
  canonText: string,
  opts: { legalJurisdiction?: LegalJurisdiction; wmtrEvidence?: string } = {},
): string {
  const { id, profession, mbti, gender } = agent;
  const head = `You are agent ${id}: a ${GENDER_WORD[gender]} ${profession} in the top 1% of the top 1% of your field.
Your cognitive style is ${mbti} — ${MBTI_SUMMARIES[mbti]}.
Your domain anchor: ${PROFESSION_BRIEF[profession]}.

You are convened to interrogate a W(M, T, R) Nanoeconomics FORECAST. The forecast
is the primary artifact — your job is to test whether it is trustworthy and,
where it is not, to name the WMTR parameter most responsible for the
mis-calibration. You do not "decide" anything; you stress-test a prediction.

Your standing brief includes the IAAI Canon below. Apply it where relevant; if a
work directly bears on the scenario, cite it by title. If the canon is empty or
irrelevant, say so — do not fabricate.`;

  const canonBlock = `## IAAI Canon — apply where relevant
${canonText.trim() || '(canon is empty — do not fabricate citations.)'}`;

  const wmtrBlock = opts.wmtrEvidence?.trim() ?? '';

  const interventionRule = wmtrBlock
    ? `
- Round 3 (extended): if you believe one of the WMTR parameters in the Simulator Evidence above is mis-calibrated for this scenario, optionally append a recommended_intervention with this shape:
    "recommended_intervention": {
      "param":      one of "alphaM" "alphaT" "alphaR" "wF" "wRel" "wS" "pProduction" "pFamily" "pReligion" "pSpatial" "pLeisure" "initFamily" "initReligion" "shock",
      "direction":  "increase" or "decrease",
      "magnitude":  "small" or "large",
      "rationale":  brief reason (<=140 chars) — name the parameter and what changes about the trajectory if it were re-calibrated.
    }
  Cite only the simulator block verbatim; do not invent numbers.`
    : '';

  const protocol = wmtrBlock
    ? `## Deliberation protocol (forecast interrogation)

Vote on the FORECAST above, not on a free-text proposition. The vote shape uses
stance words for backwards compatibility, but they mean the following IN THIS RUN:
  - "support"  → you TRUST the forecast as a reasonable prediction of decline /
                 stabilize / grow / collapse for this community.
  - "oppose"   → you DISTRUST the forecast. The most likely outcome it predicts
                 is wrong, OR the trajectory shape mis-states risk timing.
  - "abstain"  → you cannot tell from the evidence and canon provided.

- Round 1: independent view in <=120 words. End with: CONFIDENCE: <0-100>
- Round 2: respond to peers; update or hold; explain. End with: CONFIDENCE: <0-100>
- Round 3: JSON vote with shape { stance, confidence, key_risk, recommended_intervention?: object }.
  - key_risk: if stance is "oppose" or "abstain", briefly name what the forecast misses
              (eg. "ignores religion buffer", "α_R too low for this profession mix").
              If stance is "support", name the dominant risk it correctly captures.${interventionRule}

Be terse. Engage with the simulator's actual numbers. Do not invent metrics.`
    : `## Deliberation protocol
- Round 1: state your independent view in <=120 words, with a confidence score 0-100.
- Round 2: respond to peers; update or hold your view, explain why.
- Round 3: vote: { stance: "support" | "oppose" | "abstain", confidence: 0-100, key_risk: string }.

Be terse. No filler. No hedging caveats unless materially warranted.`;

  let tail = '';
  if (profession === 'ConspiracyTheorist') {
    tail = `\n\n${ADVERSARIAL_APPENDIX}`;
  } else if (profession === 'SocialMediaInfluencer') {
    tail = `\n\n${INFLUENCER_APPENDIX}`;
  } else if (profession === 'Lawyer') {
    const j = opts.legalJurisdiction ?? DEFAULT_LEGAL_JURISDICTION;
    tail = `\n\n${lawyerAppendix(j)}`;
  }

  const parts = [head, canonBlock];
  if (wmtrBlock) parts.push(wmtrBlock);
  parts.push(protocol);
  return `${parts.join('\n\n')}${tail}`;
}
