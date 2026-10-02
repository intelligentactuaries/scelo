// Pure-logic tests for the swarm modal's augment pre-flight guard,
// failure classification and progress mapping, plus mount tests for the
// open/close cycle and a streamed run. The rest of the component (mode
// reset on open, replace-confirm arming) is exercised in the browser;
// these cover the text/branching that decides what the user is told.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as React from "react";
import { MemoryRouter } from "react-router-dom";
import {
  SimulateScenarioModal,
  augmentRowGuard,
  describeHttpFailure,
  describeNetworkFailure,
  personColumns,
  simulationProgress,
} from "./SimulateScenarioModal";

try {
  GlobalRegistrator.register();
} catch {
  // already registered by a sibling test file in this bun process
}

// Imported AFTER GlobalRegistrator.register() so react-dom sees the
// happy-dom document.
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");

type Dataset = import("@scelo/core").Dataset;

describe("augmentRowGuard", () => {
  test("allows datasets at or under the 100k limit", () => {
    expect(augmentRowGuard(0)).toBeNull();
    expect(augmentRowGuard(10_000)).toBeNull();
    expect(augmentRowGuard(100_000)).toBeNull();
  });

  test("blocks datasets over the limit with an actionable message", () => {
    const msg = augmentRowGuard(250_000);
    expect(msg).not.toBeNull();
    expect(msg).toContain((250_000).toLocaleString());
    expect(msg).toContain((100_000).toLocaleString());
    expect(msg).toContain("smaller sample");
  });

  test("mentions the full-fidelity row count for sampled imports", () => {
    const msg = augmentRowGuard(250_000, 2_000_000);
    expect(msg).toContain(`a sample of ${(2_000_000).toLocaleString()}`);
  });

  test("omits the sample note when sourceTotalRows adds nothing", () => {
    expect(augmentRowGuard(250_000, 250_000)).not.toContain("sample of");
    expect(augmentRowGuard(250_000, undefined)).not.toContain("sample of");
  });
});

describe("describeNetworkFailure", () => {
  test("blames the server and gives start instructions", () => {
    const f = describeNetworkFailure(1024);
    expect(f.message).toContain(":3010");
    expect(f.message).toContain("is it running");
    expect(f.hint).toContain("bun run dev:swarm");
    expect(f.hint).toContain("docs: swarm/running");
  });

  test("small bodies get no severed-body note", () => {
    const f = describeNetworkFailure(1024);
    expect(f.hint).not.toContain("128 MB");
  });

  test("oversize bodies add the severed-body explanation", () => {
    const f = describeNetworkFailure(200 * 1024 * 1024);
    expect(f.hint).toContain("~200 MB");
    expect(f.hint).toContain("128 MB");
  });
});

describe("describeHttpFailure", () => {
  test("shows status + collapsed body snippet, and NO server-down hint", () => {
    const f = describeHttpFailure("/api/simulate", 500, "Internal Server Error", "boom\n  at x");
    expect(f.message).toContain("500 Internal Server Error");
    expect(f.message).toContain("boom at x");
    expect(f.hint).toBeNull();
  });

  test("truncates long bodies to a 200-char snippet", () => {
    const f = describeHttpFailure("/api/simulate", 413, "", "x".repeat(10_000));
    expect(f.message.length).toBeLessThan(300);
  });

  test("omits the snippet separator for empty bodies", () => {
    const f = describeHttpFailure("/api/simulate/augment", 502, "", "");
    expect(f.message).toBe("swarm /api/simulate/augment responded 502");
  });
});

