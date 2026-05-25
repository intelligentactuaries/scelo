// Custom remark plugin: convert GitHub-style fenced ```math``` code blocks
// into mdast `math` nodes that rehype-katex can render.
//
// remark-math (via micromark-extension-math) only understands `$...$` and
// `$$...$$` math delimiters. GitHub also accepts a fenced code block whose
// language is `math` — see
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions
//
// We use the fenced form on GitHub because it renders more reliably than
// `$$...$$` when surrounded by paragraph text. This plugin closes the gap
// so the workbench's chat renderer accepts the same syntax.

type CodeNode = { type: "code"; lang?: string | null; value: string };
type MathNode = { type: "math"; value: string };
type AnyNode = { type: string; children?: AnyNode[] } & Partial<CodeNode>;

export function remarkFencedMath() {
  return (tree: AnyNode): void => {
    const walk = (node: AnyNode): void => {
      const children = node.children;
      if (!Array.isArray(children)) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === "code" && child.lang === "math") {
          const replacement: MathNode = {
            type: "math",
            value: child.value ?? "",
          };
          children[i] = replacement as unknown as AnyNode;
        } else {
          walk(child);
        }
      }
    };
    walk(tree);
  };
}
