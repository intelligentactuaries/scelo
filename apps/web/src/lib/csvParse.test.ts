import { describe, expect, test } from "bun:test";
import { delimiterFor, parseCsv } from "./csvParse";

describe("parseCsv", () => {
  test("simple comma-separated", () => {
    const r = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(r.rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
    expect(r.truncated).toBe(false);
  });

  test("quoted fields with embedded commas + quotes", () => {
    const r = parseCsv('a,b\n"x,y",hello\n"She said ""hi""",ok\n');
    expect(r.rows).toEqual([
      ["a", "b"],
      ["x,y", "hello"],
      ['She said "hi"', "ok"],
    ]);
    expect(r.hadQuotes).toBe(true);
  });

  test("CRLF line endings", () => {
    const r = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(r.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("embedded newline inside a quoted field", () => {
    const r = parseCsv('a,b\n"line1\nline2",ok\n');
    expect(r.rows[1]).toEqual(["line1\nline2", "ok"]);
  });

  test("respects maxRows cap and reports truncation", () => {
    const r = parseCsv("a,b\n1,2\n3,4\n5,6\n7,8\n", { maxRows: 2 });
    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test("delimiterFor picks tab for .tsv, comma otherwise", () => {
    expect(delimiterFor("foo.tsv")).toBe("\t");
    expect(delimiterFor("foo.csv")).toBe(",");
    expect(delimiterFor("foo.TXT")).toBe(",");
  });

  test("tab delimiter when configured", () => {
    const r = parseCsv("a\tb\tc\n1\t2\t3", { delimiter: "\t" });
    expect(r.rows[1]).toEqual(["1", "2", "3"]);
  });
});
