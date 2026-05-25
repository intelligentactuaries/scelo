// Workspace-level toast surface. Subscribes to the global `toastBus`
// (apps/web/src/lib/toastBus.ts) and renders any incoming toast in a
// stack top-right. Each entry auto-dismisses after 6 s independently;
// max 3 visible at once (older ones evict from the head).
//
// The matching per-editor toast UI from Phase 20 is gone — the editor
// now emits through the bus too so a single component handles both
// editor and global notices.

import { useEffect, useState } from "react";
import { subscribeToasts, type Toast } from "../../lib/toastBus";

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 6000;

export default function ToastTray() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const off = subscribeToasts((t) => {
      setToasts((cur) => {
        const next = [...cur, t];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      window.setTimeout(() => {
        setToasts((cur) => cur.filter((x) => x.id !== t.id));
      }, AUTO_DISMISS_MS);
    });
    return off;
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-12 z-50 flex max-w-md flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-md border px-3 py-2 text-xs text-fg shadow-lg ${variantClass(t.kind)}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span>{t.text}</span>
            <button
              type="button"
              onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
              className="text-fg-mute hover:text-fg"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function variantClass(kind: Toast["kind"]): string {
  if (kind === "error") return "border-adversarial/50 bg-adversarial/10";
  if (kind === "success") return "border-consensus/50 bg-consensus/10";
  return "border-dissent/40 bg-bg-2";
}
