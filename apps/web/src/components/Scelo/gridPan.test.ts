// Horizontal panning in the data grid — the spreadsheet gesture.
//
// A trackpad two-finger sideways swipe arrives as a wheel event with
// `deltaX`; a mouse (no horizontal wheel) uses shift+wheel. Both must pan
// the grid, a plain vertical wheel must keep scrolling rows, and neither may
// leak into the browser's horizontal overscroll (history navigation), which
// is what made the gesture look dead. bun:test has no layout engine, so the
// delta rule is tested directly and the two layout guarantees — the
// containment class and the sticky row gutter — are pinned on the source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { horizontalPanDelta } from "./SoftDataWorkstation";

const grid = () => readFileSync(join(import.meta.dir, "SoftDataWorkstation.tsx"), "utf8");

describe("horizontalPanDelta", () => {
  test("trackpad: deltaX pans, in both directions", () => {
    expect(horizontalPanDelta({ deltaX: 42, deltaY: 0, shiftKey: false })).toBe(42);
    expect(horizontalPanDelta({ deltaX: -42, deltaY: 0, shiftKey: false })).toBe(-42);
  });

  test("trackpad diagonal: the horizontal component wins over the vertical one", () => {
    expect(horizontalPanDelta({ deltaX: 7, deltaY: 30, shiftKey: false })).toBe(7);
  });

  test("mouse: shift+wheel pans by the vertical delta", () => {
    expect(horizontalPanDelta({ deltaX: 0, deltaY: 53, shiftKey: true })).toBe(53);
    expect(horizontalPanDelta({ deltaX: 0, deltaY: -53, shiftKey: true })).toBe(-53);
  });

  test("plain vertical wheel is left to the rows", () => {
    expect(horizontalPanDelta({ deltaX: 0, deltaY: 120, shiftKey: false })).toBe(0);
    expect(horizontalPanDelta({ deltaX: 0, deltaY: 0, shiftKey: true })).toBe(0);
  });
});

describe("grid layout guarantees the gesture depends on", () => {
  test("the scroller contains horizontal overscroll (no back/forward swipe)", () => {
    expect(grid()).toContain("overscroll-x-contain");
  });

  test("the wheel listener is non-passive — a passive one cannot preventDefault", () => {
    expect(grid()).toContain('addEventListener("wheel", onWheel, { passive: false })');
  });

  test("the row-number gutter stays put while panning", () => {
    const src = grid();
    // header corner cell + body cells, both sticky to the left edge
    expect(src).toContain("sticky left-0 z-30");
    expect(src).toContain("sticky left-0 z-10");
  });
});
