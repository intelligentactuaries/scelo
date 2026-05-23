import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChat, type ChatEvent, type StreamChatHandle } from '../lib/api';
import { renderChatMarkdown } from '../lib/chatMarkdown';

type ChatRole = 'user' | 'assistant';
interface ChatMsg {
  role: ChatRole;
  content: string;
  meta?: { provider: string; model: string };
  error?: boolean;
}

type Props = {
  runId: string | null;
  runReady: boolean;
  open: boolean;
  onToggle: () => void;
};

const SAMPLES = [
  'why did the actuaries dissent?',
  'show me what the conspiracy theorists said',
  'compare the council majority to the society majority',
  'which agents would change their vote if leverage were 1.2x instead of 2.1x?',
];

export function ChatBot({ runId, runReady, open, onToggle }: Props) {
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const handleRef = useRef<StreamChatHandle | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [history]);

  // reset history if the runId changes
  useEffect(() => {
    setHistory([]);
    setBusy(false);
    handleRef.current?.abort();
    handleRef.current = null;
  }, [runId]);

  const send = useCallback(
    (text: string) => {
      if (!runId || !runReady || !text.trim() || busy) return;
      const msg: ChatMsg = { role: 'user', content: text.trim() };
      const placeholder: ChatMsg = { role: 'assistant', content: '' };
      setHistory((h) => [...h, msg, placeholder]);
      setBusy(true);
      setInput('');
      const baseHistory = history.map((m) => ({ role: m.role, content: m.content }));
      const onEvent = (e: ChatEvent) => {
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
      };
      handleRef.current = streamChat(
        { runId, message: text.trim(), history: baseHistory },
        onEvent,
      );
    },
    [runId, runReady, busy, history],
  );

  const stop = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    setBusy(false);
    setHistory((h) => {
      const next = h.slice();
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && !last.content) {
        return next.slice(0, -1);
      }
      return next;
    });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send(input);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <footer className={`bottom-drawer ${open ? 'open' : 'collapsed'}`}>
      <button className="drawer-handle" onClick={onToggle}>
        <span>chatbot — {open ? 'collapse' : 'expand'}</span>
        <span className="muted small">
          {runReady ? 'ask the swarm' : runId ? 'waiting for run to finish' : 'run a scenario first'}
        </span>
      </button>
      {open && (
        <div className="chat-body">
          <div className="chat-scroller" ref={scrollerRef}>
            {history.length === 0 && (
              <div className="chat-empty muted small">
                <div>ask anything about this run — full council + society state is injected.</div>
                <div className="chat-samples">
                  {SAMPLES.map((s) => (
                    <button key={s} className="pill" disabled={!runReady || busy} onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {history.map((m, i) => (
              <div key={i} className={`chat-row ${m.role}`}>
                <div className="chat-author">
                  {m.role === 'user' ? 'professor' : m.error ? 'swarm · error' : 'swarm'}
                  {m.meta && !m.error && (
                    <span className="muted small">  {m.meta.provider}/{m.meta.model}</span>
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
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={runReady ? 'enter to send · esc to collapse' : 'run a scenario first'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={!runReady}
              rows={2}
            />
            {busy ? (
              <button className="ghost-btn" onClick={stop}>
                stop
              </button>
            ) : (
              <button
                className="primary-btn"
                disabled={!runReady || !input.trim()}
                onClick={() => send(input)}
              >
                ask
              </button>
            )}
          </div>
        </div>
      )}
    </footer>
  );
}
