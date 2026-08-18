// Regression guard for the Soft Data column-summary "cropping" bug.
//
// The panel's inner wrapper is a FLEX COLUMN that scrolls
// (ResizablePanel innerClassName="overflow-auto"). Flexbox shrinks items to
// fit before a container scrolls, and per CSS an item whose `overflow` is
// not `visible` loses its automatic minimum height (min-height: auto → 0) —
// so such an item can be squashed to a few pixels and have its content
// sliced in half. That is exactly what happened to the column-summary
// header once a column was selected (its branch sets `overflow-hidden`),
// while the unselected branch rendered fine.
//
// There is no layout engine in bun:test, so the invariant is asserted on
// the source: every element in these files that hides overflow while living
// in that scrolling column must also declare `shrink-0`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

describe("column-summary panel is scrolled, never squashed", () => {
  const soft = read("SoftDataWorkstation.tsx");

  test("both header branches declare shrink-0", () => {
    const header = soft.slice(
      soft.indexOf("function ColumnSummaryHeader"),
      soft.indexOf("// Cleaning suggestion"),
    );
    expect(header.length).toBeGreaterThan(200);
    // Both branches render the header box: `border-b … px-3 py-1.5 pl-8`.
    const boxes = header.split("\n").filter((l) => l.includes("border-b") && l.includes("pl-8"));
    expect(boxes.length).toBe(2); // meta + no-meta branch
    for (const c of boxes) expect(c).toContain("shrink-0");
  });

  test("an overflow-hidden flex child of the scrolling column also pins its height", () => {
    // The meta branch is the dangerous one: overflow-hidden ⇒ min-height 0.
    const line = soft
      .split("\n")
      .find((l) => l.includes("overflow-hidden border-b") && l.includes("tone.wrap"));
    expect(line).toBeDefined();
    expect(line).toContain("shrink-0");
  });

  test("the dashboard body below it is pinned too", () => {
    const dash = read("SmartColumnDashboard.tsx");
    expect(dash).toContain('className="flex shrink-0 flex-col gap-3 p-3"');
  });

  test("ResizablePanel documents the contract for scrolling panels", () => {
    const panel = read("ResizablePanel.tsx");
    expect(panel).toContain("shrink-0");
    expect(panel).toContain("flexbox shrinks items");
  });
});
