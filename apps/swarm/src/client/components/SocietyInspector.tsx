import { useMemo } from 'react';
import type { Run, Sentiment } from '../../shared/types';
import { colorsForTheme } from '../../shared/constants';
import { useTheme } from '../lib/theme';
import { SENTIMENT_ORDER, sentimentColors } from '../lib/societyPalette';
import type { SocietyPin } from './SocietyGraph';
import { HalfDonut } from './HalfDonut';

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
  /** Open the audit interview drawer on one citizen (complete runs only). */
  onInterview?: (agentId: string) => void;
};

// Decision-sidebar content for the Society tab. Renders one of two shapes
// depending on what the user pinned in the legend:
//   - cluster  → c0..c5 demographic + sentiment-mix
//   - sentiment → "supportive" / "skeptical" / etc. group profile
export function SocietyInspector({ run, pin, onClose, onInterview }: Props) {
  if (pin.kind === 'cluster') {
    return <ClusterInspector run={run} clusterName={pin.name} onClose={onClose} onInterview={onInterview} />;
  }
  return <SentimentInspector run={run} sentiment={pin.name} onClose={onClose} />;
}

function ClusterInspector({
  run,
  clusterName,
  onClose,
  onInterview,
}: {
  run: Run;
  clusterName: string;
  onClose: () => void;
  onInterview?: (agentId: string) => void;
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
          {/* Short id only. The pin's name arrives as the legend chip's
              label — "c3 age≈40 · low · tertiary · rural · e…" — so echoing
              it here printed a TRUNCATED descriptor one line above the body
              rendering the same descriptor in full. The id is the title;
              the description below carries the whole text. */}
          <div className="agent-id">Cluster c{idx}</div>
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
        {summary && <SentimentBar mix={summary.sentimentMix} />}
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
                    {onInterview && (
                      <button
                        type="button"
                        className="ghost-btn society-member-interview"
                        onClick={() => onInterview(m.agent.id)}
                        title={`Interview ${m.agent.id} about this reaction — replies are checked against the recorded sentiment`}
                      >
                        interview
                      </button>
                    )}
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

function SentimentBar({ mix }: { mix: Record<Sentiment, number> }) {
  const SENTIMENT_COLORS = sentimentColors(colorsForTheme(useTheme().resolved));
  return (
    <HalfDonut
      name="sentiment"
      data={SENTIMENT_ORDER.map((s) => ({
        name: s,
        value: mix[s] ?? 0,
        color: SENTIMENT_COLORS[s],
      }))}
    />
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
