// Per-node chat state for Scelo nodes. Each node owns an isolated thread that
// streams from the orchestrator — keeps the macro view's three chatbots
// independent until the drill-down work lands.

import { type LlmMessage, hasLocalLlmBridge, llmChatActive } from "@/lib/aiProviders";
import { type OrchestratorMessage, streamOrchestrator } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

export type NodeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const HISTORY_TURNS = 8;

function buildHistory(messages: NodeChatMessage[]): OrchestratorMessage[] {
  const turns: OrchestratorMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content.trim().length > 0) {
      turns.push({ role: "assistant", content: m.content });
    }
  }
  return turns.slice(-HISTORY_TURNS);
}

// Optional persistence — when the caller provides a `memoryKey`, the chat
// hydrates from localStorage on mount and writes back on every message
// change. The key is composed by callers (typically `"<project.id>:<chat>"`),
// so memory is scoped per-project per-chat-instance. Pass `undefined` and the
// hook behaves like before: in-memory only, cleared on unmount.
function loadFromStorage(key: string): NodeChatMessage[] | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`scelo:chat:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as NodeChatMessage[];
  } catch {
    return null;
  }
}

function saveToStorage(key: string, messages: NodeChatMessage[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`scelo:chat:${key}`, JSON.stringify(messages));
  } catch {
    // Quota or serialization errors — we'd rather keep chatting than throw.
  }
}

export function useNodeChat(stageContext: string, opts?: { memoryKey?: string | null }) {
  const memoryKey = opts?.memoryKey ?? null;

  // Initialise from storage if there's a key on first mount.
  const [messages, setMessages] = useState<NodeChatMessage[]>(() => {
    if (!memoryKey) return [];
    return loadFromStorage(memoryKey) ?? [];
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // React to memoryKey transitions:
  //   • null → key   : "promote" current ephemeral chat — keep messages,
  //                    next save will persist them under the new key
  //   • key  → key'  : load the new project's chat (replace state)
  //   • key  → null  : keep current messages in memory but stop persisting
  // We use a ref so we only run on actual changes, not every render.
  const prevKeyRef = useRef<string | null>(memoryKey);
  useEffect(() => {
    const prev = prevKeyRef.current;
    if (memoryKey === prev) return;
    prevKeyRef.current = memoryKey;
    if (memoryKey && memoryKey !== prev) {
      const loaded = loadFromStorage(memoryKey);
      if (loaded && loaded.length > 0) {
        setMessages(loaded);
      }
      // else: keep current state — first save will populate the new key.
    }
  }, [memoryKey]);

  // Persist on every change.
  useEffect(() => {
    if (!memoryKey) return;
    saveToStorage(memoryKey, messages);
  }, [memoryKey, messages]);

  const send = useCallback(
    async (text: string) => {
      if (isStreaming) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsg: NodeChatMessage = {
        id: newId("u"),
        role: "user",
        content: trimmed,
      };
      const assistantId = newId("a");
      const assistantMsg: NodeChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
      };

      let snapshot: NodeChatMessage[] = [];
      setMessages((prev) => {
        snapshot = prev;
        return [...prev, userMsg, assistantMsg];
      });
      setIsStreaming(true);

      const history = buildHistory(snapshot);

      // Desktop IDE: there is no orchestrator backend, so talk to the active
      // provider directly through the main-process bridge. Single-shot (no
      // streaming) — we fill the bubble with the whole reply when it returns.
      if (hasLocalLlmBridge()) {
        try {
          const messages: LlmMessage[] = [
            { role: "system", content: stageContext },
            ...history.map((h) => ({ role: h.role, content: h.content })),
            { role: "user", content: trimmed },
          ];
          const res = await llmChatActive(messages, { maxTokens: 1024 });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: res.ok
                      ? (res.text ?? "").trim() ||
                        "_The provider returned an empty reply. Try a different model, or check the provider in Settings → AI providers._"
                      : `_error: ${res.error ?? "unknown error"}_`,
                  }
                : m,
            ),
          );
        } finally {
          setIsStreaming(false);
          abortRef.current = null;
        }
        return;
      }

      const ac = new AbortController();
      abortRef.current = ac;

      // Scelo's drilling metaphor: each node speaks from a fixed stage. We
      // prepend a short stage frame so the orchestrator answers in-character
      // without the user having to repeat the framing every turn.
      //
      // The leading CRITICAL guard mirrors the prompt used by the model
      // picker / hard-data narrative — without it, the orchestrator latches
      // onto words like "describe" or "summarise" in the user's message and
      // tries to dispatch to a specialist (documentation, reserving, …) with
      // the wrong call shape, surfacing as
      //   `documentation.predict failed: TypeError: ... missing 1 required
      //    positional argument: 'request'`.
      // We want plain conversational replies here, not specialist routing.
      const prompt = `CRITICAL: DO NOT CALL ANY TOOL. DO NOT dispatch documentation.predict, reserving.predict, or any specialist. This is a chat reply only.

[${stageContext}]

${trimmed}`;

      try {
        await streamOrchestrator(
          prompt,
          history,
          {
            onEvent: (ev) => {
              if (ev.kind === "message") {
                const chunk = ev.payload.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: m.content + chunk } : m,
                  ),
                );
              } else if (ev.kind === "error") {
                const err = ev.payload.message;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          content: m.content
                            ? `${m.content}\n\n_error: ${err}_`
                            : `_error: ${err}_`,
                        }
                      : m,
                  ),
                );
              }
            },
            onError: (e) => {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: m.content
                          ? `${m.content}\n\n_error: ${e.message}_`
                          : `_error: ${e.message}_`,
                      }
                    : m,
                ),
              );
            },
          },
          { signal: ac.signal },
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // If the stream finished without ever producing content and without
        // an error (the desktop IDE serves the SPA shell for /api routes
        // because it ships no orchestrator backend, so the SSE body parses
        // to zero frames), the bubble would otherwise sit empty — reads as
        // "it did nothing". Replace it with an explanation so the failure is
        // visible rather than silent.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && m.content.trim().length === 0
              ? {
                  ...m,
                  content:
                    "_The Scelo chat backend isn't reachable in this build, so I can't answer free-form questions here. You can still run cleaning and column tools directly — try the cleaning banner above the data grid, or just type `clean my data` and I'll run the initial cleaning for you._",
                }
              : m,
          ),
        );
      }
    },
    [isStreaming, stageContext],
  );

  // Append a user turn and a locally-computed assistant reply without touching
  // the orchestrator. Lets a workstation intercept deterministic intents
  // (e.g. "clean my data") and answer instantly client-side, which also works
  // when the chat backend is unreachable.
  const sendLocal = useCallback((userText: string, assistantText: string) => {
    const trimmed = userText.trim();
    if (!trimmed) return;
    const userMsg: NodeChatMessage = { id: newId("u"), role: "user", content: trimmed };
    const assistantMsg: NodeChatMessage = {
      id: newId("a"),
      role: "assistant",
      content: assistantText,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return { messages, isStreaming, send, sendLocal, stop };
}
