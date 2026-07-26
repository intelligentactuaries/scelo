import { describe, expect, test } from "bun:test";
import { SCE_MAGIC, SCE_VERSION, buildSceFile, parseSce, suggestSceFilename } from "./projectFile";
import type { SceloProject, StoredSessionSnapshot } from "./sceloContext";

const session: StoredSessionSnapshot = {
  dataset: {
    name: "policies.csv",
    columns: ["id", "premium"],
    rows: [{ id: "A1", premium: 1200 }],
  },
  filters: [],
  selectedModels: [{ id: "glm-frequency", enabled: true, source: "ai", rationale: "fits" }],
  domain: "pricing",
  pickSummary: "pricing mix",
  picksDatasetName: "policies.csv",
  modelWires: [],
  runs: {},
  derivedColumns: { logprem: "log(premium)" },
  transformLog: ["premium|log(premium)"],
  events: [
    {
      ts: 1,
      stage: "soft",
      kind: "dataset.load",
      payload: {
        name: "policies.csv",
        rows: 1,
        cols: 2,
        columns: ["id", "premium"],
        source: "import",
      },
    },
  ],
};

const project: SceloProject = { id: "proj_x", name: "Q3 Pricing", createdAt: 1700000000000 };

describe("suggestSceFilename", () => {
  test("prefers the project name, slugified", () => {
    expect(suggestSceFilename(project, "policies.csv")).toBe("q3-pricing.sce");
  });
  test("falls back to the dataset name without extension", () => {
    expect(suggestSceFilename(null, "hackathon_train.csv")).toBe("hackathon_train.sce");
  });
  test("falls back to a generic stem when nothing is named", () => {
    expect(suggestSceFilename(null, null)).toBe("scelo-project.sce");
  });
  test("strips unsafe characters", () => {
    expect(suggestSceFilename({ ...project, name: "A/B: 2026 report!" }, null)).toBe(
      "a-b-2026-report.sce",
    );
  });
});

describe("buildSceFile + parseSce round-trip", () => {
  test("serialises and parses back to an equal session", () => {
    const file = buildSceFile(session, project, "2026-07-02T10:00:00.000Z");
    expect(file.format).toBe(SCE_MAGIC);
    expect(file.version).toBe(SCE_VERSION);
    const text = JSON.stringify(file);
    const parsed = parseSce(text);
    expect(parsed.session).toEqual(session);
    expect(parsed.project).toEqual(project);
    expect(parsed.savedAt).toBe("2026-07-02T10:00:00.000Z");
  });

  test("a project-less session round-trips with project null", () => {
    const text = JSON.stringify(buildSceFile(session, null, "2026-07-02T10:00:00.000Z"));
    expect(parseSce(text).project).toBeNull();
  });
});

describe("parseSce validation", () => {
  test("rejects non-JSON", () => {
    expect(() => parseSce("not json {")).toThrow(/valid JSON/);
  });
  test("rejects a JSON file without the magic header", () => {
    expect(() => parseSce(JSON.stringify({ hello: "world" }))).toThrow(/Scelo project file/);
  });
  test("rejects a file saved by a newer version", () => {
    const text = JSON.stringify({
      format: SCE_MAGIC,
      version: SCE_VERSION + 1,
      app: "Scelo",
      session,
    });
    expect(() => parseSce(text)).toThrow(/newer version/);
  });
  test("rejects a file with no session", () => {
    const text = JSON.stringify({ format: SCE_MAGIC, version: 1, app: "Scelo" });
    expect(() => parseSce(text)).toThrow(/missing its session/);
  });
  test("normalises a session with missing optional fields", () => {
    const text = JSON.stringify({
      format: SCE_MAGIC,
      version: 1,
      app: "Scelo",
      session: { dataset: null },
    });
    const parsed = parseSce(text);
    expect(parsed.session.filters).toEqual([]);
    expect(parsed.session.runs).toEqual({});
    expect(parsed.session.transformLog).toEqual([]);
    expect(parsed.session.events).toEqual([]);
  });
});
