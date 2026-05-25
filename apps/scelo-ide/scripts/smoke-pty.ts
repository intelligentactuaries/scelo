// Cross-OS smoke for the PTY terminal path. Runs after `dist:<os>` in CI
// to verify that the bundled node-pty native module actually loaded on
// this platform and that a tiny shell session can echo back what we send.
//
// Why a separate script instead of an Electron-launched assertion: this
// runs in node, not Electron, so it depends only on the dist node_modules
// rebuilt by @electron/rebuild. The node import path bypasses the
// Electron preload but exercises the same binary that gets shipped — if
// THIS smoke passes, the IDE terminal will too.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  let pty: typeof import("@homebridge/node-pty-prebuilt-multiarch");
  try {
    pty = await import("@homebridge/node-pty-prebuilt-multiarch");
  } catch (err) {
    console.error("smoke-pty: node-pty failed to import:", err);
    console.error("  Did electron-builder rebuild it for this platform?");
    process.exit(1);
  }

  const isWin = process.platform === "win32";
  const shell = isWin
    ? "powershell.exe"
    : process.env.SHELL || "/bin/bash";
  // We print the marker then sleep so the shell is still alive when
  // node-pty drains its read buffer — without the trailing sleep the
  // close handler races the data handler and we miss the output. A
  // 0.5 s sleep is invisible in CI but reliable.
  const argv = isWin
    ? ["-NoLogo", "-Command", "Write-Output scelo-pty-smoke-ok; Start-Sleep -Milliseconds 500"]
    : ["-lc", "echo scelo-pty-smoke-ok; sleep 0.5"];

  console.log(`smoke-pty: spawning ${shell} ${argv.join(" ")}`);
  const term = pty.spawn(shell, argv, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });

  let output = "";
  let timer: NodeJS.Timeout | null = null;
  const settled = new Promise<void>((resolveOk, rejectFail) => {
    timer = setTimeout(() => {
      term.kill();
      rejectFail(new Error(`timeout — no marker after ${TIMEOUT_MS}ms; output so far: ${output.slice(-200)}`));
    }, TIMEOUT_MS);
    term.onData((d) => {
      output += d;
      if (process.env.SCELO_SMOKE_VERBOSE) {
        process.stderr.write(`[onData ${d.length}B] ${JSON.stringify(d.slice(0, 80))}\n`);
      }
      if (output.includes("scelo-pty-smoke-ok")) {
        if (timer) clearTimeout(timer);
        term.kill();
        resolveOk();
      }
    });
    term.onExit(({ exitCode }) => {
      if (timer) clearTimeout(timer);
      if (output.includes("scelo-pty-smoke-ok")) resolveOk();
      else rejectFail(new Error(`shell exited (${exitCode}) without expected output: ${output.slice(0, 200)}`));
    });
  });
  await settled;

  // Also verify resize doesn't crash — node-pty is the most common
  // failure point here on Windows ConPTY.
  const term2 = pty.spawn(shell, [isWin ? "-Command" : "-c", "sleep 1"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: process.env,
  });
  term2.resize(120, 40);
  term2.resize(40, 12);
  term2.kill();

  console.log("smoke-pty: ✓ spawn + echo + resize all OK");
}

// Tolerant entry point — log the error and exit nonzero so CI fails loud.
main().catch((err) => {
  console.error("smoke-pty: FAIL —", err.message ?? err);
  process.exit(1);
});
