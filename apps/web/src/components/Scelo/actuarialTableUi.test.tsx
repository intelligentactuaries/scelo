// Component-level coverage for the actuarial-table surfaces: the hook that
// gives every stage chat the table vocabulary, the ```table chat card, and
// the Soft Data ideas strip — mounted inside a real SceloProvider so
// "keep" / "use as dataset" hit the actual context.

import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as React from "react";

try {
  GlobalRegistrator.register();
} catch {
  // already registered by a sibling test file in this bun process
}

const { cleanup, fireEvent, render, act } = await import("@testing-library/react");
const { SAMPLE_BY_KEY } = await import("@scelo/core");
const { SceloProvider, useScelo } = await import("./sceloContext");
const { useActuarialTableChat } = await import("./useActuarialTableChat");
const {
  ChatTableCard,
  TableIdeasStrip,
  CHAT_DRAFT_EVENT,
  tableReplyMarkdown,
  buildWorkspaceTable,
} = await import("./actuarialTableUi");

type Dataset = import("@scelo/core").Dataset;

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

/** Mount a probe that exposes the hook + context to the test. */
function mountHook(dataset: Dataset | null, stage: "soft" | "tools" | "hard" = "soft") {
  const captured: {
    hook?: ReturnType<typeof useActuarialTableChat>;
    ctx?: ReturnType<typeof useScelo>;
  } = {};
  function Probe() {
    const ctx = useScelo();
    // seed the dataset once
    React.useEffect(() => {
      if (dataset && !ctx.dataset) ctx.setDataset(dataset);
    }, [ctx]);
    const hook = useActuarialTableChat(stage, ctx.dataset);
    captured.hook = hook;
    captured.ctx = ctx;
    return React.createElement("div", null, `tables:${ctx.tables.length}`);
  }
  const utils = render(React.createElement(SceloProvider, null, React.createElement(Probe)));
  return { ...utils, captured };
}

describe("useActuarialTableChat", () => {
  test("suggests tables from the lifelib MP sample and exposes chips", async () => {
    const mp = SAMPLE_BY_KEY.get("lifelib-mp")!.build();
    const { captured } = mountHook(mp);
    await act(async () => {});
    expect(captured.hook!.suggestions.map((s) => s.kind)).toContain("model-points");
    expect(captured.hook!.actions.length).toBeGreaterThan(0);
    expect(captured.hook!.actions[0].label.startsWith("▦")).toBe(true);
    expect(captured.hook!.contextAddendum).toContain("ACTUARIAL TABLES");
    expect(captured.hook!.contextAddendum).toContain("age_at_entry");
  });

  test("typed prompt builds a table, keeps it, and replies with a ```table block", async () => {
    const mp = SAMPLE_BY_KEY.get("lifelib-mp")!.build();
    const { captured, getByText } = mountHook(mp);
    await act(async () => {});
    let reply: string | null = null;
    await act(async () => {
      reply = captured.hook!.onLocalCommand(
        "build a life table on the illustrative Gompertz-Makeham basis at 4% from age 30 to 100",
      );
    });
    expect(reply).not.toBeNull();
    expect(reply!).toContain("```table");
    expect(reply!).toContain("Kept in your workspace tables");
    expect(getByText("tables:1")).toBeTruthy();
    expect(captured.ctx!.tables[0].spec.kind).toBe("life-table");
    expect(captured.ctx!.tables[0].origin).toBe("chat");
    // the event log carries the executable spec
    const ev = captured.ctx!.events.find((e) => e.kind === "table.build");
    expect(ev).toBeDefined();
  });

  test("non-table prompts return null but are remembered for suggestions", async () => {
    const { captured } = mountHook(null);
    await act(async () => {});
    expect(captured.hook!.suggestions).toEqual([]);
    let reply: string | null = "x";
    await act(async () => {
      reply = captured.hook!.onLocalCommand("what do you think about commutation functions at 3%");
    });
    expect(reply).toBeNull(); // a question → falls through to the LLM
    // …but the prompt was read: the agent now suggests a commutation table
    expect(captured.hook!.suggestions.map((s) => s.kind)).toContain("commutation");
    expect(captured.hook!.lastPrompt).toContain("commutation");
  });

  test("'suggest tables' lists ideas with their prompts", async () => {
    const claims = SAMPLE_BY_KEY.get("claims")!.build();
    const { captured } = mountHook(claims);
    await act(async () => {});
    const out: { reply: string | null } = { reply: null };
    await act(async () => {
      out.reply = captured.hook!.onLocalCommand("what tables can I build from this?");
    });
    expect(out.reply).toContain("run-off triangle");
    expect(out.reply).toContain("→ prompt:");
  });

  test("a bad request is a clean reply, not a throw", async () => {
    const { captured } = mountHook({ name: "x", columns: ["colour"], rows: [{ colour: "red" }] });
    await act(async () => {});
    const out: { reply: string | null } = { reply: null };
    await act(async () => {
      out.reply = captured.hook!.onLocalCommand(
        "build a run-off triangle of paid by origin and development",
      );
    });
    expect(out.reply).toContain("couldn't build");
    expect(captured.ctx!.tables.length).toBe(0);
  });
});

