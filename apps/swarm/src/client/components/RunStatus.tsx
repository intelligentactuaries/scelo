import type { Run } from '../../shared/types';

// Local mirrors of App's progress shapes (kept structural to avoid a circular
// import — App owns the source of truth).
type RoundProgress = { round: 1 | 2 | 3; done: number; total: number; elapsedMs?: number; finished: boolean };
type SocietyProgress = { done: number; total: number; finished: boolean; elapsedMs?: number };

type Props = {
  phase: 'council' | 'society';
  run: Run | null;
  busy: boolean;
  error: string | null;
  /** Seconds since the last stream event while busy (null when idle). */
  stalledSec: number | null;
  progress: RoundProgress[];
  society: SocietyProgress | null;
  societySize?: number;
  onRetry: () => void;
};

// How long a busy run can go with ZERO stream activity before we flag it as
// stuck. A local 3B model answers each agent in ~10–60s, so 90s of total
// silence means the model / provider has almost certainly hung.
export const STALL_SEC = 90;

/**
 * On-canvas status for the Council Reactions / Society Pulse graphs.
 * Answers the only question the empty graph can't: is it running, or broken?
 */
export function RunStatus({
  phase,
  run,
  busy,
  error,
  stalledSec,
  progress,
  society,
  societySize,
  onRetry,
}: Props) {
  const hasResults =
    phase === 'council'
      ? !!run && run.councilResults.length > 0
      : !!run && run.societyResults.length > 0;
  const stalled = busy && stalledSec != null && stalledSec >= STALL_SEC;

  // Results are already drawn → stay out of the way: only surface the states
  // that need attention, as a small top chip (running is shown by rerun-badge).
  if (hasResults) {
    if (error) return <Chip kind="error" text={`run error — ${short(error)}`} onRetry={onRetry} retry="retry" />;
    if (stalled)
      return (
        <Chip
          kind="stalled"
          text={`no response for ${Math.round(stalledSec as number)}s — the run may be stuck`}
          onRetry={onRetry}
          retry="restart"
        />
      );
    return null;
  }

  // Empty graph → full, centred status so it's never ambiguous.
  if (phase === 'society' && societySize === 0 && !busy) {
    return (
      <Card
        kind="idle"
        title="society skipped"
        detail="society size is 0 for this run — raise it in the sidebar, then re-run to poll citizens."
      />
    );
  }
  if (error) {
    return <Card kind="error" title="the swarm run failed" detail={error} onRetry={onRetry} retry="retry run" />;
  }
  if (stalled) {
    return (
      <Card
        kind="stalled"
        title="the run looks stuck"
        detail={`no agent has responded for ${Math.round(stalledSec as number)}s — the model or provider may have hung. ${detailFor(phase, progress, society)}.`}
        onRetry={onRetry}
        retry="restart run"
      />
    );
  }
  if (busy) {
    return (
      <Card
        kind="running"
        title={phase === 'society' ? 'the society is reacting…' : 'the council is deliberating…'}
        detail={`${detailFor(phase, progress, society)}.`}
        sub={stalledSec != null && stalledSec > 25 ? `last response ${Math.round(stalledSec)}s ago` : undefined}
      />
    );
  }
  if (run && !hasResults) {
    return (
      <Card
        kind="broken"
        title={`no ${phase} results`}
        detail={`the last run finished without producing any ${phase} output — it likely errored on the server. run it again.`}
        onRetry={onRetry}
        retry="run again"
      />
    );
  }
  return null;
}

function detailFor(phase: 'council' | 'society', progress: RoundProgress[], society: SocietyProgress | null): string {
  if (phase === 'society') {
    if (society && !society.finished) return `polling ${society.done} of ${society.total} citizens`;
    if (society && society.finished) return 'society polling complete — rendering the graph';
    return 'the society reacts once the council finishes deliberating';
  }
  const cur = progress[progress.length - 1];
  if (cur) return `round ${cur.round} of 3 · ${cur.done} of ${cur.total} agents responded`;
  return 'assembling the council';
}

function short(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 79) + '…' : one;
}

type Kind = 'running' | 'stalled' | 'error' | 'broken' | 'idle';

function Card({
  kind,
  title,
  detail,
  sub,
  onRetry,
  retry,
}: {
  kind: Kind;
  title: string;
  detail: string;
  sub?: string;
  onRetry?: () => void;
  retry?: string;
}) {
  return (
    <div
      className={`run-status is-${kind}`}
      role={kind === 'error' || kind === 'broken' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="run-status-emblem" aria-hidden="true">
        {kind === 'running' ? (
          <span className="run-status-orbit">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="run-status-glyph">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>
      <div className="run-status-title">{title}</div>
      <div className="run-status-detail">{detail}</div>
      {sub && <div className="run-status-sub">{sub}</div>}
      {onRetry && (
        <button type="button" className="run-status-retry" onClick={onRetry}>
          {retry ?? 'retry'}
        </button>
      )}
    </div>
  );
}

function Chip({
  kind,
  text,
  onRetry,
  retry,
}: {
  kind: 'error' | 'stalled';
  text: string;
  onRetry: () => void;
  retry: string;
}) {
  return (
    <div className={`run-status-chip is-${kind}`} role="status" aria-live="polite">
      <span className="run-status-chip-dot" aria-hidden="true" />
      <span className="run-status-chip-text">{text}</span>
      <button type="button" className="run-status-chip-btn" onClick={onRetry}>
        {retry}
      </button>
    </div>
  );
}
