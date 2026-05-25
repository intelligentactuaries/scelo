// Typed regulatory client for the /regulatory API routes (ADR-0013).

const ENV_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
const BASE = ENV_BASE && ENV_BASE.length > 0 ? ENV_BASE : "/api";

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BASE}${path}`);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

async function postJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${BASE}${path}?${qs}`, { method: "POST" });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return (await resp.json()) as T;
}

export type RegulatoryEntrySummary = {
  id: string;
  title: string;
  regulator: string;
  jurisdiction: string;
  document_type: string;
  section: string;
  tags: string[];
  effective_date: string;
  snapshot_date: string;
  citation_format: string;
  paraphrased: boolean;
  last_updated: string;
};

export type RegulatoryEntry = RegulatoryEntrySummary & {
  body: string;
  related: { id: string; title: string; exists: boolean }[];
  source_url: string;
  subsections: string[];
  document_title: string;
};

export type RegulatorySearchResult = {
  id: string;
  title: string;
  regulator: string;
  citation: string;
  score: number;
  is_stale: boolean;
  snippet: string;
};

export type RegulatoryFinding = {
  entry_id: string;
  regulator: string;
  citation: string;
  relevance_score: number;
  applicability: "directly_applicable" | "potentially_applicable" | "informational";
  excerpt: string;
  is_stale: boolean;
  source_url: string;
};

export type RegulatoryAdvisory = {
  query: string;
  findings: RegulatoryFinding[];
  summary: string;
  disclaimer: string;
  gaps: string[];
  flags: string[];
  engine: string;
  computed_at: string;
};

export type CitationResponse = {
  entry_id: string;
  citation: string;
  effective_date: string;
  source_url: string;
  paraphrased: boolean;
  disclaimer: string;
};

export async function listRegulatoryEntries(
  regulator?: string,
  jurisdiction?: string,
): Promise<{ n_entries: number; semantic_available: boolean; entries: RegulatoryEntrySummary[] }> {
  const params = new URLSearchParams();
  if (regulator) params.set("regulator", regulator);
  if (jurisdiction) params.set("jurisdiction", jurisdiction);
  const qs = params.toString();
  return getJson(`/regulatory/entries${qs ? `?${qs}` : ""}`);
}

export async function getRegulatoryEntry(id: string): Promise<RegulatoryEntry> {
  return getJson(`/regulatory/entries/${encodeURI(id)}`);
}

export async function searchRegulatory(
  q: string,
  opts?: { regulator?: string; jurisdiction?: string; k?: number },
): Promise<{ query: string; n: number; results: RegulatorySearchResult[] }> {
  const params = new URLSearchParams({ q, k: String(opts?.k ?? 10) });
  if (opts?.regulator) params.set("regulator", opts.regulator);
  if (opts?.jurisdiction) params.set("jurisdiction", opts.jurisdiction);
  return getJson(`/regulatory/search?${params}`);
}

export async function getCitation(entryId: string): Promise<CitationResponse> {
  return getJson(`/regulatory/citation/${encodeURI(entryId)}`);
}

export async function runComplianceCheck(
  description: string,
  domain = "general",
  jurisdiction = "ZA",
): Promise<RegulatoryAdvisory> {
  return postJson("/agents/regulatory/invoke", {
    description,
    domain,
    jurisdiction,
    capability: "predict",
  });
}

const APPLICABILITY_LABEL: Record<string, string> = {
  directly_applicable: "Directly applicable",
  potentially_applicable: "Potentially applicable",
  informational: "Informational",
};

export function applicabilityLabel(a: string): string {
  return APPLICABILITY_LABEL[a] ?? a;
}
