// Regression coverage for the shared <Palette> shell. Tests are
// component-level (mount + dispatch DOM events + assert on rendered
// output) rather than callback unit tests because the value of Palette
// is in the keyboard / mouse / lifecycle interaction.

import { describe, expect, test, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as React from "react";

try {
  GlobalRegistrator.register();
} catch {
  // Already registered by a sibling test file in the same bun process.
  // happy-dom throws if .register() is called twice; the second call is
  // a no-op for our purposes.
}

// Imported AFTER GlobalRegistrator.register() so RTL captures the
// happy-dom document instead of the no-DOM stub it gets at module top.
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const userEventMod = await import("@testing-library/user-event");
const userEvent = userEventMod.default;
const { default: Palette } = await import("./Palette");

interface Item {
  id: string;
  label: string;
}

const items: Item[] = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
  { id: "c", label: "gamma" },
];

function mountPalette(opts: {
  onSelect?: (item: Item) => void;
  onClose?: () => void;
  onQueryChange?: (q: string) => void;
  items?: Item[];
} = {}) {
  const onSelect = opts.onSelect ?? (() => {});
  const onClose = opts.onClose ?? (() => {});
  const utils = render(
    React.createElement(Palette<Item>, {
      items: opts.items ?? items,
      getKey: (it: Item) => it.id,
      renderItem: (it: Item) => React.createElement("span", null, it.label),
      onSelect,
      onClose,
      onQueryChange: opts.onQueryChange,
      ariaLabel: "Test palette",
    }),
  );
  return utils;
}

beforeEach(() => {
  // RTL's auto-cleanup hooks into Jest/Vitest's `afterEach` — bun:test
  // doesn't expose the same global, so unmount explicitly. Without
  // this the dialog from a sibling test stays in the DOM and
  // getByRole("dialog") returns the WRONG one.
  cleanup();
});

describe("Palette · render + selection", () => {
  test("renders each item via renderItem", () => {
    const { getByText } = mountPalette();
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(getByText("gamma")).toBeTruthy();
  });

  test("Enter selects the active row + closes", () => {
    let selected: Item | null = null;
    let closed = false;
    const { getByRole } = mountPalette({
      onSelect: (it) => {
        selected = it;
      },
      onClose: () => {
        closed = true;
      },
    });
    fireEvent.keyDown(getByRole("dialog"), { key: "Enter" });
    expect(closed).toBe(true);
    // first item is active by default
    expect(selected).not.toBeNull();
    expect((selected as Item | null)?.id).toBe("a");
  });

  test("Escape closes without selecting", () => {
    let selected: Item | null = null;
    let closed = false;
    const { getByRole } = mountPalette({
      onSelect: (it) => {
        selected = it;
      },
      onClose: () => {
        closed = true;
      },
    });
    fireEvent.keyDown(getByRole("dialog"), { key: "Escape" });
    expect(closed).toBe(true);
    expect(selected).toBeNull();
  });

  test("ArrowDown / ArrowUp move the active row", () => {
    let selected: Item | null = null;
    const { getByRole } = mountPalette({
      onSelect: (it) => {
        selected = it;
      },
    });
    const dialog = getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect((selected as Item | null)?.id).toBe("c");
  });

  test("clicking a row selects it directly", () => {
    let selected: Item | null = null;
    const { getByText } = mountPalette({
      onSelect: (it) => {
        selected = it;
      },
    });
    fireEvent.click(getByText("beta"));
    expect((selected as Item | null)?.id).toBe("b");
  });

  test("typing into the input fires onQueryChange", async () => {
    const seen: string[] = [];
    const { getByRole } = mountPalette({
      onQueryChange: (q) => seen.push(q),
    });
    const input = getByRole("dialog").querySelector("input") as HTMLInputElement;
    // userEvent simulates real keystrokes (keydown / input / keyup),
    // which sidesteps the React 18 + happy-dom + bun:test race that
    // makes fireEvent.change drop the synthetic event after many
    // mount/unmount cycles.
    const user = userEvent.setup();
    await user.type(input, "be");
    expect(seen).toContain("b");
    expect(seen).toContain("be");
  });

  test("initialQuery propagates into the input value", () => {
    const utils = render(
      React.createElement(Palette<Item>, {
        items,
        getKey: (it: Item) => it.id,
        renderItem: (it: Item) => React.createElement("span", null, it.label),
        onSelect: () => {},
        onClose: () => {},
        ariaLabel: "Test palette",
        initialQuery: "be",
      }),
    );
    const input = utils.getByRole("dialog").querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("be");
  });

  test("empty items shows `no matches`", () => {
    const { getByText } = mountPalette({ items: [] });
    expect(getByText("no matches")).toBeTruthy();
  });
});
