// Cross-platform `bun run dev` — bun's Windows shell has no `&` background
// operator ("Background commands are not supported yet"), so the old
// `bun run dev:server & bun run dev:client` one-liner dies with exit 1 on
// Windows before either process starts. Spawn the two dev processes as
// siblings; when either exits, tear the other down and mirror the exit code.
//
// The commands are spawned DIRECTLY (no `bun run <script>` wrapper): on
// Windows, killing the wrapper orphans the real process underneath, which
// then squats the dev ports (vite holds 5190) and blocks the next start.
// Vite runs under node, matching its bin shebang. PORT and the rest of the
// environment pass through untouched.

const specs: string[][] = [
  ["bun", "--watch", "src/server/index.ts"],
  ["node", "node_modules/vite/bin/vite.js"],
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
