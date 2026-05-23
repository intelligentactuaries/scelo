import { SUBSET_PRESETS } from './ScenarioPanel';

type SubsetProps = {
  subset: number;
  onSubsetChange: (n: number) => void;
};

export function SubsetSelector({ subset, onSubsetChange }: SubsetProps) {
  return (
    <div className="subset-row sidebar-subset">
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
  );
}

type RunControlsProps = {
  fresh: boolean;
  onFreshChange: (b: boolean) => void;
  justifyAll: boolean;
  onJustifyAllChange: (b: boolean) => void;
  subset: number;
  canJustifyAll: boolean;
  justifyAllBusy: boolean;
  justifyAllProgress?: { done: number; total: number } | null;
  onJustifyAll: () => void;
};

export function RunControls({
  fresh,
  onFreshChange,
  justifyAll,
  onJustifyAllChange,
  subset,
  canJustifyAll,
  justifyAllBusy,
  justifyAllProgress,
  onJustifyAll,
}: RunControlsProps) {
  return (
    <div className="sidebar-run-controls">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={fresh}
          onChange={(e) => onFreshChange(e.target.checked)}
        />
        <span>Bypass cache (re-run fresh)</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={justifyAll}
          onChange={(e) => onJustifyAllChange(e.target.checked)}
        />
        <span>
          Justify all council agents{' '}
          <span className="status-warn small">+{subset} LLM calls</span>
        </span>
      </label>
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
    </div>
  );
}
