// Cross-platform `bun run dev` — bun's Windows shell has no `&` background
// operator ("Background commands are not supported yet"), so the old
// `bun run dev:server & bun run dev:client` one-liner dies with exit 1 on
// Windows before either process starts. Spawn the two dev processes as
// siblings; when either exits, tear the other down and mirror the exit code.
//
// The commands are spawned DIRECTLY (no `bun run <script>` wrapper): on
// Windows, killing the wrapper orphans the real process underneath, which
// then squats the dev ports (vite holds 5190) and blocks the next start.
// Vite runs under node, matching its bin shebang. Its bin is resolved rather
// than hardcoded as node_modules/vite/bin/vite.js because, as a workspace of
// the Scelo repo, bun decides where vite lives (root node_modules, the
// isolated .bun store, or a per-app link) — don't assume.
// PORT and the rest of the environment pass through untouched.

import { dirname, join } from "node:path";

// vite's `exports` map hides bin/, so locate the package and step into it.
const viteBin = join(dirname(Bun.resolveSync("vite/package.json", import.meta.dir)), "bin/vite.js");

const specs: string[][] = [
  ["bun", "--watch", "src/server/index.ts"],
  ["node", viteBin],
];

const procs = specs.map((cmd) =>
  Bun.spawn(cmd, {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  }),
);

const firstExit = await Promise.race(procs.map((p) => p.exited));
for (const p of procs) {
  try {
    p.kill();
  } catch {
    // already gone
  }
}
process.exit(firstExit ?? 1);
