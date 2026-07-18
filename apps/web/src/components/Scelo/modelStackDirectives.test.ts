import { describe, expect, test } from "bun:test";
import {
  applyModelDirective,
  describeDirectiveReport,
  parseModelDirective,
  replaceDirectiveBlock,
} from "./modelStackDirectives";
import type { SelectedModel } from "./sceloContext";

const stack: SelectedModel[] = [
  { id: "wmtr-projection", enabled: true, source: "ai" },
  { id: "wmtr-sensitivity", enabled: true, source: "ai" },
  { id: "scr-standard", enabled: false, source: "user" },
];

describe("parseModelDirective", () => {
  test("parses a fenced block with prose around it", () => {
    const text = [
      "Great — adding both now.",
      "```scelo-models",
      '{"add":[{"id":"glm-frequency","rationale":"claims signal"},"gbm"],"remove":["mack"]}',
      "```",
      "Anything else?",
    ].join("\n");
    const d = parseModelDirective(text);
    expect(d).not.toBeNull();
    expect(d?.add).toEqual([
      { id: "glm-frequency", rationale: "claims signal" },
      { id: "gbm", rationale: undefined },
    ]);
    expect(d?.remove).toEqual(["mack"]);
  });

  test("no block or empty directive → null", () => {
    expect(parseModelDirective("just prose")).toBeNull();
    expect(parseModelDirective('```scelo-models\n{"add":[]}\n```')).toBeNull();
    expect(parseModelDirective("```scelo-models\nnot json\n```")).toBeNull();
  });
});

describe("applyModelDirective", () => {
  test("adds catalog models, refuses invented ids, skips duplicates", () => {
    const { next, report } = applyModelDirective(stack, {
      add: [
        { id: "glm-frequency", rationale: "freq" },
        { id: "glm-claims-frequency" }, // hallucinated id — must be refused
        { id: "wmtr-projection" }, // already attached
      ],
      remove: [],
      enable: [],
      disable: [],
    });
    expect(next.map((m) => m.id)).toContain("glm-frequency");
    expect(report.added).toEqual(["glm-frequency"]);
    expect(report.unknown).toEqual(["glm-claims-frequency"]);
    expect(report.skipped).toEqual(["wmtr-projection"]);
    const added = next.find((m) => m.id === "glm-frequency");
    expect(added?.source).toBe("ai");
    expect(added?.rationale).toBe("freq");
  });

  test("removes attached models, skips absent ones", () => {
    const { next, report } = applyModelDirective(stack, {
      add: [],
      remove: ["wmtr-sensitivity", "chain-ladder"],
      enable: [],
      disable: [],
    });
    expect(next.map((m) => m.id)).not.toContain("wmtr-sensitivity");
    expect(report.removed).toEqual(["wmtr-sensitivity"]);
    expect(report.skipped).toEqual(["chain-ladder"]);
  });

  test("enable/disable toggle only when they change something", () => {
    const { next, report } = applyModelDirective(stack, {
      add: [],
      remove: [],
      enable: ["scr-standard", "wmtr-projection"],
      disable: ["wmtr-sensitivity"],
    });
    expect(next.find((m) => m.id === "scr-standard")?.enabled).toBe(true);
    expect(next.find((m) => m.id === "wmtr-sensitivity")?.enabled).toBe(false);
    expect(report.enabled).toEqual(["scr-standard"]);
    expect(report.skipped).toContain("wmtr-projection");
  });
});

describe("confirmation rendering", () => {
  test("replaceDirectiveBlock swaps the fence for the report line", () => {
    const text = 'ok!\n```scelo-models\n{"add":["gbm"]}\n```';
    const { report } = applyModelDirective(stack, {
      add: [{ id: "gbm" }],
      remove: [],
      enable: [],
      disable: [],
    });
    const out = replaceDirectiveBlock(text, describeDirectiveReport(report));
    expect(out).not.toContain("scelo-models");
    expect(out).toContain("stack update:");
    expect(out).toContain("added GBM");
  });
});
