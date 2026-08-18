// lifelib integration — the manifest in @scelo/core, the notebook export
// and the three Python bridges must agree with each other and with the
// bundled-runtime pin. Two tiers:
//
//   1. Always: static consistency (pins, catalog ↔ manifest, notebook
//      shape, no fictional `from lifelib.libraries` imports anywhere).
//   2. Opt-in live run: when SCELO_LIFELIB_PYTHON points at an interpreter
//      that has lifelib + modelx (+ pandas, openpyxl, matplotlib,
//      scikit-learn) installed, the generated notebooks and the bridge
//      scripts are executed for real on the sample MP file. The IFRS 17 /
//      SCR / nested paths loop per policy (30–60 s each on 100 MPs), so
//      they additionally need SCELO_LIFELIB_SLOW=1.
//
//      SCELO_LIFELIB_PYTHON=/path/to/venv/bin/python SCELO_LIFELIB_SLOW=1 bun test lifelibNotebookExport
//
// A live failure means "the pinned lifelib does not run the code we ship",
// which is exactly the thing a lifelib bump must not slip past.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFELIB_LIBRARIES,
  LIFELIB_TARGETS,
  LIFELIB_VERSION,
  MODELX_VERSION,
  SAMPLE_BY_KEY,
  lifelibLibrary,
  lifelibProvenance,
} from "@scelo/core";
import { IFRS17_SCRIPT } from "./bridges/ifrs17CsmPython";
import { BASICTERM_SCRIPT } from "./bridges/lifelibBasicTermPython";
import { LIFELIB_PRELUDE } from "./bridges/lifelibPrelude";
import { SCR_SCRIPT, SCR_SUB_RISKS } from "./bridges/solvency2LifeScrPython";
import { buildLifelibNotebook, notebookCodeAsScript } from "./lifelibNotebookExport";
import { MODEL_CATALOG } from "./modelCatalog";
import { BRIDGED_MODEL_IDS } from "./modelRunner";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const REQ_IN = join(REPO_ROOT, "apps", "scelo-ide", "runtime", "python-requirements.in");

const sampleMp = () => SAMPLE_BY_KEY.get("lifelib-mp")!.build();

describe("lifelib manifest (@scelo/core) ↔ runtime pin", () => {
  test("LIFELIB_VERSION / MODELX_VERSION equal the bundled-runtime pins", () => {
    const req = readFileSync(REQ_IN, "utf8");
    expect(req).toContain(`lifelib==${LIFELIB_VERSION}`);
    expect(req).toContain(`modelx==${MODELX_VERSION}`);
  });

  test("every per-platform lock carries the same lifelib / modelx pins", () => {
    for (const os of ["linux", "macos", "windows"]) {
      const lock = join(REPO_ROOT, "apps", "scelo-ide", "runtime", `python-requirements-${os}.txt`);
      expect(existsSync(lock)).toBe(true);
      const txt = readFileSync(lock, "utf8");
      expect(txt).toMatch(new RegExp(`^lifelib==${LIFELIB_VERSION.replace(/\./g, "\\.")}$`, "m"));
      expect(txt).toMatch(new RegExp(`^modelx==${MODELX_VERSION.replace(/\./g, "\\.")}$`, "m"));
    }
  });

  test("every life-family catalog model has a lifelib target and vice versa", () => {
    const life = MODEL_CATALOG.filter((m) => m.family === "life").map((m) => m.id);
    for (const id of life) expect(LIFELIB_TARGETS[id]).toBeDefined();
    for (const id of Object.keys(LIFELIB_TARGETS)) expect(life).toContain(id);
  });

  test("catalog descriptions name the same library the manifest targets", () => {
    for (const [id, t] of Object.entries(LIFELIB_TARGETS)) {
      const cat = MODEL_CATALOG.find((m) => m.id === id)!;
      expect(cat.description).toContain(`Lifelib → ${t.library}`);
    }
  });

  test("every target's library exists in LIFELIB_LIBRARIES with a matching status", () => {
    for (const t of Object.values(LIFELIB_TARGETS)) {
      const lib = lifelibLibrary(t.library);
      expect(lib).not.toBeNull();
      expect(lib!.status).toBe(t.status);
      if (t.status === "legacy") {
        expect(lib!.deprecatedIn).toBeDefined();
      }
    }
  });

  test("the 0.12–0.14 additions are listed", () => {
    const ids = LIFELIB_LIBRARIES.map((l) => l.id);
    expect(ids).toContain("annuallife");
    expect(ids).toContain("uslib");
    expect(ids).toContain("ifrs17a");
    expect(lifelibLibrary("solvency2")!.status).toBe("legacy");
    expect(lifelibLibrary("simplelife")!.status).toBe("legacy");
    expect(LIFELIB_TARGETS["solvency2-life"].library).toBe("annuallife");
  });

  test("provenance string names version, library, model and legacy status", () => {
    expect(lifelibProvenance("basicterm-projection")).toBe(
      `lifelib ${LIFELIB_VERSION} · basiclife / BasicTerm_ME`,
    );
    expect(lifelibProvenance("ifrs17-csm")).toContain("(legacy)");
  });

  test("the three lifelib bridges are wired into runModelAsync", () => {
    for (const id of ["basicterm-projection", "ifrs17-csm", "solvency2-life"]) {
      expect(BRIDGED_MODEL_IDS.has(id)).toBe(true);
    }
  });
});

