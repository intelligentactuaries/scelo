import { router } from '../llm/router';

// Few-shot prompt: small models echo the opening sentence when given
// nothing but "summarize this", so the examples below explicitly
// demonstrate the transformation — *who* / *what* / *the unique
// constraint*, with all filler stripped.
const SYSTEM = `You compress a decision scenario into a tagline of AT MOST 12 words.

A good tagline captures three things:
  1. WHO is deciding (the subject)
  2. WHAT they're deciding (the action / object)
  3. The ONE most distinguishing constraint that makes the scenario unique

Strip filler — "is considering", "is evaluating whether to", "the question is whether",
adjectives that don't change the decision. Keep proper nouns, currencies, percentages,
specific durations.

Output the tagline ONLY. No preamble. No quotes. No trailing period.

EXAMPLES

Input: "A South African pension fund is considering allocating 8% of its portfolio to a single emerging-markets infrastructure REIT focused on toll roads across sub-Saharan Africa. The REIT has a 14% historical IRR but only a 4-year track record, leverage of 2.1x, and 60% of its revenue is dollar-denominated against rand-denominated liabilities. The fund must hold the position for 7 years (lock-up)."
Output: SA pension fund weighing 8% EM toll-road REIT with FX mismatch

Input: "A central bank is evaluating whether to raise interest rates by 50bps to combat inflation while unemployment is at 7.2% and consumer confidence is at a 10-year low."
Output: Central bank weighing 50bp hike against 7.2% unemployment and weak confidence

Input: "A startup founder is deciding whether to accept Series B funding from a VC known for hostile board takeovers, at $200M pre-money with 2x liquidation preference and pro-rata rights."
Output: Founder weighing $200M Series B with hostile VC and 2x liquidation preference

Input: "A hospital network is choosing whether to adopt an AI triage system that reduces ER wait times by 30% but produces a 4% false-negative rate on chest pain presentations."
Output: Hospital weighing AI triage: 30% faster wait vs 4% chest-pain miss rate`;

const USER = (scenario: string) => `Scenario:
${scenario}

Write the tagline now. ≤12 words. Just the words — no preamble.`;

const MAX_WORDS = 12;

/**
 * Generate a short tagline summary of a scenario. Falls back to a
 * truncated first-sentence slice if the LLM is unavailable or returns
 * something unusable. Always returns ≤12 words.
 */
export async function summarizeScenario(scenario: string): Promise<string> {
  const cleaned = scenario.trim();
  if (cleaned.length === 0) return '';

  try {
    const raw = await router.route(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER(cleaned) },
      ],
      // Use the council tier — the same one running the swarm agents.
      // The "society" tier doesn't always have a provider configured.
      'council',
      // Slightly warmer than the council reasoning passes so the model
      // is encouraged to TRANSFORM the scenario rather than echo its
      // opening line. The 64-token cap is well over the 12-word target.
      { temperature: 0.4, maxTokens: 64 },
    );
    let summary = stripQuotes(raw.trim()).replace(/[.!?\s]+$/u, '');
    // Some small models prepend "Output:" or "Tagline:" — strip a leading label.
    summary = summary.replace(/^\s*(?:output|tagline|summary)\s*[:\-—]\s*/iu, '');
    // Take only the first line — the model occasionally appends notes.
    summary = summary.split(/[\r\n]/u)[0]!.trim();
    summary = clipToWords(summary, MAX_WORDS);

    // Reject obvious echoes: if the model just gave us a prefix of the
    // input verbatim, treat it as a failed compression and fall back.
    if (isEchoOfScenario(summary, cleaned)) {
      throw new Error('LLM echoed the scenario opening');
    }
    if (summary.length === 0) throw new Error('empty summary');
    return summary;
  } catch {
    // Local fallback — works even if no LLM provider is configured.
    return clipToWords(stripQuotes(cleaned).split(/[.!?\n]/u)[0]!.trim(), MAX_WORDS);
  }
}

function clipToWords(s: string, n: number): string {
  const words = s.split(/\s+/u).filter(Boolean);
  if (words.length <= n) return words.join(' ');
  return words.slice(0, n).join(' ') + '…';
}

function stripQuotes(s: string): string {
  return s.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '');
}

// True if `summary` is essentially the opening of `scenario` (possibly
// modulo punctuation/case). A real compression should rephrase, so a
// long prefix-match means the model failed to summarize.
function isEchoOfScenario(summary: string, scenario: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,;:!?'"…—–-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(summary);
  const b = norm(scenario);
  if (a.length < 12) return false;
  // strip any trailing "..." we added in clipToWords before comparing
  const aClean = a.replace(/\s*…\s*$/u, '').trim();
  return b.startsWith(aClean);
}
