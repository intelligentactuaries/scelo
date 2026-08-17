// Reference data fetchers for the swarm simulation. Open APIs only —
// no auth, no commercial dependencies. Every payload becomes a verbatim
// block in the per-agent system prompt with strict "cite this block; do
// not invent" instructions, same protocol as the IAAI canon.
//
// Sources:
//   - PubChem REST       https://pubchem.ncbi.nlm.nih.gov/rest/pug/  (NCBI)
//   - OpenFDA            https://api.fda.gov/                         (FDA)
//   - ChEMBL REST        https://www.ebi.ac.uk/chembl/api/data/      (EMBL-EBI)
//
// Each call is cached in the existing `cache` table keyed by
// sha256(source + endpoint + query) so a repeated scenario is instant
// and we stay polite to upstream rate limits (PubChem 5 req/sec,
// OpenFDA 240 req/min unauth).

import { db } from './db';
import { createHash } from 'node:crypto';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — drug data shifts slowly

function cacheKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

interface CacheRow {
  hash: string;
  provider: string;
  model: string;
  response: string;
  created_at: number;
}

function fromCache(key: string): unknown | null {
  const row = db
    .prepare(`SELECT * FROM cache WHERE hash = ?`)
    .get(key) as CacheRow | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.response);
  } catch {
    return null;
  }
}

function toCache(key: string, source: string, endpoint: string, value: unknown): void {
  db.prepare(
    `INSERT OR REPLACE INTO cache (hash, provider, model, response, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(key, source, endpoint, JSON.stringify(value), Date.now());
}

async function fetchJson(url: string, source: string, endpoint: string): Promise<unknown> {
  const key = cacheKey([source, endpoint, url]);
  const cached = fromCache(key);
  if (cached !== null) return cached;
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'IA-swarm-sim/1.0' },
  });
  if (!r.ok) throw new Error(`${source} ${endpoint} ${r.status}`);
  const json = await r.json();
  toCache(key, source, endpoint, json);
  return json;
}

// ─── PubChem ──────────────────────────────────────────────────────────────

export interface PubChemCompound {
  cid: number;
  name: string;
  iupac: string;
  formula: string;
  molecularWeight: number;
  canonicalSmiles: string;
  synonyms: string[];
}

export async function pubchemCompoundByName(name: string): Promise<PubChemCompound | null> {
  if (!name?.trim()) return null;
  const enc = encodeURIComponent(name.trim());
  try {
    // Step 1: name → CID
    const cidResp = (await fetchJson(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${enc}/cids/JSON`,
      'pubchem',
      'name-to-cid',
    )) as { IdentifierList?: { CID?: number[] } };
    const cid = cidResp.IdentifierList?.CID?.[0];
    if (!cid) return null;

    // Step 2: CID → properties + synonyms
    const [props, syn] = await Promise.all([
      fetchJson(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/IUPACName,MolecularFormula,MolecularWeight,CanonicalSMILES/JSON`,
        'pubchem',
        'cid-properties',
      ) as Promise<{
        PropertyTable?: {
          Properties?: Array<{
            IUPACName?: string;
            MolecularFormula?: string;
            MolecularWeight?: string;
            CanonicalSMILES?: string;
          }>;
        };
      }>,
      fetchJson(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`,
        'pubchem',
        'cid-synonyms',
      ) as Promise<{ InformationList?: { Information?: Array<{ Synonym?: string[] }> } }>,
    ]);

    const p = props.PropertyTable?.Properties?.[0];
    if (!p) return null;
    const synonyms = (syn.InformationList?.Information?.[0]?.Synonym ?? []).slice(0, 12);

    return {
      cid,
      name,
      iupac: p.IUPACName ?? '',
      formula: p.MolecularFormula ?? '',
      molecularWeight: p.MolecularWeight ? Number(p.MolecularWeight) : 0,
      canonicalSmiles: p.CanonicalSMILES ?? '',
      synonyms,
    };
  } catch (e) {
    console.warn('[refdata] pubchem fetch failed:', (e as Error).message);
    return null;
  }
}

// ─── OpenFDA ──────────────────────────────────────────────────────────────

export interface OpenFdaSummary {
  query: string;
  totalReports: number;
  topReactions: Array<{ term: string; count: number }>;
  topSerious: Array<{ outcome: string; count: number }>;
}

/**
 * OpenFDA FAERS adverse-event summary for a drug. Returns the top reactions
 * and top "serious" outcome categories, both as histograms.
 *
 * Reaction MedDRA preferred term: tells us WHAT goes wrong.
 * Outcome category: tells us HOW BAD it goes (death / hospitalisation /
 * disabling / life-threatening / congenital anomaly / other-serious).
 */
export async function openFdaAdverseEvents(
  drugName: string,
): Promise<OpenFdaSummary | null> {
  if (!drugName?.trim()) return null;
  const q = encodeURIComponent(
    `patient.drug.medicinalproduct:"${drugName.trim()}"`,
  );
  try {
    const [reactions, outcomes] = await Promise.all([
      fetchJson(
        `https://api.fda.gov/drug/event.json?search=${q}&count=patient.reaction.reactionmeddrapt.exact&limit=20`,
        'openfda',
        'reactions',
      ) as Promise<{
        meta?: { results?: { total?: number } };
        results?: Array<{ term: string; count: number }>;
      }>,
      fetchJson(
        `https://api.fda.gov/drug/event.json?search=${q}&count=serious&limit=10`,
        'openfda',
        'outcomes',
      ) as Promise<{ results?: Array<{ term: string; count: number }> }>,
    ]);
    const SERIOUS_LABEL: Record<string, string> = {
      '1': 'serious (any)',
      '2': 'non-serious',
    };
    return {
      query: drugName,
      totalReports: reactions.meta?.results?.total ?? 0,
      topReactions: (reactions.results ?? []).slice(0, 15).map((x) => ({
        term: x.term.toLowerCase(),
        count: x.count,
      })),
      topSerious: (outcomes.results ?? []).map((x) => ({
        outcome: SERIOUS_LABEL[x.term] ?? x.term,
        count: x.count,
      })),
    };
  } catch (e) {
    console.warn('[refdata] openfda fetch failed:', (e as Error).message);
    return null;
  }
}