describe("no Python path uses the fictional lifelib API", () => {
  const scripts: Record<string, string> = {
    prelude: LIFELIB_PRELUDE,
    basicterm: BASICTERM_SCRIPT,
    ifrs17: IFRS17_SCRIPT,
    scr: SCR_SCRIPT,
  };
  for (const id of Object.keys(LIFELIB_TARGETS)) {
    scripts[`notebook:${id}`] = notebookCodeAsScript(buildLifelibNotebook(id, sampleMp()));
  }
  for (const [name, src] of Object.entries(scripts)) {
    test(`${name} reads models with modelx, never imports lifelib.libraries`, () => {
      expect(src).not.toContain("from lifelib.libraries");
      expect(src).not.toMatch(/proj = lifelib\.create/);
      // cluster / economic_curves are notebook- and script-shaped libraries
      // (no modelx model to read); everything else must go through modelx.
      const scriptOnly = name.endsWith("cluster-modelpoints") || name.endsWith("economic-curves");
      if (name !== "prelude" && !scriptOnly) expect(src).toMatch(/mx\.read_model|lifelib_model\(/);
    });
  }

  test("bridge scripts inject the pinned versions and emit provenance", () => {
    for (const src of [BASICTERM_SCRIPT, IFRS17_SCRIPT, SCR_SCRIPT]) {
      expect(src).toContain(`EXPECTED_LIFELIB = "${LIFELIB_VERSION}"`);
      expect(src).toContain(`EXPECTED_MODELX = "${MODELX_VERSION}"`);
      expect(src).toContain("emit(");
    }
  });
});

describe("notebook export", () => {
  test("builds for every lifelib model, pins the install and embeds the MP file", () => {
    const ds = sampleMp();
    for (const id of Object.keys(LIFELIB_TARGETS)) {
      const nb = JSON.parse(buildLifelibNotebook(id, ds));
      const src = nb.cells.map((c: { source: string[] }) => c.source.join("")).join("\n");
      expect(src).toContain(`lifelib==${LIFELIB_VERSION}`);
      expect(src).toContain(`modelx==${MODELX_VERSION}`);
      expect(src).toContain("lifelib.create(");
      if (id !== "cluster-modelpoints" && id !== "economic-curves") {
        expect(src).toContain("mx.read_model(");
      }
      expect(src).toContain("policy_id,age_at_entry,sex"); // CSV header
      expect(nb.metadata.scelo.lifelib).toBe(LIFELIB_VERSION);
      expect(nb.metadata.scelo.library).toBe(LIFELIB_TARGETS[id].library);
      if (LIFELIB_TARGETS[id].status === "legacy") {
        expect(src).toContain("Legacy library");
      }
    }
  });

  test("builds without a dataset (empty frame stub)", () => {
    const nb = buildLifelibNotebook("basicterm-projection", null);
    expect(nb).toContain("No MP file attached");
  });

  test("throws for a non-lifelib model", () => {
    expect(() => buildLifelibNotebook("chain-ladder", null)).toThrow();
  });
});

// ─── Live tier ────────────────────────────────────────────────────────────

const PY = process.env.SCELO_LIFELIB_PYTHON;
const SLOW = process.env.SCELO_LIFELIB_SLOW === "1";
const live = PY && existsSync(PY) ? describe : describe.skip;

function runPython(args: string[], opts: { cwd?: string; stdin?: string }) {
  return spawnSync(PY!, args, {
    cwd: opts.cwd,
    input: opts.stdin,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: {
      ...process.env,
      MPLBACKEND: "Agg",
      SCELO_LIFELIB_HOME: join(tmpdir(), "scelo-lifelib-test"),
    },
  });
}

live("live · pinned lifelib runs what Scelo ships", () => {
  const dir = mkdtempSync(join(tmpdir(), "scelo-nb-"));
  const ds = sampleMp();
  const payload = JSON.stringify({ name: ds.name, columns: ds.columns, rows: ds.rows });

  test("interpreter has the pinned lifelib / modelx", () => {
    const r = runPython(
      ["-c", "import lifelib, modelx; print(lifelib.__version__, modelx.__version__)"],
      {},
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${LIFELIB_VERSION} ${MODELX_VERSION}`);
  });

  const fast = [
    "basicterm-projection",
    "cashvalue-savings",
    "smithwilson-curve",
    "cluster-modelpoints",
    "economic-curves",
  ];
  const slow = ["solvency2-life", "ifrs17-csm", "nested-stochastic"];
  for (const id of [...fast, ...(SLOW ? slow : [])]) {
    test(`notebook ${id} executes end to end`, () => {
      const script = notebookCodeAsScript(buildLifelibNotebook(id, ds));
      const file = join(dir, `${id}.py`);
      writeFileSync(file, script);
      const r = runPython([file], { cwd: dir });
      if (r.status !== 0) console.error(r.stderr.slice(-3000));
      expect(r.status).toBe(0);
    }, 240_000);
  }

  test("BasicTerm bridge projects the sample MP with the file's premiums", () => {
    const r = runPython(["-c", BASICTERM_SCRIPT], { stdin: payload });
    if (r.status !== 0) console.error(r.stdout, r.stderr.slice(-2000));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.lifelibVersion).toBe(LIFELIB_VERSION);
    expect(out.model).toBe("basiclife/BasicTerm_ME");
    expect(out.premiumSource).toBe("model-point-file");
    expect(out.modelPointsUsed).toBe(100);
    expect(out.monthly.length).toBeGreaterThan(120);
    // Sample premiums are deliberately under-priced against lifelib's
    // mortality: PV(net CF) is negative and premiums < claims.
    expect(out.pvNetCf).toBeLessThan(0);
    expect(out.totalPremiums).toBeLessThan(out.totalClaims);
    // Notebook and bridge are the same computation.
    const nbScript = notebookCodeAsScript(buildLifelibNotebook("basicterm-projection", ds));
    const nbFile = join(dir, "basicterm-check.py");
    writeFileSync(nbFile, `${nbScript}\nprint("PVNET", result["PV Net Cashflow"].sum())`);
    const nb = runPython([nbFile], { cwd: dir });
    const pv = Number(/PVNET (\S+)/.exec(nb.stdout)?.[1]);
    expect(Math.abs(pv - out.pvNetCf)).toBeLessThan(1);
  }, 120_000);

  test("BasicTerm bridge drops MPs outside lifelib's premium table when the file has no premium_pp", () => {
    const noPrem = { ...ds, columns: ds.columns.filter((c) => c !== "premium_pp") };
    const r = runPython(["-c", BASICTERM_SCRIPT], {
      stdin: JSON.stringify({
        name: noPrem.name,
        columns: noPrem.columns,
        rows: ds.rows.map((row) => {
          const { premium_pp: _p, ...rest } = row as Record<string, unknown>;
          return rest;
        }),
      }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.premiumSource).toBe("lifelib-premium-table");
    // ages 25–65 × terms 10–30 in the sample; the table covers 20–59 × {10,15,20}
    expect(out.modelPointsUnpriced).toBeGreaterThan(0);
    expect(out.modelPointsUsed + out.modelPointsUnpriced).toBe(100);
  }, 120_000);

  test("bridges report a clean error on an unusable file", () => {
    const r = runPython(["-c", BASICTERM_SCRIPT], {
      stdin: JSON.stringify({ name: "x", columns: ["a"], rows: [{ a: 1 }] }),
    });
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error).toContain("age_at_entry");
  }, 60_000);

  if (SLOW) {
    test("Solvency II SCR bridge runs TradLife_A_EX1 and agrees with the notebook", () => {
      const r = runPython(["-c", SCR_SCRIPT], { stdin: payload });
      if (r.status !== 0) console.error(r.stdout, r.stderr.slice(-2000));
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.model).toBe("annuallife/TradLife_A_EX1");
      expect(out.modelPointsUsed).toBeGreaterThan(0);
      for (const k of SCR_SUB_RISKS) expect(typeof out.subs[k]).toBe("number");
      expect(out.correlation.length).toBe(SCR_SUB_RISKS.length);
      expect(out.scrLife).toBeGreaterThan(0);
      // Term business: no longevity / disability / revision / CAT charge in the model.
      expect(out.subs.mortality).toBeGreaterThan(0);
      expect(out.subs.lapse).toBeGreaterThan(0);
      if (out.modelPointsUsed === 100) {
        const nbScript = notebookCodeAsScript(buildLifelibNotebook("solvency2-life", ds));
        const nbFile = join(dir, "scr-check.py");
        writeFileSync(nbFile, `${nbScript}\nprint("SCR", scr_life)`);
        const nb = runPython([nbFile], { cwd: dir });
        const scr = Number(/SCR (\S+)/.exec(nb.stdout)?.[1]);
        expect(Math.abs(scr - out.scrLife) / out.scrLife).toBeLessThan(1e-6);
      }
    }, 300_000);

    test("IFRS 17 bridge runs ifrs17sim and reports the RA stub honestly", () => {
      const r = runPython(["-c", IFRS17_SCRIPT], { stdin: payload });
      if (r.status !== 0) console.error(r.stdout, r.stderr.slice(-2000));
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.libraryStatus).toBe("legacy");
      expect(out.successor).toBe("ifrs17a");
      expect(out.riskAdjustment).toBe(0);
      expect(out.csm0).toBeGreaterThan(0);
      expect(out.balance[0]).toBeCloseTo(out.csm0, 3);
      expect(out.release.length).toBe(out.years);
      expect(out.modelPointsUsed).toBeGreaterThan(0);
    }, 300_000);
  }
});
