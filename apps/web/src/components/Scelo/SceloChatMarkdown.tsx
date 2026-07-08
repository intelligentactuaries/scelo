// Markdown renderer for Scelo chat replies. Extends the shared MarkdownBlock
// with one extra behaviour: fenced ```viz code blocks get replaced with the
// `ChatViz` component, which parses the JSON spec inside and renders an
// ECharts chart or a stat table against the current dataset.
//
// Everything else (GFM tables, code highlighting, math, the streaming caret)
// inherits from MarkdownBlock by mirroring its plugin / class setup.

import "katex/dist/katex.min.css";
import "highlight.js/styles/atom-one-dark.css";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { remarkFencedMath } from "@/lib/remarkFencedMath";
import type { Dataset } from "./SoftDataWorkstation";
import { ChatDerive, ChatTransform } from "./chatDerive";
import { ChatViz } from "./chatViz";
import { ChatClean } from "./cleanAction";

type Props = {
  children: string;
  dataset: Dataset | null;
  streaming?: boolean;
  /** Body text size for this chat surface. Default "sm" (14px); "xs" (10px)
   *  is used in compact inline chats like the macro-view node chatbots. */
  size?: "sm" | "xs";
};

const SIZE_CLASS: Record<NonNullable<Props["size"]>, string> = {
  sm: "text-sm",
  xs: "text-[10px]",
};

// Memoised so unrelated parent re-renders (most commonly, the textarea's
// draft state ticking on every keystroke) don't trigger a full markdown +
// ECharts re-parse. Default shallow compare is fine here — `children` is a
// string, `streaming` a boolean, and `dataset` is the same Scelo context
// reference across renders unless the user actually uploads a new file.
function SceloChatMarkdownImpl({ children, dataset, streaming = false, size = "sm" }: Props) {
  return (
    <div
      className={`ia-md ${SIZE_CLASS[size]} min-w-0 overflow-hidden break-words leading-relaxed text-fg [&_code]:break-all [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-all [&_table]:block [&_table]:overflow-x-auto`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkFencedMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          code({ className, children: codeChildren, ...rest }) {
            const match = /language-(\w+)/.exec(className ?? "");
            const lang = match?.[1];
            // Fenced ```viz block → render as chart/table once the JSON is
            // complete. During streaming the body may not be parseable yet;
            // ChatViz surfaces a short "viz error · ..." which is fine —
            // it'll flip to the rendered chart as more tokens arrive.
            const isInline = "inline" in rest && rest.inline === true;
            if (!isInline && lang === "viz") {
              const raw = String(codeChildren).replace(/\n$/, "");
              return <ChatViz raw={raw} dataset={dataset} />;
            }
            // Fenced ```derive block → auto-apply the formula to the
            // dataset as a new column and render a "✓ added" card.
            // Idempotent on the column name so re-rendering the same
            // reply doesn't duplicate the action.
            if (!isInline && lang === "derive") {
              const raw = String(codeChildren).replace(/\n$/, "");
              return <ChatDerive raw={raw} />;
            }
            // Fenced ```transform block → mutate the named column in
            // place using the formula. Idempotent on (column + formula)
            // via the SceloContext.transformLog set.
            if (!isInline && lang === "transform") {
              const raw = String(codeChildren).replace(/\n$/, "");
              return <ChatTransform raw={raw} />;
            }
            // Fenced ```clean block → run the deterministic cleaning engine
            // (the same ops the banner drives) against the active dataset.
            // Idempotent on the raw block via the transformLog set.
            if (!isInline && lang === "clean") {
              const raw = String(codeChildren).replace(/\n$/, "");
              return <ChatClean raw={raw} />;
            }
            return (
              <code className={className} {...rest}>
                {codeChildren}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
      {streaming && children.length > 0 && (
        <span className="ml-0.5 inline-block animate-pulse text-primary">▍</span>
      )}
    </div>
  );
}

export const SceloChatMarkdown = memo(SceloChatMarkdownImpl);
