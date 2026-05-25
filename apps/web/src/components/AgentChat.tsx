// Orchestrator chat panel — streams events from /agents/orchestrator/stream.
// History is held client-side; we send the last 10 turns with each query.

import {
  API_BASE,
  type OrchestratorEvent,
  type OrchestratorMessage,
  streamOrchestrator,
} from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { StatusPip } from "./Message/StatusPip";

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | {
      kind: "tool_result";
      tool: string;
      output: unknown;
      duration_ms?: number;
    }
  | { kind: "message"; text: string }
  | { kind: "error"; text: string };

const HISTORY_TURNS = 10;

type ProviderStatus = {
  agent_provider: "ollama" | "hermes" | "rule_based_only";
  llm_label: "ollama" | "hermes" | "rule_based";
  llm_available: boolean;
  ollama_model: string;
  hermes_configured: boolean;
};

const STATUS_POLL_MS = 30_000;

export function AgentChat() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const scrollRef = useRef<HTMLUListElement>(null);

  // ── status: poll /agents/orchestrator/status every 30 s ──────────────────
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const r = await fetch(`${API_BASE}/agents/orchestrator/status`);
        if (!r.ok) return;
        const body = (await r.json()) as Partial<ProviderStatus>;
        if (cancelled) return;
        setStatus({
          agent_provider: body.agent_provider ?? "ollama",
          llm_label: body.llm_label ?? "rule_based",
          llm_available: Boolean(body.llm_available),
          ollama_model: body.ollama_model ?? "",
          hermes_configured: Boolean(body.hermes_configured),
        });
      } catch {
        if (!cancelled) {
          setStatus({
            agent_provider: "ollama",
            llm_label: "rule_based",
            llm_available: false,
            ollama_model: "",
            hermes_configured: false,
          });
        }
      }
    };
    void fetchStatus();
    const id = window.setInterval(fetchStatus, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // ── auto-scroll on new items ────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const appendItem = (it: ChatItem) => setItems((xs) => [...xs, it]);

  const buildHistory = (): OrchestratorMessage[] => {
    const turns: OrchestratorMessage[] = [];
    for (const it of items) {
      if (it.kind === "user") turns.push({ role: "user", content: it.text });
      else if (it.kind === "message") turns.push({ role: "assistant", content: it.text });
    }
    return turns.slice(-HISTORY_TURNS);
  };

  const onEvent = (ev: OrchestratorEvent) => {
    switch (ev.kind) {
      case "thinking":
        appendItem({ kind: "thinking", text: ev.payload.text });
        break;
      case "tool_call":
        appendItem({
          kind: "tool_call",
          tool: ev.payload.tool,
          arguments: ev.payload.arguments ?? {},
        });
        break;
      case "tool_result":
        appendItem({
          kind: "tool_result",
          tool: ev.payload.tool,
          output: ev.payload.output,
          duration_ms: ev.payload.duration_ms,
        });
        break;
      case "message":
        appendItem({ kind: "message", text: ev.payload.text });
        break;
      case "error":
        appendItem({ kind: "error", text: ev.payload.message });
        break;
      case "done":
        // No-op; the input is re-enabled in `send`'s finally.
        break;
    }
  };

  const send = async () => {
    const query = draft.trim();
    if (!query || pending) return;
    setPending(true);
    appendItem({ kind: "user", text: query });
    setDraft("");
    const history = buildHistory();
    await streamOrchestrator(
      query,
      history,
      {
        onEvent,
        onError: (e) => appendItem({ kind: "error", text: e.message }),
      },
      undefined,
    );
    setPending(false);
  };

  return (
    <div className="flex h-full flex-col panel">
      <div className="flex items-center justify-between border-b border-border bg-bg-2 px-2 py-1 text-[11px] uppercase text-fg-mute">
        <span>orchestrator</span>
        {renderStatusIndicator(status)}
      </div>
      <ul ref={scrollRef} className="flex-1 space-y-1 overflow-auto p-2 text-sm">
        {items.length === 0 && (
          <li className="text-fg-mute">
            ask the orchestrator anything actuarial — try{" "}
            <code className="text-primary">"what's the IBNR for the RAA triangle?"</code>
          </li>
        )}
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only
          <li key={i}>{renderItem(it)}</li>
        ))}
        {pending && (
          <li>
            <StatusPip mode="processing" />
          </li>
        )}
      </ul>
      <div className="flex items-end gap-2 border-t border-border bg-bg-2 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="ask the orchestrator… (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-fg-dim"
          disabled={pending}
        />
        <button
          type="button"
          onClick={send}
          disabled={pending || draft.trim().length === 0}
          className="border border-primary bg-primary/10 px-3 py-1 text-xs font-mono text-primary hover:bg-primary/20 disabled:opacity-30"
        >
          send
        </button>
      </div>
    </div>
  );
}

