// The IDE-wide global workspace panel.
//
// A small, capacity-limited list of the nameable, causally-validated facts
// currently "in play" across the pipeline: a validated workspace direction from
// Hard Data, a decision-relevant driver flagged in Soft, an ignited synthesis
// from the Swarm. This is the literal instantiation of "verbalizable
// representations form a global workspace" for the IDE itself. Facts arrive on
// the workspaceFactsBus; each can be sent into the AI panel or dismissed.

import { emitAiPrompt, emitOpenAiPanel } from "@/lib/aiPanelBus";
import {
  type WorkspaceFact,
  getWorkspaceFacts,
  removeWorkspaceFact,
  subscribeWorkspaceFacts,
} from "@/lib/workspaceFactsBus";
import { useEffect, useState } from "react";

const SURFACE_ACCENT: Record<WorkspaceFact["surface"], string> = {
  soft: "text-accent-2",
  tools: "text-warn",
  hard: "text-accent-3",
  swarm: "text-primary",
};

export default function WorkspacePanel() {
  const [facts, setFacts] = useState<WorkspaceFact[]>(() => getWorkspaceFacts());

  useEffect(() => subscribeWorkspaceFacts(setFacts), []);

  const sendToChat = (f: WorkspaceFact) => {
    emitOpenAiPanel();
    emitAiPrompt({
      text: `In the workspace, ${f.label}${f.detail ? ` (${f.detail})` : ""}. What should I make of this?`,
      autoSend: false,
    });
  };

  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
          global workspace · facts in play
        </span>
        <span className="font-mono text-[10px] text-fg-dim">{facts.length}</span>
      </div>
      {facts.length === 0 ? (
        <div className="p-3 text-[11px] leading-relaxed text-fg-dim">
          The small, nameable, causally-validated set of facts in play appears here. Extract a
          model's workspace in Hard Data, preview decision-relevance in Soft Data, or convene the
          Swarm to broadcast one.
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {facts.map((f) => (
            <li key={f.id} className="group border-b border-border/60 px-2 py-1.5 hover:bg-bg-2">
              <div className="flex items-start justify-between gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`font-mono text-[8px] uppercase tracking-wider ${SURFACE_ACCENT[f.surface]}`}
                    >
                      {f.surface}
                    </span>
                    <span
                      className="font-mono text-[8px] uppercase tracking-wider"
                      style={{
                        color: f.validated ? "rgb(var(--rgb-primary))" : "rgb(var(--rgb-fg-dim))",
                      }}
                      title={f.validated ? "survived a causal intervention" : "not yet validated"}
                    >
                      {f.validated ? "● validated" : "○ preview"}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-fg" title={f.detail ?? f.label}>
                    {f.label}
                  </div>
                  {f.detail && <div className="truncate text-[10px] text-fg-mute">{f.detail}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => sendToChat(f)}
                    title="ask scelo about this"
                    className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-fg-mute hover:border-primary hover:text-primary"
                  >
                    ↳ ask
                  </button>
                  <button
                    type="button"
                    onClick={() => removeWorkspaceFact(f.id)}
                    title="dismiss"
                    className="rounded border border-border px-1 py-0.5 font-mono text-[9px] text-fg-mute hover:border-error hover:text-error"
                  >
                    ×
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
