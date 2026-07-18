import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { streamChat, type ChatEvent, type StreamChatHandle } from '../lib/api';
import { renderChatMarkdown } from '../lib/chatMarkdown';
import { PanelLeftIcon } from './Icons';

type ChatRole = 'user' | 'assistant';
interface ChatMsg {
  role: ChatRole;
  content: string;
  meta?: { provider: string; model: string };
  error?: boolean;
}

type Mode = 'chat' | 'refine';

type Props = {
  runId: string | null;
  runReady: boolean;
  onCollapse: () => void;
  /** Current scenario text — also the editable value in refine mode. */
  scenario: string;
  onScenarioChange: (s: string) => void;
  /** True while a swarm run is in progress (re-run button is disabled). */
  busy: boolean;
  /** Submit handler for refine mode: replaces the scenario and re-runs. */
  onRefine: (newScenario: string) => void;
  /** Extra root classes (used by the mobile shell to mark open state). */
  className?: string;
};

const CHAT_SAMPLES = [
  'why did the actuaries dissent?',
  'compare the council majority to the society majority',
  'which agents would change their vote if leverage were 1.2x?',
  'give justifications for the investors and actuaries',
];

export function ConversationPanel({
  runId,
  runReady,
  onCollapse,
  scenario,
  onScenarioChange,
  busy: runBusy,
  onRefine,
  className,
}: Props) {
  const [mode, setMode] = useState<Mode>('chat');
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const handleRef = useRef<StreamChatHandle | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inChat = mode === 'chat';

  useEffect(() => {
    setHistory([]);
    setBusy(false);
    handleRef.current?.abort();
    handleRef.current = null;
  }, [runId]);

  // Collapsing the panel unmounts it — abort any in-flight stream so the
  // fetch doesn't keep running against a component that no longer exists.
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [history]);

  // Auto-grow the input until the CSS max-height kicks in, after which
  // overflow-y: auto scrolls. Reacts to the current mode's value
  // (local chat input or the upstream scenario in refine mode).
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [input, scenario, mode]);

  const send = useCallback(
    (text: string) => {
      if (!runId || !runReady || !text.trim() || busy) return;
      const userMsg: ChatMsg = { role: 'user', content: text.trim() };
      const placeholder: ChatMsg = { role: 'assistant', content: '' };
      setHistory((h) => [...h, userMsg, placeholder]);
      setBusy(true);
      setInput('');
      const baseHistory = history.map((m) => ({ role: m.role, content: m.content }));
      handleRef.current = streamChat(
        { runId, message: text.trim(), history: baseHistory },
        (e: ChatEvent) => {
          if (e.type === 'chunk') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant' && !last.error) {
                next[next.length - 1] = { ...last, content: last.content + e.text };
              }
              return next;
            });
          } else if (e.type === 'done') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, meta: { provider: e.provider, model: e.model } };
              }
              return next;
            });
            setBusy(false);
            handleRef.current = null;
          } else if (e.type === 'error') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: e.message, error: true };
              }
              return next;
            });
            setBusy(false);
            handleRef.current = null;
          }
        },
      );
    },
    [runId, runReady, busy, history],
  );

  const stop = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    setBusy(false);
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last && last.role === 'assistant' && !last.content) return h.slice(0, -1);
      return h;
    });
  }, []);

  const submitRefine = () => {
    const next = scenario.trim();
    if (next && !runBusy) onRefine(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (inChat) send(input);
      else submitRefine();
    } else if (e.key === 'Enter' && !e.shiftKey && inChat) {
      // Chat: plain Enter sends. Refine: Enter is a newline (multi-line
      // scenarios are common) — only ⌘↵ submits.
      e.preventDefault();
      send(input);
    }
  };

  const subline = !runId
    ? 'run a scenario to start chatting'
    : !runReady
      ? 'waiting for the run to finish…'
      : inChat
        ? 'ask anything — full council + society state is injected'
        : 'edit the scenario and ⌘↵ to re-run the swarm';

  const placeholder = inChat
    ? runReady
      ? 'enter to send · shift+enter for newline'
      : 'run a scenario first'
    : 'type a refined scenario, ⌘↵ to re-run…';

  const submitDisabled = inChat
    ? !runReady || !input.trim()
    : runBusy || !scenario.trim();

  const onSubmit = () => {
    if (inChat) send(input);
    else submitRefine();
  };

  return (
    <section className={`conversation-panel ${className ?? ''}`}>
      <div className="conversation-panel-head">
        <span className="conversation-panel-title">Conversation</span>
        <button
          className="sidebar-toggle"
          onClick={onCollapse}
          title="collapse conversation"
          aria-label="collapse conversation"
        >
          <PanelLeftIcon />
        </button>
      </div>
      <div className="conversation-panel-sub muted small">{subline}</div>

      <div className="conversation-panel-scroller" ref={scrollerRef}>
        {history.length === 0 && runReady && (
          <div className="conversation-panel-samples">
            {CHAT_SAMPLES.map((s) => (
              <button
                key={s}
                className="pill"
                disabled={busy}
                onClick={() => send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`chat-row ${m.role}`}>
            <div className="chat-author">
              {m.role === 'user' ? 'you' : m.error ? 'swarm · error' : 'swarm'}
              {m.meta && !m.error && (
                <span className="muted small">
                  {' '}· {m.meta.provider}/{m.meta.model}
                </span>
              )}
            </div>
            <div
              className={`chat-content ${m.role === 'assistant' && !m.error ? 'chat-content-md' : ''} ${m.error ? 'status-warn' : ''}`}
            >
              {m.content
                ? m.role === 'assistant' && !m.error
                  ? renderChatMarkdown(m.content)
                  : m.content
                : <span className="muted">…</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="conversation-panel-mode-row">
        <div className="bottom-bar-mode" role="tablist" aria-label="input mode">
          <button
            role="tab"
            aria-selected={inChat}
            className={`mode-btn ${inChat ? 'is-active' : ''}`}
            onClick={() => setMode('chat')}
            title="chat with the swarm about this run"
          >
            chat
          </button>
          <button
            role="tab"
            aria-selected={!inChat}
            className={`mode-btn ${!inChat ? 'is-active' : ''}`}
            onClick={() => setMode('refine')}
            title="replace the scenario and re-run the swarm"
          >
            refine
          </button>
        </div>
      </div>

      <div className="conversation-panel-input-row">
        <textarea
          ref={inputRef}
          className="conversation-panel-input"
          placeholder={placeholder}
          value={inChat ? input : scenario}
          onChange={(e) =>
            inChat ? setInput(e.target.value) : onScenarioChange(e.target.value)
          }
          onKeyDown={onKeyDown}
          disabled={inChat && !runReady}
          rows={2}
        />
        {inChat && busy ? (
          <button className="ghost-btn" onClick={stop}>
            stop
          </button>
        ) : (
          <button
            className="primary-btn pill-btn"
            disabled={submitDisabled}
            onClick={onSubmit}
          >
            {inChat ? 'ask' : runBusy ? 'running…' : 're-run'}
          </button>
        )}
      </div>
    </section>
  );
}
