// Migration registry for the Scelo IDE main process.
//
// Two flavours live here:
//   * One-shot startup migrations (`runStartupMigrations`) — run via
//     the marker convention in `./markers`. Use these when the
//     migration is destructive (renames, deletions, schema reshapes
//     on disk).
//   * Data migrations (`./workspaceState`, etc.) — pure functions
//     called inline from IPC handlers. Use these when the
//     transformation is cheap + idempotent (e.g. shape upgrades on
//     read).
//
// Adding a new startup migration:
//   1. New file under `./` exporting a `(ctx, ...) => void` function.
//   2. Add a `runOnce(ctx, "<id>", () => ...)` entry below.
//   3. Use a new id (e.g. `<area>-v2`) so existing installs re-run it.

import { migrateExtractedDir, type DatasetForMigration } from "./extractedDir";
import type { MigrationContext } from "./markers";
import { runOnce } from "./markers";

export {
  migrateWorkspaceStateToV1,
  type WorkspaceUIState,
} from "./workspaceState";
export { runOnce } from "./markers";
export type { MigrationContext } from "./markers";

export function runStartupMigrations(
  ctx: MigrationContext,
  opts: { datasetsForExtractedDirMigration: DatasetForMigration[] },
): void {
  runOnce(ctx, "extracted-dir-v1", () => {
    migrateExtractedDir(ctx, opts.datasetsForExtractedDirMigration);
  });
}
