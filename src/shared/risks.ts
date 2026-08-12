// Clustering key for a council agent's stated key risk.
//
// Two agents rarely phrase the same worry identically, so counting raw strings
// would report every risk as "cited once". Normalising to the first six
// significant words is enough to collapse the near-duplicates while keeping
// genuinely different risks apart.
//
// Shared because it is used twice on different sides of the wire: the server
// aggregates `summary.topRisks` with it, and the client re-clusters the same
// field per stance to explain a verdict. Two copies would drift, and a
// stance explanation that groups risks differently from the summary beside it
// is worse than no explanation.
export function riskKey(risk: string | undefined | null): string {
  return (risk || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}
