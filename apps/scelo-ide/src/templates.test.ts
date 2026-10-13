// The starter templates' R scripts find their workspace from their own path,
// however they are run. `make` and the editor's Run start them with Rscript,
// where sys.frame(1)$ofile does not exist (it is only set under source()),
// so a script that relied on it stopped before doing anything.
//
// Each script's head (everything up to its `here <-` line, its package loads
// left out) is run with Rscript from a scratch workspace, as make runs it,
// and must print that workspace's root.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEMPLATES = join(import.meta.dir, "..", "templates");

const scripts = readdirSync(TEMPLATES).flatMap((t) => {
  const dir = join(TEMPLATES, t, "r");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".R"))
      .map((f) => ({ name: `${t}/r/${f}`, file: f, src: readFileSync(join(dir, f), "utf8") }));
  } catch {
    return [];
  }
});

const hasRscript = spawnSync("Rscript", ["--version"]).status === 0;

// The Reserving starter end to end needs R's ChainLadder and Python's
// chainladder. SCELO_TEMPLATE_PYTHON names a python that has it (a venv's,
// say); R_LIBS_USER reaches R as usual.
const python = process.env.SCELO_TEMPLATE_PYTHON ?? "python";
const hasChainLadder =
  hasRscript &&
  spawnSync("Rscript", [
    "-e",
    'quit(status = if (requireNamespace("ChainLadder", quietly = TRUE)) 0 else 1)',
  ]).status === 0 &&
  spawnSync(python, ["-c", "import chainladder"]).status === 0;

describe("template R scripts", () => {
  test("none relies on sys.frame(1)$ofile alone", () => {
    for (const s of scripts) {
      if (!s.src.includes("here <- ")) continue;
      expect(s.src, s.name).toContain(
        'grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)',
      );
    }
  });

  test.skipIf(!hasRscript)(
    "each finds its workspace when run with Rscript, as make runs it",
    () => {
      let checked = 0;
      for (const s of scripts) {
        const at = s.src.indexOf("\nhere <- ");
        if (at < 0) continue;
        const head = s.src
          .slice(0, s.src.indexOf("\n", at + 1) + 1)
          .replace(/suppressPackageStartupMessages\(\{[\s\S]*?\}\)\n/, "");
        const root = realpathSync(mkdtempSync(join(tmpdir(), "scelo-template-")));
        try {
          mkdirSync(join(root, "r"));
          writeFileSync(join(root, "r", s.file), `${head}cat(here)\n`);
          const res = spawnSync("Rscript", ["--vanilla", `r/${s.file}`], {
            cwd: root,
            encoding: "utf8",
          });
          expect(res.stderr, s.name).toBe("");
          expect(res.stdout, s.name).toBe(root);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
        checked++;
      }
      expect(checked).toBe(3);
    },
  );
});

describe("the Reserving starter", () => {
  const dir = join(TEMPLATES, "reserving");

  test("reads Mack's totals by row name and seeds its bootstrap", () => {
    // By position, row 2 is Dev and row 3 Ultimate (ChainLadder 0.2.21).
    const r = readFileSync(join(dir, "r", "mack_raa.R"), "utf8");
    expect(r).toContain('totals["IBNR:", 1]');
    expect(r).toContain('totals["Mack S.E.:", 1]');
    expect(r).toMatch(/set\.seed\(\d+\)\nboot <- BootChainLadder/);
    // A 1x1 frame's .iloc[0] is a Series, which float() refuses under pandas 3.
    expect(readFileSync(join(dir, "python", "verify.py"), "utf8")).toContain(
      ".total_mack_std_err_.iloc[0, 0]",
    );
  });

  test.skipIf(!hasChainLadder)(
    "make prints the pinned RAA figures and the cross-check agrees",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "scelo-reserving-")));
      try {
        cpSync(dir, root, { recursive: true });
        const bin = process.env.SCELO_TEMPLATE_PYTHON ? dirname(python) : "";
        const res = spawnSync("make", [], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH },
        });
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout).toContain("Mack IBNR        :     52135.23");
        expect(res.stdout).toContain("Mack SE          :     26909.01");
        expect(res.stdout).toContain("|R - Py|  = 0.00");
        expect(res.stdout).toContain("Pinned regression IBNR=52135 : ok");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
