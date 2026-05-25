// Tools layer : a registry of deterministic functions the soft layer
// is allowed to invoke. Each tool wraps its result in a typed
// envelope; tools never throw on bad input (validation is the soft
// layer's job).
//
// Add a new tool : implement Tool<...> and append it to TOOLS. The
// dispatcher will find it by name. Keep tool bodies pure : if you
// need to write something durable, that's the hard layer's job.

import { validateClaim, type ClaimSoft, type Validated } from "./soft";

interface Tool<Input, Output> {
  name: string;
  run: (input: Input) => Output;
}

const reserve: Tool<ClaimSoft, { reserve: number; bornAt: string }> = {
  name: "compute_reserve",
  run: (claim) => ({
    // Toy formula : a 15% IBNR loading on the claim amount.
    reserve: Math.round(claim.amount * 1.15 * 100) / 100,
    bornAt: new Date().toISOString(),
  }),
};

const TOOLS = [reserve] as const;

export function dispatch(
  toolName: string,
  rawInput: unknown,
): Validated<{ tool: string; result: unknown }> {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) return { ok: false, error: `unknown tool: ${toolName}` };
  const v = validateClaim(rawInput);
  if (!v.ok) return v;
  return { ok: true, value: { tool: tool.name, result: tool.run(v.value) } };
}

if (import.meta.main) {
  const result = dispatch("compute_reserve", {
    policy: "P-000042",
    amount: 1500,
    date: "2026-05-20",
  });
  console.log(JSON.stringify(result, null, 2));
}
