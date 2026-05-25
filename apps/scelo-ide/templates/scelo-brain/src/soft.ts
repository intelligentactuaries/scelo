// Soft layer : converts free-form payloads into typed values.
// Everything here is pure : no IO, no globals, deterministic, easily
// testable. The brain's invariant is that anything reaching the tools
// layer has already passed through `validateClaim`.

export interface ClaimSoft {
  policy: string;
  amount: number;
  date: string; // ISO yyyy-mm-dd
}

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateClaim(raw: unknown): Validated<ClaimSoft> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "claim must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.policy !== "string" || !/^P-\d{6}$/.test(r.policy)) {
    return { ok: false, error: "policy must look like P-123456" };
  }
  if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount < 0) {
    return { ok: false, error: "amount must be a non-negative number" };
  }
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    return { ok: false, error: "date must be ISO yyyy-mm-dd" };
  }
  return { ok: true, value: { policy: r.policy, amount: r.amount, date: r.date } };
}

if (import.meta.main) {
  const sample = { policy: "P-000042", amount: 1500.0, date: "2026-05-20" };
  const result = validateClaim(sample);
  console.log(JSON.stringify(result, null, 2));
}
