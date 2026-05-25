// Helpers for reading ?prefill={base64-json} on the dashboard routes.

function fromBase64(s: string): string {
  if (typeof atob === "function") {
    return decodeURIComponent(escape(atob(s)));
  }
  return Buffer.from(s, "base64").toString("utf-8");
}

export function readPrefill<T = Record<string, unknown>>(
  search: string | URLSearchParams,
): T | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get("prefill");
  if (!raw) return null;
  try {
    return JSON.parse(fromBase64(raw)) as T;
  } catch {
    return null;
  }
}
