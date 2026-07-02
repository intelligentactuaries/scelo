import { describe, expect, test } from "bun:test";
import { type CsvStreamOptions, parseCsvChunks, streamParseCsv } from "./csvStream";

const enc = new TextEncoder();

// Hand-cut chunk boundaries: each string in `parts` becomes one chunk, so a
// boundary can land mid-quote, mid-\r\n, or mid-codepoint on purpose.
async function* chunksOf(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield enc.encode(p);
}

async function parse(parts: string[], opts: CsvStreamOptions = {}) {
  const total = parts.reduce((n, p) => n + enc.encode(p).byteLength, 0);
  return parseCsvChunks(chunksOf(parts), total, opts);
}

describe("parseCsvChunks", () => {
  test("parses a simple csv", async () => {
    const r = await parse(["a,b,c\n1,2,3\n4,5,6\n"]);
    expect(r.header).toEqual(["a", "b", "c"]);
    expect(r.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    expect(r.totalDataRows).toBe(2);
    expect(r.sampled).toBe(false);
    expect(r.malformedRows).toBe(0);
  });

  test("quoted field with comma and escaped quote split across chunks", async () => {
    // Boundary lands between the two quote chars of the escape.
    const r = await parse(['a,b\n"hello, ', 'wo""', 'rld",2\n']);
    expect(r.rows).toEqual([['hello, wo"rld', "2"]]);
    expect(r.hadQuotes).toBe(true);
  });

  test("quoted field with embedded newline", async () => {
    const r = await parse(['a,b\n"line1\nline2",x\n']);
    expect(r.rows).toEqual([["line1\nline2", "x"]]);
  });

  test("closing quote at end of input", async () => {
    const r = await parse(['a,b\n1,"two"']);
    expect(r.rows).toEqual([["1", "two"]]);
  });

  test("\\r\\n split across a chunk boundary", async () => {
    const r = await parse(["a,b\r", "\n1,2\r", "\n3,4\r\n"]);
    expect(r.header).toEqual(["a", "b"]);
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("lone \\r line endings parse as record separators", async () => {
    const r = await parse(["a,b\r1,2\r3,4\r"]);
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("ragged rows are padded/truncated and counted", async () => {
    const r = await parse(["a,b,c\n1,2\n1,2,3,4\n5,6,7\n"]);
    expect(r.rows).toEqual([
      ["1", "2", ""],
      ["1", "2", "3"],
      ["5", "6", "7"],
    ]);
    expect(r.malformedRows).toBe(2);
  });

  test("duplicate and empty header names are deduped", async () => {
    const r = await parse(["x,x,,x\n1,2,3,4\n"]);
    expect(r.header).toEqual(["x", "x_2", "column", "x_3"]);
  });

  test("blank lines and trailing newline produce no phantom rows", async () => {
    const r = await parse(["a,b\n\n1,2\n   \n\n3,4\n\n"]);
    expect(r.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(r.totalDataRows).toBe(2);
  });

  test("UTF-8 BOM is stripped from the first header cell", async () => {
    const bom = "﻿";
    const r = await parse([`${bom}a,b\n1,2\n`]);
    expect(r.header).toEqual(["a", "b"]);
  });

  test("multi-byte character split across chunks survives", async () => {
    const bytes = enc.encode("a,b\nHöhe,2\n");
    // Cut inside the two-byte ö sequence.
    const cut = 6;
    async function* split() {
      yield bytes.slice(0, cut);
      yield bytes.slice(cut);
    }
    const r = await parseCsvChunks(split(), bytes.byteLength, {});
    expect(r.rows).toEqual([["Höhe", "2"]]);
  });

  test("row cap reservoir-samples uniformly and keeps file order", async () => {
    const lines = ["n"];
    for (let i = 0; i < 1000; i++) lines.push(String(i));
    const r = await parse([`${lines.join("\n")}\n`], { maxRows: 100 });
    expect(r.totalDataRows).toBe(1000);
    expect(r.rows.length).toBe(100);
    expect(r.sampled).toBe(true);
    const values = r.rows.map((row) => Number(row[0]));
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted); // original order restored
    expect(new Set(values).size).toBe(100); // no duplicates
    // Uniformity smoke check: the sample shouldn't be just the head.
    expect(Math.max(...values)).toBeGreaterThan(500);
  });

  test("progress callback reports bytes and rows", async () => {
    const seen: number[] = [];
    await parse(["a,b\n1,2\n", "3,4\n"], {
      onProgress: (p) => seen.push(p.bytesRead),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(enc.encode("a,b\n1,2\n3,4\n").byteLength);
  });

  test("abort signal stops the parse", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(parse(["a,b\n1,2\n"], { signal: ac.signal })).rejects.toThrow("aborted");
  });

  test("empty input returns empty result", async () => {
    const r = await parse([""]);
    expect(r.header).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.totalDataRows).toBe(0);
  });
});

describe("streamParseCsv", () => {
  test("parses a real Blob end-to-end", async () => {
    const blob = new Blob(['a,b\n"x,y",2\n3,4\n'], { type: "text/csv" });
    const r = await streamParseCsv(blob);
    expect(r.header).toEqual(["a", "b"]);
    expect(r.rows).toEqual([
      ["x,y", "2"],
      ["3", "4"],
    ]);
  });
});
