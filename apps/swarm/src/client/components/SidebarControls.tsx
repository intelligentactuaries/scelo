import type { ProvidersInfo } from '../../shared/types';
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

// The sidebar's on/off roster of providers. App renders it twice — the
// accordion and the collapsed-rail flyout — which were two hand-copied
// blocks until claude code arrived and would have had to be added to both.
const KEYED = ['anthropic', 'openai', 'gemini', 'hf'] as const;

export function ProviderList({ info }: { info: ProvidersInfo | null }) {
  const row = (label: string, on: boolean) => (
    <div key={label} className="provider-row">
      <span>{label}</span>
      <span className={on ? 'status-ok' : 'muted'}>{on ? 'on' : 'off'}</span>
    </div>
  );
  return (
    <div className="provider-list">
      {KEYED.map((p) => row(p, !!info?.configured[p]))}
      {row('claude code', !!info?.configured.claude_code)}
      {row('ollama', !!info?.ollamaSelected)}
    </div>
  );
}
