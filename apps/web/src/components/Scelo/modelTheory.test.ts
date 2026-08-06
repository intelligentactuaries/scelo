// Guards the escaping contract of the theory blurbs. They are ordinary
// template literals, so a LaTeX command written with a SINGLE backslash is
// silently corrupted by JS string escaping — \b becomes a backspace, \t a
// tab, \n a newline, and \sum just "sum" — and the formula reaches KaTeX as
// garbage. This suite trips on every corruption mode so a future edit can't
// reintroduce it.

import { describe, expect, test } from "bun:test";
import { MODEL_THEORY } from "./modelTheory";

const entries = Object.entries(MODEL_THEORY);

describe("model theory strings", () => {
  test("has entries (merge ran)", () => {
    expect(entries.length).toBeGreaterThan(0);
    // Spot-check one id from each dictionary: base + EXTRA override.
    expect(MODEL_THEORY.chainladder ?? MODEL_THEORY["workspace-bottleneck"]).toBeTruthy();
    expect(MODEL_THEORY.descriptive).toBeTruthy();
  });

  test("no control characters from eaten backslashes", () => {
    for (const [id, text] of entries) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: hunting control characters is this test's entire purpose.
      const bad = text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\t]/);
      expect(
        bad,
        `"${id}" contains a control character — a \\b/\\t/\\f style LaTeX command lost its backslash`,
      ).toBeNull();
    }
  });

  test("math delimiters pair up", () => {
    for (const [id, text] of entries) {
      const dollars = (text.match(/\$/g) ?? []).length;
      expect(dollars % 2, `"${id}" has an unbalanced $ delimiter`).toBe(0);
    }
  });

  test("LaTeX commands keep their backslashes", () => {
    // Fragments that only ever appear inside formulas in these blurbs. If one
    // shows up without a leading backslash (and not as the tail of a longer
    // command, e.g. the "frac{" inside "\tfrac{"), an escape was eaten.
    // ("sum_" is deliberately absent: `sum_assured` is legitimate prose.)
    const fragments = [
      "qquad",
      "tfrac{",
      "frac{",
      "sum_{",
      "sqrt{",
      "mathrm{",
      "mathcal{",
      "operatorname{",
      "widehat{",
      "sigma_k",
      "kappa_t",
      "nabla_",
      "bar x",
    ];
    for (const [id, text] of entries) {
      for (const fragment of fragments) {
        const naked = new RegExp(`(?<![\\\\A-Za-z])${fragment.replace(/[{_]/g, (m) => `\\${m}`)}`);
        expect(naked.test(text), `"${id}" contains "${fragment}" without its backslash`).toBe(
          false,
        );
      }
    }
  });
});
