// Compile node-pty against the Electron this app ships, then prove it loads.
//
// @homebridge/node-pty-prebuilt-multiarch's npm tarball carries Node-ABI
// prebuilds for Linux only, and its Electron prebuilds on GitHub stop at ABI
// 121 (Electron 29). Under Electron 33 its loader finds no
// prebuilds/<os>-<arch>/electron.abi130.node, falls through to
// build/Release/pty.node — absent — and the IDE terminal quietly drops to the
// PTY-less spawn fallback. Every 0.1.x installer shipped like that.
//
// This runs node-gyp against this Electron's headers inside the package, so
// build/Release holds pty.node (plus spawn-helper on macOS, which
// unixTerminal.js looks for there); electron-builder carries it into
// app.asar.unpacked with the rest of the package (asarUnpack). Object files
// are pruned so only the binaries ship. A stamp makes a re-run a no-op.
//
// Needs Python 3 and a C++ toolchain (build-essential / Xcode CLT). Not wired
// into dist:win: node-gyp there needs the VS C++ workload and has failed on
// long, space-containing paths (see npmRebuild in electron-builder.yml). It
// can be run there by hand (`bun run build:pty`) on a machine that has them.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const electronBin = require("electron"); // from Node, the binary's path
const ptyDir = dirname(require.resolve("@homebridge/node-pty-prebuilt-multiarch/package.json"));
const arch = process.env.npm_config_arch || process.arch;
const buildDir = join(ptyDir, "build");
const release = join(buildDir, "Release");
const stampFile = join(release, ".scelo-electron");
const stamp = `electron ${electronVersion} ${process.platform}-${arch}`;

const env = { ...process.env };
delete env.PYTHONPATH; // gyp is Python; a foreign toolchain's path must not leak in

const built =
  existsSync(join(release, "pty.node")) &&
  existsSync(stampFile) &&
  readFileSync(stampFile, "utf8").trim() === stamp;

if (built) {
  console.log(`node-pty: already built for ${stamp}`);
} else {
  console.log(`node-pty: building for ${stamp}\n  in ${ptyDir}`);
  execFileSync(
    "npx",
    [
      "--yes",
      "node-gyp@10",
      "rebuild",
      `--target=${electronVersion}`,
      `--arch=${arch}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    { cwd: ptyDir, stdio: "inherit", env, shell: process.platform === "win32" },
  );
  // Ship the binaries, not the build tree: the .node modules (pty.node; on
  // Windows also conpty.node and conpty_console_list.node), spawn-helper on
  // macOS, winpty-agent.exe and winpty.dll on Windows.
  for (const name of readdirSync(buildDir)) {
    if (name !== "Release") rmSync(join(buildDir, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(release)) {
    if (!/\.(node|exe|dll)$/.test(name) && name !== "spawn-helper") {
      rmSync(join(release, name), { recursive: true, force: true });
    }
  }
  writeFileSync(stampFile, `${stamp}\n`);
}

// Prove it: load the package inside this Electron and read a shell's echo
// back through a real pseudo-terminal.
const probe = `
const pty = require(${JSON.stringify(ptyDir)});
const win = process.platform === "win32";
const t = pty.spawn(win ? "cmd.exe" : "/bin/sh",
  win ? ["/c", "echo scelo-pty-ok"] : ["-c", "echo scelo-pty-ok; sleep 0.3"],
  { name: "xterm-256color", cols: 80, rows: 24 });
let out = "";
const timer = setTimeout(() => { console.error("no echo through the PTY: " + JSON.stringify(out)); process.exit(1); }, 8000);
t.onData((d) => {
  out += d;
  if (out.includes("scelo-pty-ok")) {
    clearTimeout(timer);
    console.log("node-pty: a real PTY works under Electron " + process.versions.electron);
    process.exit(0);
  }
});
`;
execFileSync(electronBin, ["-e", probe], {
  stdio: "inherit",
  env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
});
