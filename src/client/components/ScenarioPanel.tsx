import { forwardRef } from 'react';

export const SAMPLE_SCENARIO = `A South African pension fund is considering allocating 8% of its portfolio to a single emerging-markets infrastructure REIT focused on toll roads across sub-Saharan Africa. The REIT has a 14% historical IRR but only a 4-year track record, leverage of 2.1x, and 60% of its revenue is dollar-denominated against rand-denominated liabilities. The fund must hold the position for 7 years (lock-up).`;

export const SCENARIO_PRESETS: { label: string; value: string }[] = [
  {
    label: 'Pension fund · EM REIT',
    value: SAMPLE_SCENARIO,
  },
  {
    label: 'Life insurer · CSM release',
    value: `A mid-sized European life insurer is debating whether to release £80m of IFRS 17 contractual service margin to part-fund a £450m acquisition of a UK annuity book. Doing so would drop the Solvency II SCR ratio from 165% to 142% just as rates are normalising, and the board has a two-year public dividend commitment. The target book carries long-tail longevity exposure with no matching-adjustment portfolio in place.`,
  },
  {
    label: 'Sovereign fund · transition',
    value: `A North American sovereign-wealth fund is being pressured by its legislature to divest CAD 12bn from oil-sands equities within 36 months and reallocate to renewable infrastructure debt yielding ~6.5%. The current oil-sands holdings yield 9.1% and underwrite roughly half of the fund's annual transfer to general revenue, but face tail risk under the 2030 federal emissions cap and rising stranded-asset litigation.`,
  },
  {
    label: 'Rural village · Mozambique drought',
    value: `A rural village in northern Mozambique faces a severe drought and crop failure. Strong extended-family networks; declining religious participation; subsistence farming dominates.`,
  },
];

export const SUBSET_PRESETS: { label: string; value: number }[] = [
  { label: '16', value: 16 },
  { label: '32', value: 32 },
  { label: '64', value: 64 },
  { label: '128', value: 128 },
  { label: 'full 256', value: 256 },
];

type Props = {
  scenario: string;
  onScenarioChange: (s: string) => void;
  subset: number;
  onSubsetChange: (n: number) => void;
  fresh: boolean;
  onFreshChange: (b: boolean) => void;
  justifyAll: boolean;
  onJustifyAllChange: (b: boolean) => void;
  busy: boolean;
  onRun: () => void;
  canJustifyAll: boolean;
  justifyAllBusy: boolean;
  justifyAllProgress?: { done: number; total: number } | null;
  onJustifyAll: () => void;
};

export const ScenarioPanel = forwardRef<HTMLTextAreaElement, Props>(function ScenarioPanel(
  {
    scenario,
    onScenarioChange,
    subset,
    onSubsetChange,
    fresh,
    onFreshChange,
    justifyAll,
    onJustifyAllChange,
    busy,
    onRun,
    canJustifyAll,
    justifyAllBusy,
    justifyAllProgress,
    onJustifyAll,
  },
  ref,
) {
  return (
    <section className="panel">
      <div className="panel-label">scenario</div>
      <textarea
        ref={ref}
        className="scenario-input"
        value={scenario}
        onChange={(e) => onScenarioChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!busy && scenario.trim()) onRun();
          }
        }}
        placeholder="paste a finance / investment scenario..."
        rows={8}
      />
      <div className="subset-row">
        <span className="panel-label">subset</span>
        <div className="subset-pills">
          {SUBSET_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`pill ${subset === p.value ? 'active' : ''}`}
              onClick={() => onSubsetChange(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={fresh} onChange={(e) => onFreshChange(e.target.checked)} />
        <span>bypass cache (re-run fresh)</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={justifyAll}
          onChange={(e) => onJustifyAllChange(e.target.checked)}
        />
        <span>
          justify all council agents{' '}
          <span className="status-warn small">+{subset} llm calls — slow / costly</span>
        </span>
      </label>
      <button className="primary-btn" disabled={busy || !scenario.trim()} onClick={onRun}>
        {busy ? 'running…' : 'run swarm ⌘↵'}
      </button>
      {canJustifyAll && (
        <button
          className="ghost-btn justify-all-btn"
          disabled={justifyAllBusy}
          onClick={onJustifyAll}
        >
          {justifyAllBusy
            ? justifyAllProgress
              ? `justifying… ${justifyAllProgress.done}/${justifyAllProgress.total}`
              : 'justifying…'
            : 'justify all council agents'}
        </button>
      )}
    </section>
  );
});
