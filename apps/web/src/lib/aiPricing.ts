// Per-million-token prices for the hosted providers Scelo can talk to.
// Mirrors the table in apps/api/.../orchestrator.py — kept in sync by
// hand for now (a small enough table that drift is visible in code
// review). Local Ollama / OpenAI-compatible endpoints stay $0 since the
// user pays in electrons, not subscription dollars.
//
// Matching strategy is prefix-on-model: e.g. `claude-sonnet-4-6-20260101`
// folds into the `claude-sonnet` family rate. Add a new prefix here when
// a provider releases a new model family.

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICES: Record<string, Array<[string, Price]>> = {
  anthropic: [
    // Order matters: first prefix match wins, so the dated legacy Opus
    // families sit above the general `claude-opus` rate. Current sheet:
    // Fable/Mythos 5 $10/$50 · Opus 4.6→5 $5/$25 · Sonnet $3/$15 ·
    // Haiku 4.5 $1/$5. (Opus ≤4.1 kept its old $15/$75.)
    ["claude-fable", { inputPerMTok: 10.0, outputPerMTok: 50.0 }],
    ["claude-mythos", { inputPerMTok: 10.0, outputPerMTok: 50.0 }],
    ["claude-opus-4-1", { inputPerMTok: 15.0, outputPerMTok: 75.0 }],
    ["claude-opus-4-0", { inputPerMTok: 15.0, outputPerMTok: 75.0 }],
    // Opus 4.0's dated full ID has no "-0" (claude-opus-4-20250514), so the
    // alias prefix above misses it.
    ["claude-opus-4-20250514", { inputPerMTok: 15.0, outputPerMTok: 75.0 }],
    ["claude-opus", { inputPerMTok: 5.0, outputPerMTok: 25.0 }],
    ["claude-sonnet", { inputPerMTok: 3.0, outputPerMTok: 15.0 }],
    ["claude-haiku", { inputPerMTok: 1.0, outputPerMTok: 5.0 }],
  ],
  openai: [
    ["gpt-5", { inputPerMTok: 5.0, outputPerMTok: 20.0 }],
    ["gpt-4o-mini", { inputPerMTok: 0.15, outputPerMTok: 0.6 }],
    ["gpt-4o", { inputPerMTok: 2.5, outputPerMTok: 10.0 }],
    ["o1", { inputPerMTok: 15.0, outputPerMTok: 60.0 }],
    ["codex", { inputPerMTok: 5.0, outputPerMTok: 20.0 }],
  ],
  gemini: [
    ["gemini-1.5-flash", { inputPerMTok: 0.075, outputPerMTok: 0.3 }],
    ["gemini-1.5-pro", { inputPerMTok: 1.25, outputPerMTok: 5.0 }],
    ["gemini-2.0-flash", { inputPerMTok: 0.075, outputPerMTok: 0.3 }],
  ],
};

const FREE_PROVIDERS = new Set(["ollama", "openai_compat", "rule_based_only"]);

export function estimateUSD(
  provider: string | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!provider) return 0;
  if (FREE_PROVIDERS.has(provider)) return 0;
  if (!model) return 0;
  const table = PRICES[provider];
  if (!table) return 0;
  const modelL = model.toLowerCase();
  const match = table.find(([prefix]) => modelL.startsWith(prefix));
  if (!match) return 0;
  const [, price] = match;
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
