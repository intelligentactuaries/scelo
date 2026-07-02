// Tests the platform fork of the swarm start command — the copy the
// offline fallback (and the simulate modal's error hint) shows must be
// pasteable into the user's actual shell.
import { describe, expect, test } from "bun:test";
import { SWARM_DOCS_URL, swarmStartCommand } from "./SwarmPanel";

describe("swarmStartCommand", () => {
  test("PowerShell variant on Windows (no VAR=x prefix syntax there)", () => {
    expect(swarmStartCommand(true)).toBe("$env:PORT=3010; bun run dev");
  });

  test("POSIX variant elsewhere", () => {
    expect(swarmStartCommand(false)).toBe("PORT=3010 bun run dev");
  });

  test("auto-detection always yields one of the two known variants", () => {
    expect(["$env:PORT=3010; bun run dev", "PORT=3010 bun run dev"]).toContain(swarmStartCommand());
  });
});

test("docs link points at the swarm/running page under the /scelo/ hub", () => {
  expect(SWARM_DOCS_URL).toContain("/scelo/swarm/running");
});
