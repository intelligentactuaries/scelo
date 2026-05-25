// Surfaces an "Open in dashboard" link beneath an assistant turn when a
// tool result corresponds to a specialist with a real dashboard surface.
// The dashboard route reads ?prefill={base64-json} on mount.

import { useMemo } from "react";
import { Link } from "react-router-dom";

const SUPPORTED = new Set([
  "reserving",
  "mortality",
  "pensions",
  "pricing",
  "climate",
  "capital",
  "regulatory",
  "documentation",
]);

type Props = {
  specialist: string;
  dashboardPath?: string;
  // Inputs to pre-populate the dashboard form. Encoded as base64-JSON in
  // the query string.
  prefill?: Record<string, unknown>;
};

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
  // Bun / node fallback — not used in browsers but keeps tests happy.
  return Buffer.from(s, "utf-8").toString("base64");
}

export function OpenInDashboardButton({ specialist, dashboardPath, prefill }: Props) {
  const slug = specialist.toLowerCase();
  const href = useMemo(() => {
    const base = dashboardPath ?? `/dashboards/${slug}`;
    if (!prefill || Object.keys(prefill).length === 0) return base;
    return `${base}?prefill=${encodeURIComponent(toBase64(JSON.stringify(prefill)))}`;
  }, [dashboardPath, slug, prefill]);

  if (!dashboardPath && !SUPPORTED.has(slug)) return null;
  const label = dashboardPath ?? `/dashboards/${slug}`;

  return (
    <Link
      to={href}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-2 self-start border border-primary bg-primary/5 px-3 py-1.5 font-mono text-primary text-xs hover:bg-primary/15"
    >
      open in {label}
      <span aria-hidden>↗</span>
    </Link>
  );
}
