// Shared marker-file convention for one-shot migrations.
//
// A one-shot migration runs at most once per install. We record
// completion as a 0-byte (well, ISO-timestamped) file under userData
// named `.migration-<id>-done`. Subsequent launches see the marker
// and skip. Bumping a migration's id (e.g. `extracted-dir-v2`) is the
// way to re-run something after a schema reshape.
//
// Data-migrations (in-process, on-read, e.g. workspaceState v0 → v1)
// don't need markers — they run every time the data is read and are
// idempotent.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationContext {
  /** Per-install state directory — typically `app.getPath("userData")`. */
  userDataDir: string;
  /** Per-install log channel — typically `electron-log`'s main logger. */
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/** Run `fn` exactly once across the lifetime of this install, gated by
 *  a marker file under `userData/.migration-<id>-done`. Idempotent;
 *  failures are logged but do not throw — the IDE should still boot
 *  even if a migration is broken on this user's data. */
export function runOnce(
  ctx: MigrationContext,
  id: string,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const marker = join(ctx.userDataDir, `.migration-${id}-done`);
  if (existsSync(marker)) return;
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      return (r as Promise<void>)
        .then(() => writeMarker(marker, ctx))
        .catch((e) => ctx.log.warn(`migration[${id}]: failed`, e));
    }
    writeMarker(marker, ctx);
  } catch (e) {
    ctx.log.warn(`migration[${id}]: failed`, e);
  }
}

function writeMarker(marker: string, ctx: MigrationContext): void {
  try {
    writeFileSync(marker, new Date().toISOString(), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (e) {
    ctx.log.warn("migration: failed to write completion marker", e);
  }
}
