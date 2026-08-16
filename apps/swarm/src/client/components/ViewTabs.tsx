export type TabId =
  | 'forecast'
  | 'council'
  | 'society'
  | 'synthesis'
  | 'simulation'
  | 'canon';

const TABS: { id: TabId; label: string }[] = [
  // Forecast is the headline artifact — every other tab is a perspective
  // on the WMTR trajectory. Council/society/synthesis are how the swarm
  // reacts to it. Simulation is the new sibling: an SA-anchored
  // population simulator that produces both macro impact + a dataset
  // ready to flow into Scelo's Soft Data.
  { id: 'forecast', label: 'forecast' },
  { id: 'council', label: 'council reactions' },
  { id: 'society', label: 'society pulse' },
  { id: 'synthesis', label: 'readback' },
  { id: 'simulation', label: 'simulation' },
  { id: 'canon', label: 'iaai canon' },
];

type Props = {
  active: TabId;
  onChange: (t: TabId) => void;
};

export function ViewTabs({ active, onChange }: Props) {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={`tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
