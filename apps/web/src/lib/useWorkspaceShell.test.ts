// Regression coverage for useWorkspaceShell.
//
// Uses happy-dom (configured in bunfig.toml) for a lightweight DOM, plus
// @testing-library/react to actually render the hook inside a tiny host
// component. We stub `window.scelo` with the minimum surface the hook
// touches; anything we don't override returns undefined and the hook's
// graceful-fallback branches kick in.

import { describe, expect, test, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import * as React from "react";
import { MemoryRouter } from "react-router-dom";
import type { StackReport, WorkspaceState } from "./sceloIDE";

try {
  GlobalRegistrator.register();
} catch {
  // Already registered by a sibling test file in the same bun process.
  // happy-dom throws if .register() is called twice; the second call is
  // a no-op for our purposes.
}

// Re-import after DOM is registered so React picks up the right globals.
const { useWorkspaceShell } = await import("./useWorkspaceShell");
const { _resetToastBus } = await import("./toastBus");

interface FakeScelo {
  workspace: {
    get: () => Promise<{ path: string | null; id: string | null }>;
    setForWindow: (id: string) => Promise<{ ok: boolean }>;
    stateGet: () => Promise<WorkspaceState>;
    stateSet: (state: WorkspaceState) => Promise<{ ok: boolean }>;
  };
  /** The hook's file-switch effect calls into the LSP client; we stub
   *  the minimum surface so the request resolves with an empty array
   *  rather than throwing on `window.scelo.lsp.start(...)`. */
  lsp: {
    start: () => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
    send: () => Promise<{ ok: boolean }>;
    onMessage: () => () => void;
  };
  runPython: () => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>;
  runR: () => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }>;
  runtimeStatus: () => Promise<{ python: boolean; r: boolean; resourceDir: string }>;
  stackProbe: () => Promise<StackReport>;
}

function mkFakeScelo(initial: WorkspaceState): FakeScelo {
  let state: WorkspaceState = initial;
  return {
    workspace: {
      get: async () => ({ path: "/tmp/test-workspace", id: "abc123" }),
      setForWindow: async () => ({ ok: true }),
      stateGet: async () => state,
      stateSet: async (next: WorkspaceState) => {
        state = next;
        return { ok: true };
      },
    },
    lsp: {
      // start returns ok:false so the LSP client's `starting` promise
      // resolves to false; subsequent .request() calls then reject with
      // a controlled error which the hook's catch handles by clearing
      // outline — exactly the behaviour we want under test (no live LSP,
      // outline driven by setOutline directly).
      start: async () => ({ ok: false }),
      stop: async () => ({ ok: true }),
      send: async () => ({ ok: true }),
      onMessage: () => () => {},
    },
    runPython: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    runR: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    runtimeStatus: async () => ({ python: false, r: false, resourceDir: "" }),
    stackProbe: async () =>
      ({ python: { available: false, packages: null, stderr: "" }, r: { available: false, packages: null, stderr: "" } }),
  };
}

beforeEach(() => {
  _resetToastBus();
  (globalThis as unknown as { window: { scelo?: unknown } }).window.scelo = undefined;
});

/** Mount the hook inside a tiny harness component so we can read +
 *  manipulate its return value. The MemoryRouter satisfies useNavigate. */
function mountHook() {
  type HookValue = ReturnType<typeof useWorkspaceShell>;
  const valueRef: { current: HookValue | null } = { current: null };
  function Probe() {
    valueRef.current = useWorkspaceShell();
    return null;
  }
  render(
    React.createElement(MemoryRouter, null, React.createElement(Probe, null)),
  );
  return valueRef;
}

/** Drain microtasks + the next animation frame so async useEffects
 *  initialised in mountHook have a chance to settle. happy-dom +
 *  React 18's batched updates require a real tick, not just a
 *  microtask flush. */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("useWorkspaceShell · tab persistence", () => {
  test("hydrates open tabs + active tab from window.scelo.workspace.stateGet", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: ["src/a.py", "src/b.py"],
      activeTab: "src/b.py",
    });
    const v = mountHook();
    // The hook's hydration effect is async; let it settle.
    await flushAsync();
    expect(v.current?.tabs.open).toEqual(["src/a.py", "src/b.py"]);
    expect(v.current?.tabs.active).toBe("src/b.py");
  });

  test("openFile adds a new tab and makes it active; closeTab removes it", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: [],
      activeTab: null,
    });
    const v = mountHook();
    await flushAsync();
    await act(async () => {
      v.current?.tabs.openFile("src/x.py");
    });
    expect(v.current?.tabs.open).toEqual(["src/x.py"]);
    expect(v.current?.tabs.active).toBe("src/x.py");
    await act(async () => {
      v.current?.tabs.closeTab("src/x.py");
    });
    expect(v.current?.tabs.open).toEqual([]);
    expect(v.current?.tabs.active).toBe(null);
  });

  test("sidebar tab + width hydrate from persisted state", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: [],
      activeTab: null,
      sidebarTab: "outline",
      sidebarWidth: 320,
    });
    const v = mountHook();
    await flushAsync();
    expect(v.current?.workspace.sidebarTab).toBe("outline");
    expect(v.current?.workspace.sidebarWidth).toBe(320);
  });

  test("setSidebarWidth clamps to [180, 600]", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: [],
      activeTab: null,
    });
    const v = mountHook();
    await flushAsync();
    await act(async () => {
      v.current?.workspace.setSidebarWidth(50);
    });
    expect(v.current?.workspace.sidebarWidth).toBe(180);
    await act(async () => {
      v.current?.workspace.setSidebarWidth(2000);
    });
    expect(v.current?.workspace.sidebarWidth).toBe(600);
  });
});

describe("useWorkspaceShell · palette commands", () => {
  test("always exposes the static IDE command set", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: [],
      activeTab: null,
    });
    const v = mountHook();
    await flushAsync();
    const ids = v.current?.palettes.commands.map((c) => c.id) ?? [];
    // A few load-bearing commands the user is expected to find.
    expect(ids).toContain("file.openWorkspace");
    expect(ids).toContain("file.switchWorkspace");
    expect(ids).toContain("ai.providers");
    expect(ids).toContain("view.outline");
    expect(ids).toContain("editor.formatDocument");
  });

  test("prepends symbol commands when outline + active file are set", async () => {
    (globalThis as unknown as { window: { scelo: FakeScelo } }).window.scelo = mkFakeScelo({
      openTabs: ["src/x.py"],
      activeTab: "src/x.py",
    });
    const v = mountHook();
    await flushAsync();
    // Outline isn't fetched in the test env (no LSP); feed it directly.
    await act(async () => {
      v.current?.editor.setOutline([
        {
          name: "f",
          kind: 12,
          line: 0,
          range: { startLine: 0, endLine: 4 },
          children: [],
        },
        {
          name: "g",
          kind: 12,
          line: 6,
          range: { startLine: 6, endLine: 10 },
          children: [],
        },
      ]);
    });
    const cmds = v.current?.palettes.commands ?? [];
    const symbolIds = cmds.filter((c) => c.id.startsWith("symbol.")).map((c) => c.label);
    expect(symbolIds).toContain("Symbol: f");
    expect(symbolIds).toContain("Symbol: g");
    // Symbol entries come first so a fuzzy match prefers them.
    expect(cmds[0]?.id.startsWith("symbol.")).toBe(true);
  });
});
