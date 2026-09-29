import { describe, expect, test } from "bun:test";
import { bridgeFailureReason } from "./sceloIDE";

describe("bridgeFailureReason", () => {
  test("prefers the script's structured error on stdout", () => {
    // The reported shape: the bridge prints {"error": …} to STDOUT and exits
    // 1, while stderr holds only an unrelated warning (or nothing at all).
    expect(
      bridgeFailureReason({
        stdout: '{"error": "ModuleNotFoundError: No module named \'statsmodels\'"}\n',
        stderr: "FutureWarning: something unrelated\n",
        exitCode: 1,
      }),
    ).toBe("ModuleNotFoundError: No module named 'statsmodels'");
  });

  test("reads the last stdout line when a script printed progress first", () => {
    expect(
      bridgeFailureReason({
        stdout: 'loading…\n{"error": "ValueError: triangle has no observed cells"}',
        stderr: "",
        exitCode: 1,
      }),
    ).toBe("ValueError: triangle has no observed cells");
  });

  test("falls back to the last stderr line, then the exit code", () => {
    expect(
      bridgeFailureReason({
        stdout: "",
        stderr: "Traceback (most recent call last):\n  File \"x\"\nKeyError: 'paid'\n",
        exitCode: 1,
      }),
    ).toBe("KeyError: 'paid'");
    expect(bridgeFailureReason({ stdout: "not json", stderr: "", exitCode: 3 })).toBe(
      "python exited with code 3",
    );
  });
});
