// Chat thread route. Three-column layout: sidebar (left), thread (center),
// input (bottom). The SSE consumer lives in lib/chatStream.ts; this file
// composes it with the existing Header / Sidebar / ChatInput shells.

import { ChatInput } from "@/components/ChatInput";
import { ConversationSidebar } from "@/components/ConversationSidebar";
import { Header } from "@/components/Header";
import { AssistantMessage } from "@/components/Message/AssistantMessage";
import { UserMessage } from "@/components/Message/UserMessage";
import { classifyFile } from "@/lib/api";
import { useChatStream } from "@/lib/chatStream";
import { conversationStore } from "@/lib/conversations";
import type { AttachedFile, Conversation } from "@/lib/conversations";
import { commandRest, parseCommand } from "@/lib/slashCommands";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type Props = { conversationId: string };

export default function Chat({ conversationId }: Props) {
  const [conversation, setConversation] = useState<Conversation | null>(() =>
    conversationStore.get(conversationId),
  );
  // Collapse the sidebar by default on narrow screens — saves the chat
  // column its full readable width on phones / tablets without us having
  // to write breakpoint-specific layouts.
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 768 : false,
  );
  const [pendingAttachments, setPendingAttachments] = useState<AttachedFile[]>([]);
  const [isClassifying, setIsClassifying] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { messages, isStreaming, activeAssistantId, send, stop, regenerate, edit } =
    useChatStream(conversationId);

  const onPickFile = useCallback(
    async (file: File) => {
      setIsClassifying(true);
      setUploadError(null);
      const r = await classifyFile(conversationId, file);
      setIsClassifying(false);
      if (!r.ok) {
        setUploadError(`upload failed: ${r.error.message}`);
        return;
      }
      setPendingAttachments((prev) => [
        ...prev,
        {
          filename: r.value.filename,
          bytes: r.value.bytes,
          saved_path: r.value.saved_path,
          classification: {
            specialist: r.value.specialist,
            confidence: r.value.confidence,
            reasoning: r.value.reasoning,
            suggested_capability: r.value.suggested_capability,
          },
        },
      ]);
    },
    [conversationId],
  );

  const onSend = useCallback(
    (text: string, attachments: AttachedFile[]) => {
      // Slash commands intercept before the orchestrator sees them.
      const cmd = parseCommand(text);
      if (cmd) {
        const rest = commandRest(text);
        if (cmd.name === "/help") {
          // Surface the help message as a fake assistant turn so the user
          // doesn't have to reach for docs. We piggy-back on send() with
          // a self-answering local prompt.
          void send("(slash command) /help — list of available commands and tips.", []);
          setPendingAttachments([]);
          return;
        }
        if (cmd.name === "/dashboards") {
          navigate("/dashboards");
          return;
        }
        if (cmd.name === "/clear") {
          if (!confirm("Clear this conversation? This cannot be undone.")) return;
          conversationStore.update(conversationId, { messages: [] });
          // Force a remount via the conversationId-scoped reducer reload.
          window.location.reload();
          return;
        }
        if (cmd.name === "/export") {
          const blob = conversationStore.export(conversationId);
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${conversationId}.json`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        }
        if (cmd.forwardToOrchestrator) {
          // /wiki <q> and /regulatory <q> — forward to the orchestrator
          // as a natural-language search prompt.
          const verb = cmd.name === "/wiki" ? "wiki search" : "regulatory search";
          const query = rest || "(no query)";
          void send(`${verb}: ${query}`, attachments);
          setPendingAttachments([]);
          return;
        }
      }
      void send(text, attachments);
      setPendingAttachments([]);
    },
    [send, navigate, conversationId],
  );

  const onBranchAt = useCallback(
    (messageIndex: number) => {
      const conv = conversationStore.branch(conversationId, messageIndex);
      if (conv) navigate(`/c/${conv.id}`);
    },
    [conversationId, navigate],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep conversation metadata (title, branched_from) in sync when the route
  // id changes. The messages themselves come from useChatStream.
  useEffect(() => {
    setConversation(conversationStore.get(conversationId));
  }, [conversationId]);

  // Auto-scroll to bottom on new messages or streaming updates. We bypass
  // when the user has manually scrolled up — scroll position is checked
  // before commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the explicit reactive trigger; the ref is stable.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (conversation === null) {
    return (
      <div className="flex h-full w-full">
        <ConversationSidebar
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main className="flex flex-1 items-center justify-center text-fg-mute text-sm">
            conversation not found —{" "}
            <a href="/" className="ml-1 text-primary hover:underline">
              start a new one
            </a>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <ConversationSidebar
        version={messages.length}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header conversationTitle={conversation.title} />
        <main className="flex flex-1 flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col gap-6 px-4 py-6">
              {messages.length === 0 ? (
                <EmptyState
                  onPickExample={(q) => {
                    void send(q, []);
                  }}
                  onOpenDashboard={(path) => navigate(path)}
                />
              ) : (
                messages.map((m, idx) =>
                  m.role === "user" ? (
                    <UserMessage
                      key={m.id}
                      message={m}
                      onEdit={(text) => {
                        void edit(m.id, text);
                      }}
                    />
                  ) : (
                    <AssistantMessage
                      key={m.id}
                      message={m}
                      isStreaming={isStreaming && m.id === activeAssistantId}
                      onRegenerate={
                        idx === messages.length - 1
                          ? () => {
                              void regenerate();
                            }
                          : undefined
                      }
                      onBranch={() => onBranchAt(idx)}
                    />
                  ),
                )
              )}
            </div>
          </div>
          {uploadError && (
            <div className="mx-auto w-full max-w-[720px] px-4">
              <div className="border border-error bg-error/10 px-3 py-2 font-mono text-error text-xs">
                {uploadError}{" "}
                <button
                  type="button"
                  onClick={() => setUploadError(null)}
                  className="ml-2 text-fg-dim hover:text-fg"
                >
                  dismiss
                </button>
              </div>
            </div>
          )}
          <ChatInput
            onSend={onSend}
            onStop={stop}
            isStreaming={isStreaming}
            onPickFile={onPickFile}
            pendingAttachments={pendingAttachments}
            onRemoveAttachment={(i) =>
              setPendingAttachments((prev) => prev.filter((_, j) => j !== i))
            }
            isClassifying={isClassifying}
            draftKey={conversationId}
          />
        </main>
      </div>
    </div>
  );
}

type Example = { label: string; prompt?: string; dashboardPath?: string };

function EmptyState({
  onPickExample,
  onOpenDashboard,
}: {
  onPickExample: (q: string) => void;
  onOpenDashboard: (path: string) => void;
}) {
  const examples: Example[] = [
    { label: "what is the IBNR for the RAA triangle?" },
    { label: "Lee–Carter projection for South African males to 2050" },
    { label: "simulate survival modelling for age 65 under a longevity wave" },
    { label: "explain SAM SCR vs Solvency II SCR" },
    { label: "GLM pricing on the freMTPL2 sample with bonus-malus" },
  ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="font-mono text-fg-dim text-xs uppercase">new conversation</div>
      <h1 className="mt-2 text-fg text-xl">Ask the orchestrator</h1>
      <p className="mt-2 max-w-md text-fg-mute text-sm">
        Eight specialists across reserving, mortality, pensions, pricing, climate, capital,
        regulatory, and documentation. Routed by the orchestrator.
      </p>
      <ul className="mt-6 grid w-full max-w-md grid-cols-1 gap-2 text-left">
        {examples.map((example) => (
          <li key={example.label}>
            <button
              type="button"
              onClick={() =>
                example.dashboardPath
                  ? onOpenDashboard(example.dashboardPath)
                  : onPickExample(example.prompt ?? example.label)
              }
              className="block w-full rounded border border-border bg-bg-1 px-3 py-2 text-left font-mono text-fg-mute text-xs hover:border-primary hover:text-fg"
            >
              {example.label}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-fg-dim text-xs">
        Click an example, or type below — Enter sends, Shift+Enter inserts a newline.
      </p>
    </div>
  );
}
