// Entry route for / — auto-creates a fresh conversation and forwards to /c/{id}.
// The full chat layout lives in <ChatRoute>.

import { conversationStore } from "@/lib/conversations";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function ChatHome() {
  const navigate = useNavigate();
  useEffect(() => {
    const conv = conversationStore.create();
    navigate(`/c/${conv.id}`, { replace: true });
  }, [navigate]);
  return (
    <div className="flex h-full items-center justify-center text-fg-mute text-sm">
      starting a new conversation…
    </div>
  );
}