describe("SimulateScenarioModal open/close", () => {
  // The workstation keeps the modal mounted while closed (`open` only
  // gates the render), so clicking "▷ simulate" re-renders a mounted
  // component. A hook declared below the `if (!open) return null` runs
  // on the open render only, and React throws "Rendered more hooks than
  // during the previous render" — with no error boundary, that blanks
  // the whole window.
  const dataset = {
    name: "policies",
    columns: ["age", "sex"],
    rows: [
      { age: 34, sex: "F" },
      { age: 61, sex: "M" },
    ],
  };

  afterEach(cleanup);

  function modal(open: boolean, existingDataset: typeof dataset | null) {
    return React.createElement(
      MemoryRouter,
      null,
      React.createElement(SimulateScenarioModal, {
        open,
        onClose: () => {},
        onDataset: () => {},
        existingDataset,
      }),
    );
  }

  for (const existingDataset of [null, dataset]) {
    test(`opens, closes and reopens ${existingDataset ? "over a loaded dataset" : "with no dataset"}`, () => {
      const view = render(modal(false, existingDataset));
      // Scoped to this render's container: sibling test files share the
      // happy-dom body and can leave their own dialogs mounted in it.
      const ui = within(view.container);
      expect(ui.queryByRole("dialog")).toBeNull();

      view.rerender(modal(true, existingDataset));
      expect(ui.getByRole("dialog")).toBeTruthy();
      expect(
        ui.getByText(existingDataset ? "▷ augment dataset" : "▷ generate dataset"),
      ).toBeTruthy();

      view.rerender(modal(false, existingDataset));
      expect(ui.queryByRole("dialog")).toBeNull();

      view.rerender(modal(true, existingDataset));
      expect(ui.getByRole("dialog")).toBeTruthy();
    });
  }
});

describe("simulationProgress", () => {
  test("the reference lookup scans — no progress signal, no invented pct", () => {
    expect(simulationProgress({ type: "phase", phase: "refs" }, "augment")).toEqual({
      verb: "resolving",
      name: "compound references",
    });
  });

  test("the agent pass fills the rail and counts", () => {
    expect(simulationProgress({ type: "phase", phase: "sim", total: 120 }, "augment")).toEqual({
      verb: "simulating",
      name: "reference agents",
      pct: 0,
      count: { done: 0, total: 120 },
    });
    expect(
      simulationProgress({ type: "sim_progress", done: 30, total: 120 }, "augment"),
    ).toMatchObject({ pct: 25, count: { done: 30, total: 120 } });
  });

  test("generate's agents are the new dataset's rows, not a reference sample", () => {
    expect(simulationProgress({ type: "phase", phase: "sim", total: 50 }, "generate")?.name).toBe(
      "agents",
    );
  });

  test("an agent pass without a usable total scans instead of filling", () => {
    expect(simulationProgress({ type: "phase", phase: "sim" }, "augment")).toEqual({
      verb: "simulating",
      name: "reference agents",
    });
    expect(
      simulationProgress({ type: "sim_progress", total: 120 }, "augment")?.pct,
    ).toBeUndefined();
  });

  test("the scaling pass scans; result, error and unknown events are not progress", () => {
    expect(simulationProgress({ type: "phase", phase: "macro" }, "augment")).toEqual({
      verb: "scaling",
      name: "results",
    });
    expect(simulationProgress({ type: "result", rows: [] }, "augment")).toBeNull();
    expect(simulationProgress({ type: "error", message: "x" }, "augment")).toBeNull();
    expect(simulationProgress({ type: "heartbeat" }, "augment")).toBeNull();
  });
});

