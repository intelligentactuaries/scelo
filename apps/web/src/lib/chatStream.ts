// useChatStream — owns the in-memory message state for a single conversation
// and consumes the orchestrator SSE event stream. Composes one assistant
// message per query from the events that produced it (see ADR-0018 §2).

import { useCallback, useEffect, useReducer, useRef } from "react";
import { type OrchestratorEvent, type OrchestratorMessage, streamOrchestrator } from "./api";
import {
  type AssistantPart,
  type AttachedFile,
  type ConversationMessage,
  conversationStore,
} from "./conversations";

// ── reducer ──────────────────────────────────────────────────────────────────

type State = {
  messages: ConversationMessage[];
  isStreaming: boolean;
  // Stable id of the assistant message currently being assembled.
  activeAssistantId: string | null;
};

type Action =
  | { type: "load"; messages: ConversationMessage[] }
  | { type: "appendUser"; message: ConversationMessage }
  | { type: "startAssistant"; id: string }
  | { type: "applyEvent"; id: string; event: OrchestratorEvent }
  | { type: "finishAssistant" }
  | { type: "abortAssistant"; reason?: string }
  | { type: "truncateAfter"; index: number };

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Pull chart_spec_ids out of a tool's `output` regardless of the surrounding
// shape. Specialists return them under different keys depending on slice;
// we treat any `chart_spec_ids: string[]` field at the top of the output as
// canonical.
function extractChartSpecIds(output: unknown): string[] | undefined {
  if (!output || typeof output !== "object") return undefined;
  const ids = (output as Record<string, unknown>).chart_spec_ids;
  if (Array.isArray(ids) && ids.every((x) => typeof x === "string")) {
    return ids as string[];
  }
  return undefined;
}

function extractDashboardPath(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const path = (output as Record<string, unknown>).dashboard_path;
  return typeof path === "string" && path.startsWith("/dashboards/") ? path : undefined;
}

// Tool names look like "{specialist}.{capability}" — pull the specialist out
// so the open-in-dashboard affordance knows which surface to deep-link to.
function specialistFromTool(tool: string): string | undefined {
  const dot = tool.indexOf(".");
  return dot > 0 ? tool.slice(0, dot) : undefined;
}

function partForEvent(ev: OrchestratorEvent): AssistantPart | null {
  switch (ev.kind) {
    case "routing": {
      const band = ev.payload.confidence_band ?? "medium";
      const tool = ev.payload.dispatched_tool ?? undefined;
      return {
        kind: "routing",
        band,
        tool: tool ?? undefined,
        confidence: ev.payload.confidence,
      };
    }
    case "wiki_retrieval": {
      const entries = ev.payload.entries ?? [];
      return {
        kind: "wiki_retrieval",
        n: entries.length,
        sources: entries.map((e) => e.title),
      };
    }
    case "regulatory_retrieval": {
      const entries = ev.payload.entries ?? [];
      return {
        kind: "regulatory_retrieval",
        n: entries.length,
        sources: entries.map((e) => e.title),
      };
    }
    case "tool_call":
      return {
        kind: "tool_call",
        tool: ev.payload.tool,
        arguments: ev.payload.arguments ?? {},
      };
    case "tool_result":
      return {
        kind: "tool_result",
        tool: ev.payload.tool,
        output: ev.payload.output,
        duration_ms: ev.payload.duration_ms,
        chart_spec_ids: extractChartSpecIds(ev.payload.output),
        specialist: specialistFromTool(ev.payload.tool),
        dashboard_path: extractDashboardPath(ev.payload.output),
      };
    case "message":
      return { kind: "message", text: ev.payload.text };
    case "usage":
      return {
        kind: "usage",
        provider: ev.payload.provider,
        input_tokens: ev.payload.input_tokens,
        output_tokens: ev.payload.output_tokens,
      };
    case "error":
      return { kind: "error", text: ev.payload.message };
    default:
      return null;
  }
}

// Apply an event to the active assistant message.
//
// `message` events stream character-by-character from the LLM — the orchestrator
// sends increments. We append to the most recent `message` part if one exists
// already in this turn, otherwise push a new one. This keeps the rendered
// markdown coherent rather than emitting a forest of single-token messages.
function mergeEvent(parts: AssistantPart[], ev: OrchestratorEvent): AssistantPart[] {
  if (ev.kind === "done") return parts;
  const part = partForEvent(ev);
  if (!part) return parts;
  if (part.kind === "message") {
    const last = parts[parts.length - 1];
    if (last && last.kind === "message") {
      const merged: AssistantPart = { kind: "message", text: last.text + part.text };
      return [...parts.slice(0, -1), merged];
    }
  }
  return [...parts, part];
}

function partsToMarkdown(parts: AssistantPart[]): string {
  // Used to populate `content` on persistence so naive consumers (sidebar
  // preview, copy button) can read a flat string. Cards/tools are not
  // serialised here; only the textual `message` parts are concatenated.
  return parts
    .filter((p): p is Extract<AssistantPart, { kind: "message" }> => p.kind === "message")
    .map((p) => p.text)
    .join("");
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "load":
      return { ...state, messages: action.messages };
    case "appendUser":
      return { ...state, messages: [...state.messages, action.message] };
    case "startAssistant": {
      const placeholder: ConversationMessage = {
        id: action.id,
        role: "assistant",
        content: "",
        parts: [],
        created_at: new Date().toISOString(),
      };
      return {
        ...state,
        messages: [...state.messages, placeholder],
        isStreaming: true,
        activeAssistantId: action.id,
      };
    }
    case "applyEvent": {
      const messages = state.messages.map((m) => {
        if (m.id !== action.id) return m;
        const nextParts = mergeEvent(m.parts ?? [], action.event);
        return {
          ...m,
          parts: nextParts,
          content: partsToMarkdown(nextParts),
        };
      });
      return { ...state, messages };
    }
    case "finishAssistant":
      return { ...state, isStreaming: false, activeAssistantId: null };
    case "abortAssistant": {
      const messages = state.messages.map((m) => {
        if (m.id !== state.activeAssistantId) return m;
        const parts = m.parts ?? [];
        const stamped: AssistantPart[] = [
          ...parts,
          { kind: "error", text: action.reason ?? "stopped by user" },
        ];
        return { ...m, parts: stamped, content: partsToMarkdown(stamped) };
      });
      return { ...state, messages, isStreaming: false, activeAssistantId: null };
    }
    case "truncateAfter": {
      // Keep messages 0..index inclusive; drop everything after.
      return { ...state, messages: state.messages.slice(0, action.index + 1) };
    }
    default:
      return state;
  }
}

