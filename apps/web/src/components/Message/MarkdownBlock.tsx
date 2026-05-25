// Streaming markdown renderer for assistant messages.
// react-markdown + remark-gfm (tables, strikethrough, task lists, autolink)
// + remark-math + remarkFencedMath + rehype-katex for $...$ / $$...$$ /
// ```math``` math
// + rehype-highlight (highlight.js) for code blocks.

import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-dark.css";

import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { remarkFencedMath } from "@/lib/remarkFencedMath";

type Props = {
  children: string;
  // When true, append a blinking caret to the very end so the user sees
  // the assistant is still streaming.
  streaming?: boolean;
};

export function MarkdownBlock({ children, streaming = false }: Props) {
  return (
    <div className="ia-md text-fg text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkFencedMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
      >
        {children}
      </ReactMarkdown>
      {streaming && children.length > 0 && (
        <span className="ml-0.5 inline-block animate-pulse text-primary">▍</span>
      )}
    </div>
  );
}
