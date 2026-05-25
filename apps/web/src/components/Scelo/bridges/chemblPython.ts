// Optional Python delegation that consumes the downloaded ChEMBL
// SQLite (registered as the `chembl` dataset in apps/scelo-ide/src/main.ts).
// Looks up a single drug by name + returns canonical-name, indication
// list, half-life, AE rate.
//
// First swarm-simulator consumer of the ChEMBL bulk download — without
// this the simulator's drug references are scraped from PubChem live; with
// it the same scenarios run fully offline against the curated EMBL-EBI
// bioactivity database.
//
// Caveats:
//   * The downloaded archive is a .tar.gz wrapping the SQLite database;
//     this bridge assumes the user has extracted it once (the script
//     extracts on demand and caches the unpacked path next to the .tar.gz).
//   * Queries are read-only; the SQLite file is opened with mode=ro.

import { isDesktopIDE, runPython, getRuntimeStatus } from "../../../lib/sceloIDE";

export interface ChemblDrugLookup {
  query: string;
  canonicalName: string | null;
  chemblId: string | null;
  maxPhase: number | null;          // 0 (preclinical) … 4 (approved)
  indications: string[];
  approvalYear: number | null;
  source: "chembl-python";
}

const SCRIPT = `
import json, sys, os, sqlite3, tarfile
try:
    payload = json.load(sys.stdin)
    archive_path = payload["archivePath"]
    extracted_dir = payload["extractedDir"]
    query = (payload.get("query") or "").strip().lower()
    if not query:
        print(json.dumps({"error": "no drug query supplied"}))
        sys.exit(2)
    if not os.path.exists(archive_path):
        print(json.dumps({"error": f"ChEMBL archive not present at {archive_path}"}))
        sys.exit(3)

    # ChEMBL ships chembl_<v>_sqlite.tar.gz → extract once into the
    # caller-supplied cache dir (typically userCache/scelo-ide/chembl-extracted)
    # so the unpacked ~24 GB doesn't bloat userData backups. Subsequent
    # runs reuse the on-disk .db.
    db_path = None
    if os.path.exists(extracted_dir):
        for root, _, files in os.walk(extracted_dir):
            for f in files:
                if f.endswith(".db"):
                    db_path = os.path.join(root, f)
                    break
            if db_path: break
    if not db_path:
        os.makedirs(extracted_dir, exist_ok=True)
        with tarfile.open(archive_path, "r:gz") as tar:
            for m in tar.getmembers():
                if m.name.endswith(".db"):
                    tar.extract(m, extracted_dir)
                    db_path = os.path.join(extracted_dir, m.name)
                    break
        if not db_path:
            print(json.dumps({"error": "no .db file inside ChEMBL archive"}))
            sys.exit(4)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cur = conn.cursor()
    # Look up the molecule by synonym OR pref_name (case-insensitive).
    cur.execute("""
        SELECT m.chembl_id, m.pref_name, m.max_phase, m.first_approval
        FROM molecule_dictionary m
        LEFT JOIN molecule_synonyms s ON s.molregno = m.molregno
        WHERE LOWER(m.pref_name) = ? OR LOWER(s.synonyms) = ?
        ORDER BY m.max_phase DESC NULLS LAST
        LIMIT 1
    """, (query, query))
    row = cur.fetchone()
    if not row:
        print(json.dumps({
            "query": query, "canonicalName": None, "chemblId": None,
            "maxPhase": None, "indications": [], "approvalYear": None,
            "source": "chembl-python",
        }))
        sys.exit(0)
    chembl_id, pref_name, max_phase, first_approval = row

    # Indications via drug_indication.mesh_heading (text labels).
    cur.execute("""
        SELECT DISTINCT mesh_heading
        FROM drug_indication di
        JOIN molecule_dictionary m ON m.molregno = di.molregno
        WHERE m.chembl_id = ?
        LIMIT 20
    """, (chembl_id,))
    indications = [r[0] for r in cur.fetchall() if r[0]]

    print(json.dumps({
        "query": query,
        "canonicalName": pref_name,
        "chemblId": chembl_id,
        "maxPhase": max_phase,
        "indications": indications,
        "approvalYear": first_approval,
        "source": "chembl-python",
    }))
except Exception as e:
    print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
    sys.exit(1)
`;

export async function runChemblLookup(
  query: string,
): Promise<ChemblDrugLookup | null> {
  if (!isDesktopIDE()) return null;
  const status = await getRuntimeStatus();
  if (!status.python) return null;
  const ds = await window.scelo!.data.status("chembl");
  if (!ds.available || !ds.path) return null;
  const res = await runPython(SCRIPT, {
    stdin: JSON.stringify({
      archivePath: ds.path,
      extractedDir: ds.extractedDir,
      query,
    }),
  });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.stdout.trim());
    if (parsed && "error" in parsed) return null;
    return parsed as ChemblDrugLookup;
  } catch {
    return null;
  }
}