function renderStatusIndicator(status: ProviderStatus | null) {
  if (status === null) {
    return (
      <span className="text-fg-mute" title="checking…">
        ○ checking
      </span>
    );
  }
  // Ollama path — default in ADR-0008.
  if (status.agent_provider === "ollama") {
    if (status.llm_available) {
      const short = status.ollama_model.split(":")[0] || "qwen";
      return (
        <span className="text-primary" title={`Ollama (${status.ollama_model}) — local, on-device`}>
          ● Ollama ({short}) — local
        </span>
      );
    }
    return (
      <span
        className="text-amber-400"
        title="Ollama unreachable — falling back to deterministic routing"
      >
        ● Ollama unreachable — fallback
      </span>
    );
  }
  if (status.agent_provider === "hermes") {
    if (status.llm_available) {
      return (
        <span className="text-blue-400" title="Hermes — cloud">
          ● Hermes — cloud
        </span>
      );
    }
    return (
      <span
        className="text-fg-dim"
        title="deterministic routing — set HERMES_API_KEY for LLM orchestration"
      >
        deterministic
      </span>
    );
  }
  return (
    <span className="text-fg-dim" title="IA_AGENT_PROVIDER=rule_based_only">
      ○ deterministic — no LLM
    </span>
  );
}

function renderItem(it: ChatItem) {
  switch (it.kind) {
    case "user":
      return (
        <div className="text-accent-2">
          <span className="mr-2 text-xs uppercase text-fg-dim">user</span>
          {it.text}
        </div>
      );
    case "thinking":
      return (
        <details className="text-fg-mute italic">
          <summary className="cursor-pointer text-xs uppercase text-fg-dim">thinking…</summary>
          <div className="mt-1 whitespace-pre-wrap text-xs">{it.text}</div>
        </details>
      );
    case "tool_call":
      return (
        <div className="border-l border-primary bg-primary/5 px-2 py-1 font-mono text-xs text-primary">
          → {it.tool}
          <span className="text-fg-dim">
            ({Object.keys(it.arguments).length} arg
            {Object.keys(it.arguments).length === 1 ? "" : "s"})
          </span>
        </div>
      );
    case "tool_result":
      return (
        <details className="border-l border-primary bg-primary/5 px-2 py-1 text-xs">
          <summary className="cursor-pointer">
            <span className="font-mono text-primary">✓ {it.tool}</span>
            {it.duration_ms !== undefined && (
              <span className="text-fg-dim"> · {it.duration_ms}ms</span>
            )}{" "}
            <span className="text-fg-mute">— view details</span>
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-fg-mute">
            {JSON.stringify(it.output, null, 2)}
          </pre>
        </details>
      );
    case "message":
      return (
        <div className="text-primary">
          <span className="mr-2 text-xs uppercase text-fg-dim">orchestrator</span>
          {it.text}
        </div>
      );
    case "error":
      return (
        <div className="border border-error bg-error/10 px-2 py-1 text-xs text-error">
          <span className="mr-2 uppercase">error</span>
          {it.text}
        </div>
      );
  }
}
