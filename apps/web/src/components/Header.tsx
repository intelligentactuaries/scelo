// Sticky top bar — brand mark, current conversation title (truncated),
// "Dashboards" link, "New chat" button. Used by the chat layout.

import { conversationStore } from "@/lib/conversations";
import { Link, useNavigate } from "react-router-dom";

type Props = {
  conversationTitle?: string;
  // When false (e.g. on /dashboards landing) we hide the title slot.
  showTitle?: boolean;
};

const TITLE_MAX_DISPLAY = 50;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function Header({ conversationTitle, showTitle = true }: Props) {
  const navigate = useNavigate();

  const onNewChat = () => {
    const conv = conversationStore.create();
    navigate(`/c/${conv.id}`);
  };

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-4">
      <Link to="/" className="flex items-center gap-2">
        <img src="/logo_math.JPG" alt="(Iα)ₐᵢ" className="h-6 w-6" />
        <span className="font-mono text-sm">
          <span className="text-primary">(Iα)</span>
          <span className="text-fg-mute">ₐᵢ</span>
        </span>
      </Link>

      {showTitle && conversationTitle ? (
        <div
          className="hidden flex-1 px-4 text-center font-mono text-xs text-fg-mute md:block"
          title={conversationTitle}
        >
          {truncate(conversationTitle, TITLE_MAX_DISPLAY)}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <nav className="flex items-center gap-3 text-xs">
        <Link to="/dashboards" className="text-fg-mute hover:text-fg">
          dashboards
        </Link>
        <button
          type="button"
          onClick={onNewChat}
          className="border border-primary bg-primary/10 px-3 py-1 font-mono text-primary text-xs hover:bg-primary/20"
        >
          + new chat
        </button>
      </nav>
    </header>
  );
}