// ── hook ─────────────────────────────────────────────────────────────────────

const HISTORY_TURNS = 10;

function buildHistory(messages: ConversationMessage[]): OrchestratorMessage[] {
  // The orchestrator wants a strict user/assistant alternation; we filter out
  // empty assistant placeholders (in-flight) and clamp to the last N turns.
  const turns: OrchestratorMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content.trim().length > 0) {
      turns.push({ role: "assistant", content: m.content });
    }
  }
  return turns.slice(-HISTORY_TURNS);
}

const PERSIST_DEBOUNCE_MS = 500;

// Build the prompt the orchestrator actually sees from a user message
// plus any attached files. Specialists can read files via
// GET /files/{conversation_id}/{filename}; we tell the LLM about them
// explicitly so it has the full context.
function renderUserPrompt(text: string, attachments: AttachedFile[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map(
    (a) =>
      `- ${a.filename} (${a.bytes} bytes, suggested ${a.classification.specialist}.${a.classification.suggested_capability}; saved to ${a.saved_path})`,
  );
  const header = text.trim().length > 0 ? text : "(no message)";
  return `${header}\n\nAttached files:\n${lines.join("\n")}`;
}

export function useChatStream(conversationId: string) {
  const [state, dispatch] = useReducer(reducer, {
    messages: [],
    isStreaming: false,
    activeAssistantId: null,
  });

  // AbortController for the in-flight SSE; set when streaming starts and
  // nulled when it ends.
  const abortRef = useRef<AbortController | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── load conversation on mount / id change ────────────────────────────────
  useEffect(() => {
    const conv = conversationStore.get(conversationId);
    dispatch({ type: "load", messages: conv?.messages ?? [] });
  }, [conversationId]);

  // ── debounced persistence ─────────────────────────────────────────────────
  useEffect(() => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      conversationStore.update(conversationId, { messages: state.messages });
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    };
  }, [state.messages, conversationId]);

  // ── flush on unmount or before navigation ─────────────────────────────────
  // We need the latest messages on the cleanup side, but the effect should
  // only register once. Hold them in a ref that tracks state.
  const latestMessagesRef = useRef(state.messages);
  useEffect(() => {
    latestMessagesRef.current = state.messages;
  }, [state.messages]);
  useEffect(() => {
    return () => {
      conversationStore.update(conversationId, { messages: latestMessagesRef.current });
    };
  }, [conversationId]);

  // ── send ──────────────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string, attachments: AttachedFile[] = []) => {
      if (state.isStreaming) return;
      const userMsg: ConversationMessage = {
        id: newId("u"),
        role: "user",
        content: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        created_at: new Date().toISOString(),
      };
      dispatch({ type: "appendUser", message: userMsg });

      const assistantId = newId("a");
      dispatch({ type: "startAssistant", id: assistantId });

      const history = buildHistory(state.messages);
      const ac = new AbortController();
      abortRef.current = ac;

      const prompt = renderUserPrompt(text, attachments);
      try {
        await streamOrchestrator(
          prompt,
          history,
          {
            onEvent: (ev) => {
              dispatch({ type: "applyEvent", id: assistantId, event: ev });
            },
            onError: (e) => {
              dispatch({
                type: "applyEvent",
                id: assistantId,
                event: { kind: "error", payload: { message: e.message } },
              });
            },
          },
          { signal: ac.signal },
        );
      } finally {
        dispatch({ type: "finishAssistant" });
        abortRef.current = null;
      }
    },
    [state.isStreaming, state.messages],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "abortAssistant", reason: "stopped by user" });
  }, []);

  // Drop the trailing assistant-then-user-then-assistant chain back to the
  // last user message, then re-send it.
  const regenerate = useCallback(async () => {
    if (state.isStreaming) return;
    let lastUserIdx = -1;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const lastUser = state.messages[lastUserIdx];
    dispatch({ type: "truncateAfter", index: lastUserIdx - 1 });
    await send(lastUser.content, lastUser.attachments ?? []);
  }, [state.isStreaming, state.messages, send]);

  // Edit a previous user message: replace its content, drop everything after,
  // and re-send.
  const edit = useCallback(
    async (messageId: string, newText: string) => {
      if (state.isStreaming) return;
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx < 0 || state.messages[idx].role !== "user") return;
      dispatch({ type: "truncateAfter", index: idx - 1 });
      await send(newText);
    },
    [state.isStreaming, state.messages, send],
  );

  return {
    messages: state.messages,
    isStreaming: state.isStreaming,
    activeAssistantId: state.activeAssistantId,
    send,
    stop,
    regenerate,
    edit,
  };
}

// Expose the reducer for tests in checkpoint 15.
export const __testing__ = { reducer, mergeEvent, partsToMarkdown, buildHistory };
export type { Action, State };
