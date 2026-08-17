// Tests the swarm start command — the copy the offline fallback (and
// the simulate modal's error hint) shows must be pasteable into the
// user's actual shell, on every OS.
import { describe, expect, test } from "bun:test";
import { SWARM_DOCS_URL, SWARM_START_COMMAND, swarmStartCommand } from "./SwarmPanel";

describe("swarmStartCommand", () => {
  test("is the repo-root script, identical on every OS / shell", () => {
    expect(swarmStartCommand()).toBe("bun run dev:swarm");
    expect(swarmStartCommand()).toBe(SWARM_START_COMMAND);
  });

  test("carries no shell-specific env-var prefix (PORT defaults to 3010 in apps/swarm)", () => {
    expect(swarmStartCommand()).not.toMatch(/PORT=|\$env:/);
  });
});

test("docs link points at the swarm/running page under the /scelo/ hub", () => {
  expect(SWARM_DOCS_URL).toContain("/scelo/swarm/running");
});
