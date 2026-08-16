import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { SCENARIO_PRESETS } from './ScenarioPanel';

type Props = {
  scenario: string;
  onScenarioChange: (s: string) => void;
  busy: boolean;
  onRun: () => void;
  /** Becomes true once a run exists. Switches the card from the centered
   *  "type scenario + Run Swarm" layout to the bottom-pinned compact
   *  refine pill. Chat moved to the right-side ConversationPanel. */
  dropped: boolean;
  /** Called when user submits in refine mode: replaces scenario + re-runs. */
  onRefine: (newScenario: string) => void;
};

export const ScenarioCard = forwardRef<HTMLTextAreaElement, Props>(function ScenarioCard(
  { scenario, onScenarioChange, busy, onRun, dropped, onRefine },
  ref,
) {
  // Local ref drives the auto-grow effect; we forward to the parent ref
  // so external focus calls still work.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    },
    [ref],
  );

  // Auto-grow the scenario textarea until the CSS max-height kicks in,
  // after which overflow-y: auto takes over and scrolls. Reset to 'auto'
  // first so shrinking past the previous height also works.
  // Applies in the dropped layout too. It was skipped there on the assumption
  // that refining meant typing a short line into an empty row — but the row is
  // now opened prefilled with the whole scenario, and at rows={1} that showed
  // a line and a half with the rest cut off. CSS max-height still caps it.
  useLayoutEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [scenario, dropped]);

  // Re-measure on window resize since wrapping may change.
  useEffect(() => {
    const onResize = () => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [dropped]);

  // ─── empty (centered) layout — Run Swarm only ─────────────────────────
  if (!dropped) {
    const canRun = !busy && scenario.trim().length > 0;
    return (
      <>
        <div className="scenario-card">
          <textarea
            ref={setRef}
            className="scenario-card-input"
            value={scenario}
            onChange={(e) => onScenarioChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (canRun) onRun();
              }
            }}
            placeholder="Describe a community or scenario — we'll forecast its trajectory and convene the council to test it…"
            rows={3}
          />
          <div className="scenario-card-actions">
            <span className="muted small">⌘↵ to forecast</span>
            <button className="primary-btn pill-btn" disabled={!canRun} onClick={onRun}>
              {busy ? 'Forecasting…' : 'Forecast & convene'}
            </button>
          </div>
        </div>
        <div className="scenario-presets" role="list" aria-label="example scenarios">
          {SCENARIO_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              role="listitem"
              className="scenario-preset-chip"
              disabled={busy}
              onClick={() => onScenarioChange(p.value)}
              title={p.value}
            >
              {p.label}
            </button>
          ))}
        </div>
      </>
    );
  }

  // ─── dropped (post-run, bottom-pinned) layout — refine only ───────────
  const submit = () => {
    const next = scenario.trim();
    if (next && !busy) onRefine(next);
  };

  return (
    <div className="scenario-card scenario-card--dropped">
      <div className="scenario-card-row">
        <span className="bottom-bar-mode-label panel-label">refine</span>
        <textarea
          // setRef, not the bare forwarded ref: the auto-grow effect measures
          // through inputRef, which only the local setter populates. Wiring
          // the parent ref straight through left this row stuck at one line
          // with a prefilled scenario cut off mid-sentence.
          ref={setRef}
          className="scenario-card-row-input"
          placeholder="type a refined scenario, press ⌘↵ to re-run…"
          value={scenario}
          onChange={(e) => onScenarioChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
        />
        <button
          className="primary-btn pill-btn"
          onClick={submit}
          disabled={busy || !scenario.trim()}
        >
          {busy ? 'forecasting…' : 're-forecast'}
        </button>
      </div>
    </div>
  );
});
