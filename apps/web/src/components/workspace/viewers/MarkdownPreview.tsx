// Rendered markdown for the active buffer. Reuses the same react-markdown
// + remark/rehype pipeline that powers the assistant message blocks, so
// code fences, math, GFM tables, and task lists all look identical to
// the rest of the app.

import { MarkdownBlock } from "../../Message/MarkdownBlock";

interface Props {
  path: string;
  buffer: string;
}

export default function MarkdownPreview({ buffer }: Props) {
  return (
    <div className="h-full overflow-auto bg-bg p-4">
      <div className="mx-auto max-w-3xl">
        <MarkdownBlock>{buffer}</MarkdownBlock>
      </div>
    </div>
  );
}
