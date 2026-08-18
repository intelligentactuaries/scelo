// Member interview — talk to ONE council professional or ONE society
// citizen about the position they recorded, and watch whether they stay
// consistent with it. This is the audit surface behind "can I trust these
// results?": pick a member at random, ask why, push back, ask for the theory.
//
// What the drawer shows, top to bottom:
//   • the member's card — who they are and exactly what they recorded
//     (verdict + confidence + key risk + intervention for a professional;
//     reaction + sentiment + intensity for a citizen), and for professionals
//     the framework / theories they justified the vote with, when written;
//   • the transcript (persisted server-side; reopening a member resumes it),
//     each reply carrying a CONSISTENT / DRIFT / UNVERIFIED badge from the
//     server's check of the member's restated position against the record;
//   • the input, with a shuffle to jump to another random member of the
//     same section, and prompts that probe consistency.
//
// The machine-read footer the member ends each reply with is stripped from
// the displayed text; the badge is what the reader sees.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CouncilAgentResult, JustificationResponse, Run, SocietyAgentResult, Sentiment } from '../../shared/types';
import { colorsForTheme, professionColor, type LegalJurisdiction } from '../../shared/constants';
import {
  memberApi,
  streamMemberChat,
  type InterviewTurnMeta,
  type StreamChatHandle,
} from '../lib/api';
import { renderChatMarkdown } from '../lib/chatMarkdown';
import { sentimentColors } from '../lib/societyPalette';
import { STANCE_CLASS, STANCE_LABEL } from '../lib/stance';
import { useTheme } from '../lib/theme';

export type InterviewTarget = { kind: 'council' | 'society'; agentId: string };

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  meta?: InterviewTurnMeta | null;
  provider?: string | null;
  model?: string | null;
  error?: boolean;
  /** true while the assistant reply is still streaming */
  streaming?: boolean;
}

const FOOTER_RE = /\[\[\s*(position|sentiment)\s*:\s*[a-z]+\s*\|\s*\d{1,3}\s*\]\]\s*$/i;
function stripFooter(s: string): string {
  return s.replace(FOOTER_RE, '').trim();
}

const COUNCIL_PROBES = [
  'Why did you land where you did — walk me through it in your own words.',
  'Which theory or formula from your profession carries the most weight in your vote, and how does it apply here?',
  'What would have to be true for you to change your verdict?',
  'Your round 1 and your final vote — reconcile them for me.',
];
const SOCIETY_PROBES = [
  'Why do you feel that way about it?',
  'What in your own life makes you react like this?',
  'If someone told you the forecast was wrong, would you feel differently?',
  'What would make you feel more positive about it?',
];

