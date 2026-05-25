// Verifies the wiki-page minimal markdown renderer produces KaTeX HTML for
// every math syntax we emit in docs/wiki/**.md after the syntax-unification
// commit (75d9d35). If KaTeX renders, the output contains either a
// `class="katex"` (inline) or `class="katex-display"` (block) marker.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderMarkdownHtml } from "./wiki";

describe("wiki renderer math support", () => {
  test("```math``` fence renders as a KaTeX display block", () => {
    const md = [
      "Some prose.",
      "",
      "```math",
      "W(t) = M(t)^{\\alpha_M} \\cdot T(t)^{\\alpha_T} \\cdot R(t)^{\\alpha_R}",
      "```",
      "",
      "Trailing prose.",
    ].join("\n");
    const html = renderMarkdownHtml(md);
    expect(html).toContain("katex-display");
    // KaTeX renders \alpha as a Greek alpha (α) in the visible HTML, while
    // preserving the raw LaTeX source in a hidden <annotation> tag for
    // accessibility. So we check for the rendered glyph rather than the
    // absence of the source.
    expect(html).toContain("α");
    // The original fence delimiter is consumed.
    expect(html).not.toContain("```math");
  });

  test("$$…$$ block renders as a KaTeX display block", () => {
    const md = ["Prose.", "", "$$h(t) = h_0 \\cdot \\exp(-\\beta_W \\cdot W(t))$$", "", "More."].join(
      "\n",
    );
    const html = renderMarkdownHtml(md);
    expect(html).toContain("katex-display");
    expect(html).not.toContain("$$");
  });

  test("multi-line $$…$$ block renders too", () => {
    const md = [
      "Definition.",
      "",
      "$$",
      "S(T) = \\exp\\left(-\\int_0^T h(t)\\, dt\\right)",
      "$$",
      "",
      "Done.",
    ].join("\n");
    const html = renderMarkdownHtml(md);
    expect(html).toContain("katex-display");
  });

  test("inline $…$ renders as inline KaTeX", () => {
    const html = renderMarkdownHtml(
      "The Lee-Carter model parameterises mortality with $\\alpha_x$ and $\\kappa_t$.",
    );
    expect(html).toContain('class="katex"');
    // No display wrapper for inline math.
    expect(html).not.toContain("katex-display");
  });

  test("inline math containing | renders correctly (no broken bars)", () => {
    const html = renderMarkdownHtml("Defined as $|D_p - D_L|$ in the LP objective.");
    expect(html).toContain('class="katex"');
  });

  test("price strings like '$5 to $10' do NOT render as math", () => {
    const html = renderMarkdownHtml("Returns $5 to $10 per share.");
    expect(html).not.toContain('class="katex"');
    // The original prose should pass through.
    expect(html).toContain("$5");
  });

  test("a real converted wiki entry (lee-carter.md) renders typeset math", () => {
    // Read the actual file from disk and strip the YAML frontmatter the way
    // the FastAPI WikiEntry serialiser would before sending to the browser.
    const raw = readFileSync(
      `${__dirname}/../../../../docs/wiki/methodology/lee-carter.md`,
      "utf-8",
    );
    const body = raw.replace(/^---[\s\S]*?---\n/, "");
    const html = renderMarkdownHtml(body);
    // Both flavours should appear: a display block from the ```math fence,
    // and inline KaTeX from the surrounding `$...$` parameter callouts.
    expect(html).toContain("katex-display");
    expect(html).toContain('class="katex"');
    // Sanity: the file's parameters render as Greek glyphs.
    expect(html).toContain("α");
    expect(html).toContain("κ");
    // The opening fence is consumed.
    expect(html).not.toContain("```math");
  });
});
