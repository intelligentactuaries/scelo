import { useMemo } from 'react';
import type { Run, Sentiment } from '../../shared/types';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { SENTIMENT_ORDER, sentimentColors } from '../lib/societyPalette';
import type { SocietyPin } from './SocietyGraph';

const REACTION_WORDS = 12;

// Word-based truncation — clip to N words and append … if there's more.
// Returns the visible text and (when truncated) the full text for a
// hover tooltip, so the user can still read the whole reaction without
// the card growing.
function clipReaction(
  s: string,
  n: number = REACTION_WORDS,
): { text: string; full: string | null } {
  const trimmed = s.trim();
  const words = trimmed.split(/\s+/u).filter(Boolean);
  if (words.length <= n) return { text: words.join(' '), full: null };
  return { text: words.slice(0, n).join(' ') + '…', full: trimmed };
}

type Props = {
  run: Run;
  pin: SocietyPin;
  onClose: () => void;
};

// Decision-sidebar content for the Society tab. Renders one of two shapes
// depending on what the user pinned in the legend:
//   - cluster  → c0..c5 demographic + sentiment-mix
//   - sentiment → "supportive" / "skeptical" / etc. group profile
export function SocietyInspector({ run, pin, onClose }: Props) {
  if (pin.kind === 'cluster') {
    return <ClusterInspector run={run} clusterName={pin.name} onClose={onClose} />;
  }
  return <SentimentInspector run={run} sentiment={pin.name} onClose={onClose} />;
}

function ClusterInspector({
  run,
  clusterName,
  onClose,
}: {
  run: Run;
  clusterName: string;
  onClose: () => void;
}) {
  const SENTIMENT_COLORS = sentimentColors(colorsForTheme(useTheme().resolved));
  // cluster ids are "c0", "c1" etc. — strip the prefix to index.
  const idx = Number.parseInt(clusterName.replace(/^c/, ''), 10);
  const summary = run.societySummary?.clusters.find((c) => c.cluster === idx);
  const members = useMemo(
    () => run.societyResults.filter((r) => r.cluster === idx),
    [run, idx],
  );

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="agent-tag">
          <div className="agent-id">Cluster {clusterName}</div>
          <div className="muted small">
            {summary?.size ?? members.length} agents · society cluster
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>
          close
        </button>
      </div>
      {summary?.description && (
        <div className="inspector-vote">
          <div className="muted small" style={{ gridColumn: '1 / -1' }}>
            {summary.description}
          </div>
        </div>
      )}
      <div className="inspector-body">
        <div className="panel-label">sentiment mix</div>
        {summary && <SentimentBar mix={summary.sentimentMix} total={summary.size} />}
        {members.length > 0 && (
          <>
            <div className="panel-label">sample members</div>
            <div className="society-members">
              {members.slice(0, 12).map((m) => (
                <div key={m.agent.id} className="society-member-card">
                  <div className="society-member-meta">
                    <span className="muted small">
                      age {m.agent.age} · {m.agent.education}
                    </span>
                    <span
                      className="small"
                      style={{ color: SENTIMENT_COLORS[m.sentiment] }}
                    >
                      {m.sentiment}
                    </span>
                    <span className="num small">{Math.round(m.intensity)}</span>
                  </div>
                  <ReactionLine reaction={m.reaction} />
                </div>
              ))}
              {members.length > 12 && (
                <div className="muted small">…and {members.length - 12} more</div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function SentimentInspector({
  run,
  sentiment,
  onClose,
}: {
  run: Run;
  sentiment: Sentiment;
  onClose: () => void;
}) {
  const SENTIMENT_COLORS = sentimentColors(colorsForTheme(useTheme().resolved));
  const members = useMemo(
    () => run.societyResults.filter((r) => r.sentiment === sentiment),
    [run, sentiment],
  );
  const total = run.societyResults.length;
  const avgIntensity = useMemo(() => {
    if (members.length === 0) return 0;
    return members.reduce((s, m) => s + m.intensity, 0) / members.length;
  }, [members]);

  // simple demographic rollups
  const educationMix = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of members) out.set(m.agent.education, (out.get(m.agent.education) ?? 0) + 1);
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [members]);

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="agent-tag" style={{ borderLeft: `3px solid ${SENTIMENT_COLORS[sentiment]}` }}>
          <div className="agent-id" style={{ textTransform: 'capitalize' }}>
            {sentiment} group
          </div>
          <div className="muted small">
            {members.length} of {total} agents · {Math.round((members.length / Math.max(1, total)) * 100)}%
          </div>
        </div>
        <button className="ghost-btn" onClick={onClose}>
          close
        </button>
      </div>
      <div className="inspector-vote">
        <div>
          <div className="panel-label">size</div>
          <div className="big-num num">{members.length}</div>
        </div>
        <div>
          <div className="panel-label">avg intensity</div>
          <div className="big-num num">{Math.round(avgIntensity)}</div>
        </div>
      </div>
      <div className="inspector-body">
        {educationMix.length > 0 && (
          <>
            <div className="panel-label">education mix</div>
            <table className="syn-table">
              <tbody>
                {educationMix.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="num">{v}</td>
                    <td className="muted num">
                      {Math.round((v / Math.max(1, members.length)) * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {members.length > 0 && (
          <>
            <div className="panel-label">sample reactions</div>
            <div className="society-members">
              {members.slice(0, 8).map((m) => (
                <div key={m.agent.id} className="society-member-card">
                  <div className="society-member-meta">
                    <span className="muted small">
                      {m.agent.region} · {m.agent.education}
                    </span>
                    <span className="num small">{Math.round(m.intensity)}</span>
                  </div>
                  <ReactionLine reaction={m.reaction} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function SentimentBar({
  mix,
  total,
}: {
  mix: Record<Sentiment, number>;
  total: number;
}) {
  const SENTIMENT_COLORS = sentimentColors(colorsForTheme(useTheme().resolved));
  return (
    <div>
      <div className="stack-bar">
        {SENTIMENT_ORDER.map((s) => {
          const v = mix[s] ?? 0;
          const pct = total > 0 ? (v / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={s}
              className="stack-seg"
              style={{ width: `${pct}%`, background: SENTIMENT_COLORS[s] }}
              title={`${s}: ${v}`}
            />
          );
        })}
      </div>
      <div className="syn-legend muted small" style={{ marginTop: 6 }}>
        {SENTIMENT_ORDER.filter((s) => (mix[s] ?? 0) > 0).map((s) => (
          <span key={s}>
            <i style={{ background: SENTIMENT_COLORS[s] }} /> {s} {mix[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function ReactionLine({ reaction }: { reaction: string }) {
  const { text, full } = clipReaction(reaction);
  // Tooltip only attaches when the reaction was actually truncated.
  // The aria-label still announces the full text for screen readers.
  return (
    <div
      className="society-member-reaction small"
      aria-label={full ?? text}
      data-tooltip={full ?? undefined}
    >
      {text}
    </div>
  );
}
