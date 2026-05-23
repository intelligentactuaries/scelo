export type TabId = 'forecast' | 'council' | 'society' | 'synthesis' | 'canon';

const TABS: { id: TabId; label: string }[] = [
  // Forecast is the headline artifact — every other tab is a perspective
  // on the WMTR trajectory. Council/society/synthesis are how the swarm
  // reacts to it.
  { id: 'forecast', label: 'forecast' },
  { id: 'council', label: 'council reactions' },
  { id: 'society', label: 'society pulse' },
  { id: 'synthesis', label: 'readback' },
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
