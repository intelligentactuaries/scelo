// The terminal PATH, the bundled ripgrep and the sample-workspace copy, on every OS: the Windows
// cases pass "win32" explicitly so a change on Linux cannot quietly break them.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, prependPath, ripgrepBinary, withPathPrepended } from "./tools";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "scelo-tools-"));
  dirs.push(d);
  return d;
}

describe("withPathPrepended", () => {
  test("Windows: the dirs join the Path the app was started with; no second PATH appears", () => {
    const env = {
      ALLUSERSPROFILE: "C:\\ProgramData",
      Path: "C:\\Windows;C:\\Windows\\System32",
      SCELO_IDE: "1",
    };
    const out = withPathPrepended(env, ["C:\\a\\python", "C:\\a\\tui"], true);
    expect(out.Path).toBe("C:\\a\\python;C:\\a\\tui;C:\\Windows;C:\\Windows\\System32");
    expect(Object.keys(out).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(Object.keys(out)).toEqual(Object.keys(env));
  });
  test("Windows: of two spellings the first, the one Windows reads, is kept", () => {
    const out = withPathPrepended(
      { Path: "C:\\Windows", PATH: "C:\\elsewhere" },
      ["C:\\a\\tui"],
      true,
    );
    expect(out).toEqual({ Path: "C:\\a\\tui;C:\\Windows" });
  });
  test("Windows with no path at all, and POSIX", () => {
    expect(withPathPrepended({}, ["C:\\a\\tui"], true)).toEqual({ Path: "C:\\a\\tui" });
    expect(withPathPrepended({ PATH: "/usr/bin", Path: "kept" }, ["/a/tui"], false)).toEqual({
      PATH: "/a/tui:/usr/bin",
      Path: "kept",
    });
  });
  test("nothing to add: the environment as it was", () => {
    const env = { Path: "C:\\Windows" };
    expect(withPathPrepended(env, [], true)).toBe(env);
  });
});

describe("prependPath", () => {
  test("in front, once, with the platform's separator", () => {
    expect(prependPath("/usr/bin:/a/tui:/bin", ["/a/py/bin", "/a/tui"], false)).toBe(
      "/a/py/bin:/a/tui:/usr/bin:/bin",
    );
    expect(prependPath(undefined, ["C:\\a\\tui"], true)).toBe("C:\\a\\tui");
    expect(prependPath("C:\\Windows", ["C:\\a\\tui"], true)).toBe("C:\\a\\tui;C:\\Windows");
  });
});

describe("ripgrepBinary", () => {
  test("Windows: the unpacked rg.exe, not the one inside app.asar", () => {
    const inAsar =
      "C:\\Program Files\\Scelo IDE\\resources\\app.asar\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe";
    const unpacked =
      "C:\\Program Files\\Scelo IDE\\resources\\app.asar.unpacked\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe";
    const asked: string[] = [];
    const rg = ripgrepBinary({
      platform: "win32",
      arch: "x64",
      resolve: (r) => {
        asked.push(r);
        return inAsar;
      },
      exists: (p) => p === unpacked || p === inAsar,
    });
    expect(asked).toEqual(["@vscode/ripgrep-win32-x64/bin/rg.exe"]);
    expect(rg).toBe(unpacked);
  });

  test("Linux and macOS: rg, unpacked from the asar the same way", () => {
    const inAsar =
      "/opt/Scelo IDE/resources/app.asar/node_modules/@vscode/ripgrep-linux-x64/bin/rg";
    const unpacked =
      "/opt/Scelo IDE/resources/app.asar.unpacked/node_modules/@vscode/ripgrep-linux-x64/bin/rg";
    expect(
      ripgrepBinary({
        platform: "linux",
        arch: "x64",
        resolve: () => inAsar,
        exists: (p) => p === unpacked,
      }),
    ).toBe(unpacked);
    expect(
      ripgrepBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: (r) => `/repo/node_modules/${r}`,
        exists: () => true,
      }),
    ).toBe("/repo/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg");
  });

  test("null when the platform package is missing or its binary is not on disk", () => {
    const missing = () => {
      throw new Error("Cannot find module");
    };
    expect(
      ripgrepBinary({ platform: "win32", arch: "arm64", resolve: missing, exists: () => true }),
    ).toBeNull();
    expect(
      ripgrepBinary({
        platform: "linux",
        arch: "x64",
        resolve: () => "/x/rg",
        exists: () => false,
      }),
    ).toBeNull();
  });
});

describe("copyTree", () => {
  test("copies files and nested folders byte for byte", () => {
    const src = tmp();
    mkdirSync(join(src, "python", "actuarial"), { recursive: true });
    writeFileSync(join(src, "README.md"), "# Reserving\r\n");
    writeFileSync(join(src, "python", "actuarial", "fm.py"), "x = 1\n");
    writeFileSync(join(src, "python", "data.bin"), Buffer.from([0, 255, 13, 10]));
    const dest = join(tmp(), "reserving");
    copyTree(src, dest);
    expect(readdirSync(dest).sort()).toEqual(["README.md", "python"]);
    expect(readFileSync(join(dest, "README.md"), "utf8")).toBe("# Reserving\r\n");
    expect(readFileSync(join(dest, "python", "actuarial", "fm.py"), "utf8")).toBe("x = 1\n");
    expect([...readFileSync(join(dest, "python", "data.bin"))]).toEqual([0, 255, 13, 10]);
  });
});