// ─── ChEMBL ──────────────────────────────────────────────────────────────

export interface ChemblTarget {
  query: string;
  preferredName: string;
  maxPhase: number; // 0-4 trial phase
  moleculeType: string;
  /** Mechanism description, if any. */
  mechanism: string | null;
  /** Target organism / family. */
  target: string | null;
}

export async function chemblByName(drugName: string): Promise<ChemblTarget | null> {
  if (!drugName?.trim()) return null;
  const enc = encodeURIComponent(drugName.trim());
  try {
    const search = (await fetchJson(
      `https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q=${enc}&limit=1`,
      'chembl',
      'molecule-search',
    )) as {
      molecules?: Array<{
        molecule_chembl_id: string;
        pref_name: string | null;
        max_phase: number | null;
        molecule_type: string | null;
      }>;
    };
    const mol = search.molecules?.[0];
    if (!mol) return null;
    const cid = mol.molecule_chembl_id;
    const mech = (await fetchJson(
      `https://www.ebi.ac.uk/chembl/api/data/mechanism.json?molecule_chembl_id=${cid}`,
      'chembl',
      'mechanism',
    )) as {
      mechanisms?: Array<{
        mechanism_of_action: string | null;
        target_chembl_id: string | null;
      }>;
    };
    const m = mech.mechanisms?.[0];
    let targetName: string | null = null;
    if (m?.target_chembl_id) {
      try {
        const t = (await fetchJson(
          `https://www.ebi.ac.uk/chembl/api/data/target/${m.target_chembl_id}.json`,
          'chembl',
          'target',
        )) as { pref_name?: string; organism?: string };
        targetName = [t.pref_name, t.organism].filter(Boolean).join(' · ') || null;
      } catch {
        /* keep null */
      }
    }
    return {
      query: drugName,
      preferredName: mol.pref_name ?? drugName,
      maxPhase: mol.max_phase ?? 0,
      moleculeType: mol.molecule_type ?? 'unknown',
      mechanism: m?.mechanism_of_action ?? null,
      target: targetName,
    };
  } catch (e) {
    console.warn('[refdata] chembl fetch failed:', (e as Error).message);
    return null;
  }
}

// ─── Bundled fetch ────────────────────────────────────────────────────────

export interface ReferenceBundle {
  drugs: Array<{
    name: string;
    pubchem: PubChemCompound | null;
    openFda: OpenFdaSummary | null;
    chembl: ChemblTarget | null;
  }>;
}

/**
 * Resolve a list of drug / compound names to a single bundle the simulation
 * engine can splice into agent prompts. Best-effort — null fields are fine
 * and the prompt template handles them.
 */
export async function fetchReferenceBundle(drugNames: string[]): Promise<ReferenceBundle> {
  const drugs = await Promise.all(
    drugNames.map(async (name) => {
      const [pubchem, openFda, chembl] = await Promise.all([
        pubchemCompoundByName(name),
        openFdaAdverseEvents(name),
        chemblByName(name),
      ]);
      return { name, pubchem, openFda, chembl };
    }),
  );
  return { drugs };
}

/** Format the bundle as a prompt block. Compact, but every line is
 *  citation-grade so an agent can quote it verbatim. */
export function formatReferenceBlock(bundle: ReferenceBundle): string {
  if (bundle.drugs.length === 0) return '';
  const lines: string[] = ['## Reference data (cite verbatim; do not invent)'];
  for (const d of bundle.drugs) {
    lines.push('');
    lines.push(`### ${d.name}`);
    if (d.pubchem) {
      lines.push(
        `- PubChem CID ${d.pubchem.cid} · ${d.pubchem.formula} · MW ${d.pubchem.molecularWeight.toFixed(2)}`,
      );
      if (d.pubchem.iupac) lines.push(`- IUPAC: ${d.pubchem.iupac.slice(0, 160)}`);
      if (d.pubchem.canonicalSmiles)
        lines.push(`- SMILES: ${d.pubchem.canonicalSmiles.slice(0, 120)}`);
    }
    if (d.chembl) {
      lines.push(
        `- ChEMBL · ${d.chembl.preferredName} · phase ${d.chembl.maxPhase} · ${d.chembl.moleculeType}`,
      );
      if (d.chembl.mechanism) lines.push(`  - MoA: ${d.chembl.mechanism}`);
      if (d.chembl.target) lines.push(`  - target: ${d.chembl.target}`);
    }
    if (d.openFda && d.openFda.totalReports > 0) {
      lines.push(`- OpenFDA FAERS · ${d.openFda.totalReports.toLocaleString()} reports`);
      if (d.openFda.topReactions.length > 0) {
        lines.push(
          `  - top reactions: ${d.openFda.topReactions
            .slice(0, 8)
            .map((r) => `${r.term} (${r.count})`)
            .join(', ')}`,
        );
      }
    }
    if (!d.pubchem && !d.chembl && !d.openFda) {
      lines.push(`- (no reference data resolved — open APIs returned nothing)`);
    }
  }
  return lines.join('\n');
}
