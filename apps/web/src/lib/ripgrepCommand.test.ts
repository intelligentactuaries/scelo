// Quick Open's and Search's ripgrep command, for the shell each platform's
// terminal runs: PowerShell on Windows, bash or zsh elsewhere. The Windows
// cases run on every OS.

import { describe, expect, test } from "bun:test";
import { ripgrepCommand, shellQuote, workspaceRelative } from "./ripgrepCommand";

describe("shellQuote", () => {
  test("POSIX closes the quote around an apostrophe", () => {
    expect(shellQuote("o'brien", false)).toBe(`'o'\\''brien'`);
  });
  test("PowerShell doubles it, and leaves backslashes alone", () => {
    expect(shellQuote("C:\\Users\\o'brien\\Scelo QA", true)).toBe(
      `'C:\\Users\\o''brien\\Scelo QA'`,
    );
  });
});

describe("ripgrepCommand", () => {
  const args = ["--files", { quoted: "--glob=!.git" }, { quoted: "/home/me/my work" }];

  test("POSIX: the program quoted, globs and paths quoted", () => {
    expect(ripgrepCommand("/opt/scelo/rg", args, false)).toBe(
      `'/opt/scelo/rg' --files '--glob=!.git' '/home/me/my work'`,
    );
  });

  test("Windows: PowerShell's call operator, and forward slashes back", () => {
    const rg =
      "C:\\Users\\me\\AppData\\Local\\Programs\\scelo-ide\\resources\\app.asar.unpacked\\rg.exe";
    expect(
      ripgrepCommand(
        rg,
        ["--files", { quoted: "--glob=!.git" }, { quoted: "C:\\Users\\me\\My Work" }],
        true,
      ),
    ).toBe(`& '${rg}' --path-separator / --files '--glob=!.git' 'C:\\Users\\me\\My Work'`);
  });

  test("without a bundled rg, the one on PATH", () => {
    expect(ripgrepCommand(null, ["--files"], false)).toBe("rg --files");
    expect(ripgrepCommand(null, ["--files"], true)).toBe("rg --path-separator / --files");
  });
});

describe("workspaceRelative", () => {
  test("POSIX", () => {
    expect(workspaceRelative("/home/me/ws/r/mack.R", "/home/me/ws", false)).toBe("r/mack.R");
    expect(workspaceRelative("/home/me/ws/r/mack.R", "/home/me/ws/", false)).toBe("r/mack.R");
    expect(workspaceRelative("/elsewhere/x.R", "/home/me/ws", false)).toBe("/elsewhere/x.R");
  });

  test("Windows: rg's forward slashes against a backslash workspace, any case, CRLF", () => {
    const ws = "C:\\Users\\me\\Documents\\Scelo QA\\reserving";
    expect(
      workspaceRelative("C:/Users/me/Documents/Scelo QA/reserving/r/mack_raa.R", ws, true),
    ).toBe("r/mack_raa.R");
    expect(
      workspaceRelative("c:/users/me/documents/scelo qa/reserving/python/verify.py\r", ws, true),
    ).toBe("python/verify.py");
    expect(
      workspaceRelative("C:\\Users\\me\\Documents\\Scelo QA\\reserving\\README.md", ws, true),
    ).toBe("README.md");
  });
});