describe("ChatTableCard", () => {
  test("renders a preview from an LLM-style spec and keeps on press", async () => {
    const captured: { ctx?: ReturnType<typeof useScelo> } = {};
    function Probe() {
      captured.ctx = useScelo();
      return null;
    }
    const raw = JSON.stringify({ kind: "discount-curve", flatRate: 0.05, maxTenor: 12 });
    const utils = render(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(Probe),
        React.createElement(ChatTableCard, { raw }),
      ),
    );
    await act(async () => {});
    expect(utils.getByText(/▦ table/)).toBeTruthy();
    expect(utils.getByText("discount factor")).toBeTruthy(); // column header
    expect(captured.ctx!.tables.length).toBe(0); // LLM proposal is not auto-kept
    await act(async () => {
      fireEvent.click(utils.getByText("keep"));
    });
    expect(captured.ctx!.tables.length).toBe(1);
    expect(captured.ctx!.tables[0].origin).toBe("llm");
    expect(utils.getByText("✓ kept")).toBeTruthy();
  });

  test("'use as dataset' swaps the active dataset and is undoable", async () => {
    const captured: { ctx?: ReturnType<typeof useScelo> } = {};
    function Probe() {
      captured.ctx = useScelo();
      return null;
    }
    const raw = JSON.stringify({
      kind: "life-table",
      basis: { kind: "gompertz-makeham" },
      ages: { from: 50, to: 60 },
    });
    const utils = render(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(Probe),
        React.createElement(ChatTableCard, { raw }),
      ),
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(utils.getByText("use as dataset"));
    });
    expect(captured.ctx!.dataset?.columns).toEqual([
      "age",
      "qx",
      "px",
      "lx",
      "dx",
      "Lx",
      "Tx",
      "ex",
    ]);
    expect(captured.ctx!.canUndo).toBe(true);
  });

  test("bad JSON is an error card", async () => {
    const utils = render(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(ChatTableCard, { raw: "{ nope" }),
      ),
    );
    await act(async () => {});
    expect(utils.getByText(/could not build the table/)).toBeTruthy();
  });

  test("tableReplyMarkdown round-trips through the card", async () => {
    const t = buildWorkspaceTable(
      {
        kind: "commutation",
        basis: { kind: "gompertz-makeham", A: 0.00022, B: 2.7e-6, c: 1.124 },
        interest: 0.03,
        ages: { from: 40, to: 45 },
      },
      null,
      "chat",
    );
    const md = tableReplyMarkdown(t, { kept: true });
    const block = /```table\n([\s\S]*?)\n```/.exec(md);
    expect(block).not.toBeNull();
    const utils = render(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(ChatTableCard, { raw: block![1] }),
      ),
    );
    await act(async () => {});
    expect(utils.getByText(/Commutation functions/)).toBeTruthy();
  });

  test("a table kept by the hook shows as ✓ kept when its reply block renders", async () => {
    const captured: { hook?: ReturnType<typeof useActuarialTableChat> } = {};
    const holder: { md: string | null } = { md: null };
    function Probe() {
      captured.hook = useActuarialTableChat("hard", null);
      return null;
    }
    function Card() {
      const block = holder.md ? /```table\n([\s\S]*?)\n```/.exec(holder.md) : null;
      return block ? React.createElement(ChatTableCard, { raw: block[1] }) : null;
    }
    const utils = render(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(Probe),
        React.createElement(Card),
      ),
    );
    await act(async () => {});
    await act(async () => {
      holder.md = captured.hook!.onLocalCommand(
        "build annuity factors at 4% with a 10-year term for ages 30 to 40",
      );
    });
    utils.rerender(
      React.createElement(
        SceloProvider,
        null,
        React.createElement(Probe),
        React.createElement(Card),
      ),
    );
    await act(async () => {});
    expect(utils.getByText("✓ kept")).toBeTruthy();
  });
});

describe("TableIdeasStrip", () => {
  test("build calls back, send-to-chat dispatches the draft event", async () => {
    const mp = SAMPLE_BY_KEY.get("lifelib-mp")!.build();
    const { captured } = mountHook(mp);
    await act(async () => {});
    const built: string[] = [];
    const seeded: Array<{ chatId: string; text: string }> = [];
    const onSeed = (ev: Event) => seeded.push((ev as CustomEvent).detail);
    window.addEventListener(CHAT_DRAFT_EVENT, onSeed);
    const utils = render(
      React.createElement(TableIdeasStrip, {
        suggestions: captured.hook!.suggestions,
        onBuild: (s) => {
          built.push(s.kind);
          return "built";
        },
        chatId: "soft-stage",
      }),
    );
    await act(async () => {});
    expect(utils.getAllByText("build").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(utils.getAllByText("build")[0]);
    });
    expect(built.length).toBe(1);
    await act(async () => {
      fireEvent.click(utils.getAllByText("send prompt to chat")[0]);
    });
    expect(seeded.length).toBe(1);
    expect(seeded[0].chatId).toBe("soft-stage");
    expect(seeded[0].text.toLowerCase()).toContain("build");
    window.removeEventListener(CHAT_DRAFT_EVENT, onSeed);
  });
});