describe("SimulateScenarioModal streamed run", () => {
  const dataset = {
    name: "policies",
    columns: ["age", "sex"],
    rows: [
      { age: 34, sex: "F" },
      { age: 61, sex: "M" },
    ],
  };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    cleanup();
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** Swap fetch for a fake swarm: one SSE response whose frames the test
   *  pushes — and which errors when its signal aborts, as a real fetch's
   *  body does — plus the run-control endpoints, logged in `actions`. */
  function fakeSwarm(opts: { controlDown?: boolean } = {}) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const actions: string[] = [];
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      const control = /\/api\/simulate\/runs\/([^/]+)\/(\w+)$/.exec(url);
      if (control) {
        const [, runId, action] = control;
        actions.push(`${runId}:${action}`);
        if (opts.controlDown) return { ok: false, status: 404, statusText: "Not Found" };
        const state = { pause: "paused", resume: "running", stop: "stopped" }[action];
        return { ok: true, status: 200, statusText: "OK", json: async () => ({ runId, state }) };
      }
      init?.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      return { ok: true, status: 200, statusText: "OK", body };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return {
      fetchMock,
      actions,
      push: (ev: object) =>
        act(async () => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`));
          await settle();
        }),
      end: () =>
        act(async () => {
          controller.close();
          await settle();
        }),
    };
  }

  function mount(existingDataset: typeof dataset | Dataset = dataset) {
    const onDataset = mock(() => {});
    const onClose = mock(() => {});
    const view = render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(SimulateScenarioModal, {
          open: true,
          onClose,
          onDataset,
          existingDataset,
        }),
      ),
    );
    return { ui: within(view.container), container: view.container, onDataset, onClose };
  }

  const click = (el: HTMLElement) =>
    act(async () => {
      fireEvent.click(el);
      await settle();
    });

  test("each phase drives the overlay, and the result lands as a dataset", async () => {
    const swarm = fakeSwarm();
    const { ui, onDataset, onClose } = mount();
    expect(ui.queryByText("connecting")).toBeNull();

    await act(async () => {
      fireEvent.click(ui.getByText("▷ augment dataset"));
    });
    expect(swarm.fetchMock).toHaveBeenCalledTimes(1);
    expect(ui.getByText("connecting")).toBeTruthy();

    await swarm.push({ type: "phase", phase: "refs" });
    expect(ui.getByText("resolving")).toBeTruthy();
    expect(ui.getByText("compound references")).toBeTruthy();

    await swarm.push({ type: "phase", phase: "sim", total: 4 });
    await swarm.push({ type: "sim_progress", done: 1, total: 4 });
    expect(ui.getByText("simulating")).toBeTruthy();
    expect(ui.getByText("reference agents")).toBeTruthy();
    expect(ui.getByText("1 / 4")).toBeTruthy();

    await swarm.push({ type: "phase", phase: "macro" });
    expect(ui.getByText("scaling")).toBeTruthy();

    await swarm.push({
      type: "result",
      augmentedColumns: ["sim_x"],
      rows: [
        { age: 34, sex: "F", sim_x: true },
        { age: 61, sex: "M", sim_x: false },
      ],
    });
    await swarm.end();

    expect(onDataset).toHaveBeenCalledWith(
      {
        name: "policies + sim",
        columns: ["age", "sex", "sim_x"],
        rows: [
          { age: 34, sex: "F", sim_x: "yes" },
          { age: 61, sex: "M", sim_x: "no" },
        ],
      },
      "sim_x",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui.queryByText("scaling")).toBeNull();
  });

  test("a swarm error event clears the overlay and says what failed", async () => {
    const swarm = fakeSwarm();
    const { ui, onDataset } = mount();
    await act(async () => {
      fireEvent.click(ui.getByText("▷ augment dataset"));
    });
    await swarm.push({ type: "phase", phase: "refs" });
    await swarm.push({ type: "error", message: "ollama is not running" });
    await swarm.end();

    expect(ui.getByText("ollama is not running")).toBeTruthy();
    expect(ui.queryByText("resolving")).toBeNull();
    expect(onDataset).not.toHaveBeenCalled();
  });

  test("pause holds the run where it stands; resume carries it on", async () => {
    const swarm = fakeSwarm();
    const { ui, container, onDataset } = mount();
    await click(ui.getByText("▷ augment dataset"));
    // Pause addresses the run by the id the stream's first event carries.
    expect((ui.getByText("pause").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await swarm.push({ type: "run", runId: "r1" });
    await swarm.push({ type: "phase", phase: "sim", total: 4 });
    await swarm.push({ type: "sim_progress", done: 2, total: 4 });

    await click(ui.getByText("pause"));
    expect(swarm.actions).toEqual(["r1:pause"]);
    expect(ui.getByText("paused")).toBeTruthy();
    expect(ui.getByText("2 / 4")).toBeTruthy();
    expect(container.querySelector(".ia-paused")).not.toBeNull();

    await click(ui.getByText("resume"));
    expect(swarm.actions).toEqual(["r1:pause", "r1:resume"]);
    expect(ui.getByText("simulating")).toBeTruthy();
    expect(container.querySelector(".ia-paused")).toBeNull();

    await swarm.push({
      type: "result",
      augmentedColumns: ["sim_x"],
      rows: dataset.rows.map((r) => ({ ...r, sim_x: 1 })),
    });
    await swarm.end();
    expect(onDataset).toHaveBeenCalledTimes(1);
  });

  test("stop tells the swarm, drops the stream and changes nothing", async () => {
    const swarm = fakeSwarm();
    const { ui, onDataset, onClose } = mount();
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({ type: "run", runId: "r9" });
    await swarm.push({ type: "phase", phase: "sim", total: 4 });

    await click(ui.getByText("stop"));
    expect(swarm.actions).toEqual(["r9:stop"]);
    expect(ui.queryByText("simulating")).toBeNull();
    expect(ui.getByText("simulation stopped — policies is unchanged")).toBeTruthy();
    expect(ui.queryByText(/unreachable|closed without/)).toBeNull();
    expect(onDataset).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("stop works before the run is named, as on an older swarm", async () => {
    const swarm = fakeSwarm();
    const { ui, onDataset } = mount();
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({ type: "phase", phase: "refs" });

    await click(ui.getByText("stop"));
    expect(swarm.actions).toEqual([]);
    expect(ui.getByText("simulation stopped — policies is unchanged")).toBeTruthy();
    expect(onDataset).not.toHaveBeenCalled();
  });

  test("a run the swarm stops ends quietly, not as an error", async () => {
    const swarm = fakeSwarm();
    const { ui } = mount();
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({ type: "run", runId: "r2" });
    await swarm.push({ type: "stopped" });
    await swarm.end();
    expect(ui.getByText("simulation stopped — policies is unchanged")).toBeTruthy();
    expect(ui.queryByText(/closed without/)).toBeNull();
  });

  test("a pause the swarm can't take leaves the run running", async () => {
    const swarm = fakeSwarm({ controlDown: true });
    const { ui, container } = mount();
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({ type: "run", runId: "r3" });
    await swarm.push({ type: "phase", phase: "sim", total: 4 });

    await click(ui.getByText("pause"));
    expect(swarm.actions).toEqual(["r3:pause"]);
    expect(ui.getByText("simulating")).toBeTruthy();
    expect(ui.getByText("pause")).toBeTruthy();
    expect(container.querySelector(".ia-paused")).toBeNull();
  });

  test("a result with no simulated columns is an error, not a silent no-op", async () => {
    const swarm = fakeSwarm();
    const { ui, onDataset } = mount();
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({
      type: "result",
      augmentedColumns: [],
      failedCount: 120,
      requestedSampleSize: 120,
      rows: dataset.rows,
    });
    await swarm.end();
    expect(
      ui.getByText(/no simulated values came back — 120 of 120 reference agents failed/),
    ).toBeTruthy();
    expect(onDataset).not.toHaveBeenCalled();
  });

  test("augment says up front when the rows can't be told apart", async () => {
    const scenarios = {
      name: "scenarios",
      columns: ["entity", "w_s"],
      rows: [{ entity: "rural village", w_s: 0.3 }],
    };
    fakeSwarm();
    const { ui } = mount(scenarios);
    expect(ui.getByText(/scenarios has no age, sex or comorbidity column/)).toBeTruthy();
    await click(ui.getByText("generate new dataset"));
    expect(ui.queryByText(/has no age, sex or comorbidity column/)).toBeNull();
  });

  test("no heads-up when the rows carry the traits the swarm matches on", () => {
    fakeSwarm();
    const { ui } = mount();
    expect(ui.queryByText(/has no age, sex or comorbidity column/)).toBeNull();
  });

  test("a re-run replaces the sim_* values in place and lands on them", async () => {
    const augmented = {
      name: "policies + sim",
      columns: ["age", "sex", "sim_x"],
      rows: [
        { age: 34, sex: "F", sim_x: 1 },
        { age: 61, sex: "M", sim_x: 1 },
      ],
    };
    const swarm = fakeSwarm();
    const { ui, onDataset } = mount(augmented);
    await click(ui.getByText("▷ augment dataset"));
    await swarm.push({
      type: "result",
      augmentedColumns: ["sim_x"],
      rows: augmented.rows.map((r) => ({ ...r, sim_x: 2 })),
    });
    await swarm.end();
    expect(onDataset).toHaveBeenCalledWith(
      {
        name: "policies + sim",
        columns: ["age", "sex", "sim_x"],
        rows: [
          { age: 34, sex: "F", sim_x: 2 },
          { age: 61, sex: "M", sim_x: 2 },
        ],
      },
      "sim_x",
    );
  });
});

describe("personColumns", () => {
  test("finds the columns the swarm matches on, ignoring case", () => {
    expect(personColumns(["policy_id", "Age_At_Entry", "SEX", "premium"])).toEqual([
      "Age_At_Entry",
      "SEX",
    ]);
    expect(personColumns(["entity", "alpha_m", "w_s"])).toEqual([]);
  });
});
