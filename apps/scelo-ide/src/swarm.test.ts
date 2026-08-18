// Swarm supervisor — the decisions it makes without a real bundle: adopting a
// server that already answers, refusing to fight over the port, and giving the
// spawned server a PATH that reaches claude / ollama.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmSupervisor, augmentedPath } from "./swarm";

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe("augmentedPath", () => {
  test("keeps the inherited PATH first and appends the usual homes once", () => {
    const p = augmentedPath("/usr/bin:/bin", false);
    const parts = p.split(":");
    expect(parts[0]).toBe("/usr/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts.filter((x) => x === "/usr/bin").length).toBe(1);
    expect(parts.some((x) => x.endsWith("/.local/bin"))).toBe(true);
  });
  test("windows uses ; and the Ollama / bun homes", () => {
    const p = augmentedPath("C:\\Windows", true);
    expect(p.split(";")[0]).toBe("C:\\Windows");
    expect(p).toContain("Ollama");
  });
});

describe("SwarmSupervisor", () => {
  const dirs: string[] = [];
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "scelo-swarm-test-"));
    dirs.push(d);
    return d;
  }

  test("adopts a server that already answers /api/health, and points the UI at Vite when the API origin has no HTML", async () => {
    // A stand-in for a developer's `bun run dev:swarm` API on some port.
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/health") return Response.json({ ok: true, time: Date.now() });
        return new Response("not found", { status: 404 });
      },
    });
    servers.push({ stop: () => fake.stop(true) });
    const sup = new SwarmSupervisor({
      resourceDir: tmp(),
      repoRoot: null,
      userDataDir: tmp(),
      isPackaged: true,
      isWin: false,
      log: quiet,
      defaultPort: fake.port,
      devUiPort: 59190,
    });
    const st = await sup.start();
    expect(st.state).toBe("external");
    expect(st.managed).toBe(false);
    expect(st.apiUrl).toBe(`http://127.0.0.1:${fake.port}`);
    expect(sup.endpoints().ui).toBe("http://127.0.0.1:59190");
    // restart is a no-op for an adopted server
    const again = await sup.restart();
    expect(again.state).toBe("external");
  });

  test("adopts a same-origin server (API + HTML) with ui === api", async () => {
    const fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/health") return Response.json({ ok: true });
        return new Response("<!doctype html><title>swarm</title>", { headers: { "content-type": "text/html" } });
      },
    });
    servers.push({ stop: () => fake.stop(true) });
    const sup = new SwarmSupervisor({
      resourceDir: tmp(),
      repoRoot: null,
      userDataDir: tmp(),
      isPackaged: true,
      isWin: false,
      log: quiet,
      defaultPort: fake.port,
    });
    await sup.start();
    expect(sup.endpoints().ui).toBe(sup.endpoints().api);
  });

  test("with no bundle and no checkout it reports a clear error rather than spawning nothing silently", async () => {
    const sup = new SwarmSupervisor({
      resourceDir: tmp(),
      repoRoot: null,
      userDataDir: tmp(),
      isPackaged: true,
      isWin: false,
      log: quiet,
      defaultPort: 0, // never "already healthy"; 0 → we ask for a free port
    });
    const st = await sup.start();
    expect(st.state).toBe("error");
    expect(st.error).toContain("swarm server not found");
    expect(st.managed).toBe(false);
  });

  test("port choice: falls past an occupied default port to the next free one", async () => {
    const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    servers.push({ stop: () => blocker.stop(true) });
    const sup = new SwarmSupervisor({
      resourceDir: tmp(),
      repoRoot: null,
      userDataDir: tmp(),
      isPackaged: true,
      isWin: false,
      log: quiet,
      defaultPort: blocker.port, // occupied, but not by a swarm (no /api/health)
    });
    const st = await sup.start();
    // No bundle → error, but the port decision was still made and moved on.
    expect(st.port).not.toBe(blocker.port);
    expect(st.port).toBeGreaterThan(blocker.port);
  });
});