/** Uniform random member of a section, avoiding the current one. */
export function pickRandomMember(run: Run, kind: 'council' | 'society', avoid?: string | null): string | null {
  const pool =
    kind === 'council'
      ? run.councilResults.map((r) => r.agent.id)
      : run.societyResults.filter((r) => r.reaction !== '(error)').map((r) => r.agent.id);
  const candidates = pool.length > 1 && avoid ? pool.filter((id) => id !== avoid) : pool;
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function MemberInterview({
  run,
  target,
  legalJurisdiction,
  onClose,
  onRetarget,
}: {
  run: Run;
  target: InterviewTarget;
  legalJurisdiction: LegalJurisdiction;
  onClose: () => void;
  /** Open a different member (shuffle / follow a link). */
  onRetarget: (t: InterviewTarget) => void;
}) {
  const dark = useTheme().resolved === 'dark';
  const council = target.kind === 'council' ? run.councilResults.find((r) => r.agent.id === target.agentId) : undefined;
  const society = target.kind === 'society' ? run.societyResults.find((r) => r.agent.id === target.agentId) : undefined;

  const [history, setHistory] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [justification, setJustification] = useState<JustificationResponse | null>(null);
  const handleRef = useRef<StreamChatHandle | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load the persisted transcript for this member (audit trail survives
  // reloads and reopenings) and, for professionals, their written
  // justification so the card can name the framework they used.
  useEffect(() => {
    let cancelled = false;
    handleRef.current?.abort();
    handleRef.current = null;
    setBusy(false);
    setHistory([]);
    setJustification(null);
    setLoading(true);
    memberApi
      .transcript(run.id, target.agentId)
      .then((res) => {
        if (cancelled) return;
        setHistory(
          res.turns.map((t) => ({
            role: t.role,
            content: t.content,
            meta: t.meta,
            provider: t.provider,
            model: t.model,
          })),
        );
      })
      .catch(() => {
        /* no transcript yet — fine */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    if (target.kind === 'council') {
      memberApi
        .justification(run.id, target.agentId)
        .then((j) => {
          if (!cancelled) setJustification(j);
        })
        .catch(() => {
          /* none written yet */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [run.id, target.agentId, target.kind]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    return () => {
      handleRef.current?.abort();
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      const msg = text.trim();
      if (!msg || busy) return;
      const base = history.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      setHistory((h) => [...h, { role: 'user', content: msg }, { role: 'assistant', content: '', streaming: true }]);
      setBusy(true);
      setInput('');
      handleRef.current = streamMemberChat(
        run.id,
        target.agentId,
        { message: msg, history: base, legalJurisdiction },
        (e) => {
          if (e.type === 'chunk') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last?.role === 'assistant' && !last.error) next[next.length - 1] = { ...last, content: last.content + e.text };
              return next;
            });
          } else if (e.type === 'done') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = { ...last, meta: e.meta, provider: e.provider, model: e.model, streaming: false };
              }
              return next;
            });
            setBusy(false);
            handleRef.current = null;
          } else if (e.type === 'error') {
            setHistory((h) => {
              const next = h.slice();
              const last = next[next.length - 1];
              if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: e.message, error: true, streaming: false };
              return next;
            });
            setBusy(false);
            handleRef.current = null;
          }
        },
      );
    },
    [busy, history, legalJurisdiction, run.id, target.agentId],
  );

  const stop = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    setBusy(false);
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last?.role === 'assistant' && !last.content) return h.slice(0, -1);
      if (last?.role === 'assistant' && last.streaming) return [...h.slice(0, -1), { ...last, streaming: false }];
      return h;
    });
  }, []);

  const shuffle = () => {
    const next = pickRandomMember(run, target.kind, target.agentId);
    if (next) onRetarget({ kind: target.kind, agentId: next });
  };

  const tally = useMemo(() => {
    let consistent = 0;
    let drift = 0;
    let unverified = 0;
    for (const m of history) {
      if (m.role !== 'assistant' || m.error || m.streaming) continue;
      if (!m.meta || m.meta.consistent === null) unverified += 1;
      else if (m.meta.consistent) consistent += 1;
      else drift += 1;
    }
    return { consistent, drift, unverified, total: consistent + drift + unverified };
  }, [history]);

  const probes = target.kind === 'council' ? COUNCIL_PROBES : SOCIETY_PROBES;
  const missing = !council && !society;

  return (
    <aside className="member-interview" aria-label="member interview">
      <div className="member-interview-head">
        <div className="member-interview-title">
          <span className="panel-label">audit interview · {target.kind === 'council' ? 'council member' : 'society member'}</span>
          <button className="ghost-btn" onClick={shuffle} title={`pick another random ${target.kind} member`}>
            🎲 shuffle
          </button>
        </div>
        <button className="ghost-btn" onClick={onClose} title="close the interview">
          close
        </button>
      </div>

      {missing ? (
        <div className="member-interview-body muted small">member {target.agentId} is not in this run.</div>
      ) : (
        <>
          {council && <CouncilCard r={council} dark={dark} justification={justification} />}
          {society && <SocietyCard r={society} dark={dark} run={run} />}

          <div className="member-interview-tally muted small">
            {tally.total === 0 ? (
              <span>no replies yet — every reply is checked against the recorded {target.kind === 'council' ? 'verdict' : 'sentiment'} and logged for audit</span>
            ) : (
              <>
                <span className="status-ok">{tally.consistent} consistent</span>
                {' · '}
                <span className={tally.drift ? 'status-warn' : ''}>{tally.drift} drift</span>
                {' · '}
                <span>{tally.unverified} unverified</span>
              </>
            )}
          </div>

          <div className="member-interview-scroller" ref={scrollerRef}>
            {loading && <div className="muted small">loading transcript…</div>}
            {!loading && history.length === 0 && (
              <div className="member-interview-probes">
                {probes.map((p) => (
                  <button key={p} className="pill" disabled={busy} onClick={() => send(p)}>
                    {p}
                  </button>
                ))}
              </div>
            )}
            {history.map((m, i) => (
              <div key={i} className={`chat-row ${m.role}`}>
                <div className="chat-author">
                  {m.role === 'user' ? 'you' : m.error ? `${target.agentId} · error` : target.agentId}
                  {m.role === 'assistant' && !m.error && !m.streaming && <ConsistencyBadge meta={m.meta ?? null} kind={target.kind} />}
                  {m.provider && !m.error && (
                    <span className="muted small">
                      {' '}
                      · {m.provider}/{m.model}
                    </span>
                  )}
                </div>
                <div className={`chat-content ${m.role === 'assistant' && !m.error ? 'chat-content-md' : ''} ${m.error ? 'status-warn' : ''}`}>
                  {m.content ? (
                    m.role === 'assistant' && !m.error ? (
                      renderChatMarkdown(m.streaming ? m.content : stripFooter(m.content))
                    ) : (
                      m.content
                    )
                  ) : (
                    <span className="muted">…</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="member-interview-input-row">
            <textarea
              ref={inputRef}
              className="conversation-panel-input"
              placeholder={`ask ${target.agentId} anything · enter to send`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={2}
            />
            {busy ? (
              <button className="ghost-btn" onClick={stop}>
                stop
              </button>
            ) : (
              <button className="primary-btn pill-btn" disabled={!input.trim()} onClick={() => send(input)}>
                ask
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────────

function CouncilCard({
  r,
  dark,
  justification,
}: {
  r: CouncilAgentResult;
  dark: boolean;
  justification: JustificationResponse | null;
}) {
  const a = r.agent;
  const riskLabel = r.finalStance === 'support' ? 'what it gets right' : r.finalStance === 'abstain' ? 'evidence still needed' : 'key risk';
  const r1 = r.rounds.find((x) => x.round === 1);
  const r2 = r.rounds.find((x) => x.round === 2);
  return (
    <div className="member-card" style={{ borderLeft: `3px solid ${professionColor(a.profession, dark)}` }}>
      <div className="member-card-id">
        <span className="agent-id">{a.id}</span>
        <span className="muted small">
          {a.profession} · {a.mbti} · {a.gender}
        </span>
      </div>
      <div className="member-card-grid">
        <div>
          <div className="panel-label">recorded verdict</div>
          <div className={`member-card-big ${STANCE_CLASS[r.finalStance]}`}>{STANCE_LABEL[r.finalStance]}</div>
        </div>
        <div>
          <div className="panel-label">confidence</div>
          <div className="member-card-big num">{r.finalConfidence}</div>
        </div>
        <div>
          <div className="panel-label">rounds</div>
          <div className="small">
            r1 {r1?.confidence ?? '–'} → r2 {r2?.confidence ?? '–'} → r3 {r.finalConfidence}
          </div>
        </div>
      </div>
      <div className="small">
        <span className="panel-label">{riskLabel}</span> {r.keyRisk}
      </div>
      {r.intervention && (
        <div className="small muted">
          recommends: {r.intervention.direction} {r.intervention.param} ({r.intervention.magnitude}) — {r.intervention.rationale}
        </div>
      )}
      <div className="small">
        <span className="panel-label">theory on record</span>{' '}
        {justification ? (
          <>
            {justification.justification.framework}
            {justification.justification.formulas.length > 0 && (
              <span className="muted"> · formulas: {justification.justification.formulas.map((f) => f.name).join(', ')}</span>
            )}
            {justification.justification.citations.length > 0 && (
              <span className="muted"> · cites {justification.justification.citations.length}</span>
            )}
          </>
        ) : (
          <span className="muted">no written justification yet — the member reasons from the {a.profession} toolkit and says so</span>
        )}
      </div>
    </div>
  );
}

function SocietyCard({ r, dark, run }: { r: SocietyAgentResult; dark: boolean; run: Run }) {
  const a = r.agent;
  const colors = sentimentColors(colorsForTheme(dark ? 'dark' : 'light'));
  const cluster = r.cluster !== undefined ? run.societySummary?.clusters.find((c) => c.cluster === r.cluster) : undefined;
  return (
    <div className="member-card" style={{ borderLeft: `3px solid ${colors[r.sentiment as Sentiment]}` }}>
      <div className="member-card-id">
        <span className="agent-id">{a.id}</span>
        <span className="muted small">
          {a.age}y · {a.incomeBand} income · {a.region} · {a.employment} · {a.education} · {a.culture}
        </span>
      </div>
      <div className="member-card-grid">
        <div>
          <div className="panel-label">recorded sentiment</div>
          <div className="member-card-big" style={{ color: colors[r.sentiment as Sentiment] }}>
            {r.sentiment}
          </div>
        </div>
        <div>
          <div className="panel-label">intensity</div>
          <div className="member-card-big num">{r.intensity}</div>
        </div>
        {cluster && (
          <div>
            <div className="panel-label">group</div>
            <div className="small">
              c{cluster.cluster} · {cluster.size} people
            </div>
          </div>
        )}
      </div>
      <div className="small">
        <span className="panel-label">reaction</span> “{r.reaction}”
      </div>
      {cluster && <div className="small muted">{cluster.description}</div>}
    </div>
  );
}

function ConsistencyBadge({ meta, kind }: { meta: InterviewTurnMeta | null; kind: 'council' | 'society' }) {
  if (!meta || meta.consistent === null) {
    return (
      <span className="consistency-badge is-unverified" title="the member did not end with a machine-readable position line, so this reply could not be checked automatically">
        unverified
      </span>
    );
  }
  const label = (l: string) => (kind === 'council' ? (STANCE_LABEL as Record<string, string>)[l] ?? l : l);
  const delta = meta.scoreDelta ?? 0;
  const deltaTxt = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta})`;
  if (meta.consistent) {
    return (
      <span
        className="consistency-badge is-ok"
        title={`restated ${label(meta.restated?.label ?? '')} ${meta.restated?.score ?? ''} vs recorded ${label(meta.recorded.label)} ${meta.recorded.score}`}
      >
        consistent · {label(meta.restated?.label ?? '')} {meta.restated?.score}
        {deltaTxt}
      </span>
    );
  }
  return (
    <span
      className="consistency-badge is-drift"
      title={`the member restated ${label(meta.restated?.label ?? '')} but recorded ${label(meta.recorded.label)} — read the reply for whether the change was explained`}
    >
      drift · said {label(meta.restated?.label ?? '')} {meta.restated?.score}, recorded {label(meta.recorded.label)} {meta.recorded.score}
    </span>
  );
}
