// One-shot migration: between Phase 12 and Phase 13 the ChEMBL bridge
// extracted next to the .tar.gz archive (`<file>.extracted/`). Phase 13
// moved this to `userData/extracted/<id>/`. Older installs need their
// existing extraction moved to the new location so we don't trigger a
// second 24 GB unpack on first launch after upgrade.
//
// Run via `runOnce(ctx, "extracted-dir-v1", migrateExtractedDir)` from
// the startup migration runner. Per-dataset failure is logged but
// non-fatal — the ChEMBL bridge will simply re-extract on demand.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { MigrationContext } from "./markers";

export interface DatasetForMigration {
  id: string;
  /** Absolute path to the archive itself (e.g. userData/chembl_34_sqlite.tar.gz). */
  archivePath: string;
  /** Absolute path to the destination extraction directory. */
  destDir: string;
}

export function migrateExtractedDir(
  ctx: MigrationContext,
  datasets: DatasetForMigration[],
): void {
  for (const spec of datasets) {
    try {
      const legacy = `${spec.archivePath}.extracted`;
      if (!existsSync(legacy)) continue;
      if (existsSync(spec.destDir)) {
        // Already migrated under the new path layout — leave the
        // legacy entry alone so the user can inspect it before
        // manually purging.
        ctx.log.info(
          `migration[extracted-dir]: ${spec.id} already has new-style ${spec.destDir}; skipping`,
        );
        continue;
      }
      ctx.log.info(`migration[extracted-dir]: ${spec.id} ${legacy} → ${spec.destDir}`);
      mkdirSync(join(spec.destDir, ".."), { recursive: true });
      renameSync(legacy, spec.destDir);
    } catch (e) {
      ctx.log.warn(`migration[extracted-dir]: ${spec.id} failed`, e);
    }
  }
}
